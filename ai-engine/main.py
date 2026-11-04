from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Any
import json
import os
import threading
import time
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY
from supabase import create_client
from tasks import process_ai_scan

app = FastAPI(title="AI Greenhouse Engine API")

# Cliente Supabase singleton
supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Registro en memoria de escaneos encolados para no duplicar tareas
enqueued_scans = set()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Servir las imágenes locales descargadas para previsualización
if os.path.exists("dataset_images"):
    app.mount("/dataset_images", StaticFiles(directory="dataset_images"), name="dataset_images")

if os.path.exists("public"):
    app.mount("/public", StaticFiles(directory="public"), name="public")

@app.get("/dataset/list")
def list_dataset_images():
    if not os.path.exists("dataset_images"):
        return {"images": []}
    files = [f for f in os.listdir("dataset_images") if f.endswith(".jpg") or f.endswith(".png")]
    return {"images": [f"/dataset_images/{f}" for f in files]}


def enqueue_scan_job(scan_id: str, zone_id: str) -> bool:
    """
    Función centralizada para despachar el escaneo hacia Celery.
    Garantiza idempotencia (no despachar dos veces el mismo scan).
    """
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

        enqueued_scans.add(scan_id)
        print(f"[Dispatcher] Encolando tarea Celery para scan {scan_id} (Zona {zone_id})...")
        process_ai_scan.delay(scan_id, zone_id, geom, area_ha)
        return True
    except Exception as e:
        print(f"[Dispatcher] Error al encolar scan {scan_id}: {e}")
        return False


@app.post("/webhook/scans")
def handle_scan_webhook(payload: dict):
    """
    Recibe la petición directa o webhook.
    Usa función síncrona para que FastAPI lo ejecute en threadpool sin bloquear el event loop.
    """
    print("[Webhook] Petición recibida:", payload)
    record = payload.get("record", {})
    if not record:
        return {"status": "ignored", "reason": "No record found"}

    scan_id = record.get("id")
    status = record.get("status")
    zone_id = record.get("zone_id")

    if status == "processing" and scan_id and zone_id:
        success = enqueue_scan_job(scan_id, zone_id)
        if success:
            return {"status": "queued", "scan_id": scan_id}
        return {"status": "error", "reason": "Could not enqueue scan"}

    return {"status": "ignored", "reason": f"Status is {status}"}


def background_supabase_scan_watcher():
    """
    Vigilante autónomo en segundo plano:
    Consulta Supabase periódicamente para detectar si hay escaneos en estado 'processing'
    que no hayan sido tomados aún.
    BLINDAJE TOTAL: Aunque la petición HTTP directa del cliente falle por red,
    el backend toma la tarea desde la base de datos automáticamente.
    """
    time.sleep(3)
    print("[Watcher] Iniciado vigilante en segundo plano para escaneos de Supabase...")
    while True:
        try:
            pending = supabase_client.table('ai_scans') \
                .select('id, zone_id, status, result_geojson') \
                .eq('status', 'processing') \
                .order('created_at', desc=True) \
                .limit(5) \
                .execute()

            if pending.data:
                for row in pending.data:
                    s_id = row.get('id')
                    z_id = row.get('zone_id')
                    res = row.get('result_geojson')

                    # Si no fue despachado aún y no tiene progreso avanzado
                    if s_id and z_id and s_id not in enqueued_scans:
                        if not res or not res.get('progress'):
                            print(f"[Watcher] Escaneo pendiente detectado en Supabase: {s_id}. Encolando a Celery...")
                            enqueue_scan_job(s_id, z_id)
        except Exception as e:
            # Mantener el watcher siempre activo sin caerse
            pass

        time.sleep(3)


@app.on_event("startup")
def startup_event():
    watcher_thread = threading.Thread(target=background_supabase_scan_watcher, daemon=True)
    watcher_thread.start()


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ai-engine"}
