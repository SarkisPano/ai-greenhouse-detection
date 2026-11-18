from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
import os
import re
import threading
import time
import uuid
import redis as redis_lib
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY, REDIS_URL
from supabase import create_client
from tasks import process_ai_scan

app = FastAPI(title="AI Greenhouse Engine API", docs_url=None, redoc_url=None, openapi_url=None)

# Cliente Supabase singleton y Redis
supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
redis_client = redis_lib.from_url(REDIS_URL, decode_responses=True)

# Registro en memoria de escaneos encolados para no duplicar tareas
enqueued_scans = set()

EMAIL_REGEX = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class NotifyEmailRequest(BaseModel):
    email: str


def _is_valid_uuid(val: str) -> bool:
    if not val or not isinstance(val, str):
        return False
    try:
        uuid.UUID(val.strip())
        return True
    except ValueError:
        return False


def _is_valid_email(val: str) -> bool:
    if not val or not isinstance(val, str):
        return False
    clean = val.strip()
    if len(clean) > 254:
        return False
    return bool(EMAIL_REGEX.match(clean))


def _check_rate_limit(key: str, limit: int, window_sec: int) -> bool:
    """Devuelve True si la petición está dentro del límite permitido."""
    try:
        current = redis_client.incr(key)
        if current == 1:
            redis_client.expire(key, window_sec)
        return current <= limit
    except Exception as e:
        print(f"[RateLimit] Error consultando Redis ({key}): {e}")
        return True


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Nota: Los encabezados CORS los inyecta Caddy a nivel de proxy inverso.
# No agregamos CORSMiddleware aquí para evitar duplicar el encabezado 'Access-Control-Allow-Origin: *, *'.


def enqueue_scan_job(scan_id: str, zone_id: str) -> bool:
    """
    Función centralizada para despachar el escaneo hacia Celery.
    Garantiza idempotencia (no despachar dos veces el mismo scan).
    """
    if not _is_valid_uuid(scan_id) or not _is_valid_uuid(zone_id):
        print(f"[Dispatcher] UUID inválido rechazado: scan={scan_id}, zone={zone_id}")
        return False

    if scan_id in enqueued_scans:
        return True

    try:
        zone_data = supabase_client.table('zones').select('*').eq('id', zone_id).execute()
        if not zone_data.data:
            print(f"[Dispatcher] Zona {zone_id} no encontrada en Supabase.")
            return False

        zone = zone_data.data[0]
        area_ha = zone.get('area_ha', 0)
        geom = zone.get('geom', {})

        # Resguardar notify_email en Redis antes de que el worker sobreescriba el progreso parcial
        try:
            scan_data = supabase_client.table('ai_scans').select('result_geojson').eq('id', scan_id).execute()
            if scan_data.data:
                res_json = scan_data.data[0].get('result_geojson')
                if isinstance(res_json, dict) and res_json.get('notify_email'):
                    candidate_email = str(res_json.get('notify_email')).strip()
                    if _is_valid_email(candidate_email):
                        redis_client.set(
                            f"scan_notify_email:{scan_id}",
                            candidate_email,
                            ex=86400,
                        )
        except Exception as meta_err:
            print(f"[Dispatcher] No se pudo leer metadata inicial de {scan_id}: {meta_err}")

        # Heartbeat inicial (4 minutos) para detectar tareas zombies si el worker muere
        try:
            redis_client.set(f"scan_heartbeat:{scan_id}", str(int(time.time())), ex=240)
        except Exception as hb_err:
            print(f"[Dispatcher] No se pudo registrar heartbeat inicial para {scan_id}: {hb_err}")

        enqueued_scans.add(scan_id)
        print(f"[Dispatcher] Encolando tarea Celery para scan {scan_id} (Zona {zone_id})...")
        process_ai_scan.delay(scan_id, zone_id, geom, area_ha)
        return True
    except Exception as e:
        print(f"[Dispatcher] Error al encolar scan {scan_id}: {e}")
        return False


@app.post("/scans/{scan_id}/notify-email")
def set_scan_notify_email(scan_id: str, body: NotifyEmailRequest, request: Request):
    """
    Registra o actualiza en caliente el email de notificación para un escaneo en curso.
    """
    if not _is_valid_uuid(scan_id):
        raise HTTPException(status_code=400, detail="scan_id inválido")

    if not _check_rate_limit(f"rl:notify:{scan_id}", limit=5, window_sec=60):
        raise HTTPException(status_code=429, detail="Demasiadas solicitudes. Esperá un minuto.")

    clean_email = (body.email or "").strip()
    if not _is_valid_email(clean_email):
        raise HTTPException(status_code=400, detail="Email inválido")

    try:
        redis_client.set(f"scan_notify_email:{scan_id}", clean_email, ex=86400)
        scan_row = supabase_client.table('ai_scans').select('status, result_geojson').eq('id', scan_id).execute()
        if scan_row.data:
            row = scan_row.data[0]
            if row.get('status') in ('pending', 'processing'):
                curr_res = row.get('result_geojson') if isinstance(row.get('result_geojson'), dict) else {}
                curr_res['notify_email'] = clean_email
                supabase_client.table('ai_scans').update({'result_geojson': curr_res}).eq('id', scan_id).execute()
        return {"status": "ok", "scan_id": scan_id, "email": clean_email}
    except Exception as e:
        print(f"[NotifyEmail] Error guardando email para {scan_id}: {e}")
        return {"status": "error", "reason": "No se pudo registrar el email"}


@app.post("/webhook/scans")
def handle_scan_webhook(payload: dict, request: Request):
    """
    Recibe la petición directa o webhook.
    Usa función síncrona para que FastAPI lo ejecute en threadpool sin bloquear el event loop.
    """
    client_ip = _get_client_ip(request)
    if not _check_rate_limit(f"rl:webhook:{client_ip}", limit=10, window_sec=60):
        raise HTTPException(status_code=429, detail="Demasiadas peticiones. Intentá nuevamente en unos segundos.")

    record = payload.get("record", {}) if isinstance(payload, dict) else {}
    if not record or not isinstance(record, dict):
        return {"status": "ignored", "reason": "No record found"}

    scan_id = record.get("id")
    status = record.get("status")
    zone_id = record.get("zone_id")

    if not _is_valid_uuid(str(scan_id or "")) or not _is_valid_uuid(str(zone_id or "")):
        raise HTTPException(status_code=400, detail="Identificadores inválidos")

    if status == "processing":
        success = enqueue_scan_job(str(scan_id), str(zone_id))
        if success:
            return {"status": "queued", "scan_id": scan_id}
        return {"status": "error", "reason": "Could not enqueue scan"}

    return {"status": "ignored", "reason": f"Status is {status}"}


def background_supabase_scan_watcher():
    """
    Vigilante autónomo en segundo plano:
    1) Detecta escaneos nuevos en 'processing' que no se encolaron por webhook.
    2) Detecta escaneos zombies (sin heartbeat activo en Redis tras reinicio/caída del worker)
       y los recupera automáticamente una vez o los marca como 'failed'.
    """
    time.sleep(3)
    print("[Watcher] Iniciado vigilante en segundo plano para escaneos de Supabase...")
    while True:
        try:
            pending = supabase_client.table('ai_scans') \
                .select('id, zone_id, status, result_geojson, created_at') \
                .eq('status', 'processing') \
                .limit(10) \
                .execute()

            if pending.data:
                for row in pending.data:
                    s_id = row.get('id')
                    z_id = row.get('zone_id')
                    res = row.get('result_geojson')
                    if not s_id or not z_id:
                        continue

                    has_progress = isinstance(res, dict) and bool(res.get('progress'))
                    has_heartbeat = False
                    try:
                        has_heartbeat = bool(redis_client.get(f"scan_heartbeat:{s_id}"))
                    except Exception:
                        has_heartbeat = True  # No asumir zombie si Redis falla momentáneamente

                    if not has_progress and s_id not in enqueued_scans and not has_heartbeat:
                        print(f"[Watcher] Escaneo pendiente detectado en Supabase: {s_id}. Encolando a Celery...")
                        enqueue_scan_job(s_id, z_id)
                    elif has_progress and not has_heartbeat:
                        # Escaneo quedó sin heartbeat (worker reiniciado o caído a mitad de proceso)
                        retries = 0
                        try:
                            retries = int(redis_client.get(f"scan_zombie_retries:{s_id}") or 0)
                        except Exception:
                            retries = 0

                        if retries == 0:
                            print(f"[Watcher] Escaneo zombie detectado ({s_id}). Re-encolando para recuperación...")
                            try:
                                redis_client.set(f"scan_zombie_retries:{s_id}", "1", ex=7200)
                            except Exception:
                                pass
                            enqueued_scans.discard(s_id)
                            enqueue_scan_job(s_id, z_id)
                        else:
                            print(f"[Watcher] Escaneo zombie persistente ({s_id}). Marcando como failed...")
                            try:
                                supabase_client.table('ai_scans').update({
                                    'status': 'failed',
                                    'completed_at': datetime.now(timezone.utc).isoformat()
                                }).eq('id', s_id).execute()
                                enqueued_scans.discard(s_id)
                            except Exception as fail_err:
                                print(f"[Watcher] Error marcando zombie {s_id} como failed: {fail_err}")
        except Exception as e:
            print(f"[Watcher Exception]: {e}")

        time.sleep(5)


@app.on_event("startup")
def startup_event():
    watcher_thread = threading.Thread(target=background_supabase_scan_watcher, daemon=True)
    watcher_thread.start()


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ai-engine"}
