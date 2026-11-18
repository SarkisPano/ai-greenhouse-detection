# Contexto Maestro del Proyecto — Detección Inteligente de Invernaderos (`SUPER+`)

> **Última actualización:** Noviembre 2026  
> **Propósito:** Documento de referencia rápida para compartir entre chats y mantener continuidad técnica, comercial y de infraestructura sin perder contexto.

---

## 1. Reglas Críticas y Estilo
- **Prohibición de marca:** Está **TERMINANTEMENTE PROHIBIDO** usar o mencionar la palabra `"Agrotech"` en el código, UI, documentos o respuestas. La marca visible es **`SUPER+` — Detección Inteligente de Invernaderos**.
- **Idioma y tono:** Español argentino ("che/vos"), claro, directo y práctico.
- **No exponer credenciales en código fuente:** Las claves privadas (`SUPABASE_SERVICE_KEY`, `SMTP_PASS`, tokens de acceso, contraseñas SSH) viven exclusivamente en `.env` del servidor / GitHub Secrets / Vercel y nunca deben commitearse al repositorio.
- **Metodología de trabajo:** Discutir y consensuar los cambios con el usuario antes de programar o ejecutar.

---

## 2. Arquitectura e Infraestructura Actual

| Componente | Tecnología / Servicio | Ubicación / Detalle |
| :--- | :--- | :--- |
| **Repositorio** | GitHub | `SarkisPano/ai-greenhouse-detection` (rama `main`) |
| **Frontend** | React + Vite + TypeScript + Mapbox GL JS | `frontend/` — Auto-deploy en **Vercel** (`https://ai-greenhouse-detection.vercel.app`) |
| **Backend API** | FastAPI + Uvicorn (Docker) | `ai-engine/main.py` — VPS `192.255.228.35` (`127.0.0.1:5000` detrás de Caddy HTTPS, webhook + watcher Supabase) |
| **Cola y Worker** | Redis 7 + Celery Worker (Docker) | `ai-engine/tasks.py` — Procesamiento asíncrono por tandas (`BATCH_SIZE = 8`, `time_limit=1800`, `soft_time_limit=1500`) |
| **Modelo IA** | Roboflow YOLOv11 (`deteccion-de-invernaderos`, v6) | Inferencia en CPU (`inference==0.26.1`, `CPUExecutionProvider`) sobre teselas Mapbox HD (`2000×2000 px` @2x) con caché persistente (`model_cache:/tmp/cache`) |
| **Base de Datos** | Supabase Cloud (PostgreSQL + PostGIS) | Proyecto `lldcmcegcxkqaxvibckk` (`https://lldcmcegcxkqaxvibckk.supabase.co`) |
| **Notificaciones Email** | Gmail SMTP (`notifications.retails@gmail.com`) | Inyectado en el VPS desde GitHub Secret `SMTP_PASS` vía `.github/workflows/deploy-ai-engine.yml` |
| **CI/CD** | GitHub Actions | `.github/workflows/` (deploy automático a Vercel y VPS) |

### Especificaciones del VPS (`192.255.228.35`)
- **Recursos:** ~961 MiB RAM + 3.0 GB Swap, CPU (sin GPU).
- **Contenedores (`ai-engine/docker-compose.yml`):** `ai-engine-api-1` (`127.0.0.1:5000:5000`), `ai-engine-worker-1` (con volumen `model_cache`), `ai-engine-redis-1` (solo red interna Docker, sin puerto `6379` expuesto al exterior), todos con `restart: unless-stopped`.
- **Dependencias críticas fijadas (`ai-engine/requirements.txt`):** `celery==5.3.6`, `kombu==5.3.7`, `redis==5.0.3`, `inference==0.26.1`, `Pillow==10.4.0`.

### Tablas en Supabase (`public`)
- `zones`: polígonos de zonas guardadas y catálogo base de pueblos (`[PUEBLO] <Nombre>`, `[Pueblo: <Nombre>] <Zona>`), `area_ha`, `plastic_percent`, `geom`.
- `ai_scans`: estado (`pending`, `processing`, `completed`, `failed`, `cancelled`), progreso, conteo, área total y `result_geojson` (almacena detecciones, `town_name`, `custom_labels`, `notify_email`, `new_count`, `compared_with_previous`).
- `ai_detections`: polígonos individuales detectados.
- **Seguridad (RLS + Auth):**
  - Autenticación obligatoria con **Supabase Auth** (Email + Contraseña, registro público deshabilitado).
  - RLS habilitado en las 3 tablas restringido exclusivamente a `FOR ALL TO authenticated USING (true) WITH CHECK (true)` (sin acceso para `anon`).

---

## 3. Funcionalidades Implementadas

### Seguridad y Control de Acceso
- **Login obligatorio (`App.tsx`, `Sidebar.tsx`):** Pantalla de inicio de sesión con Supabase Auth y botón de cerrar sesión.
- **Validación JWT en Backend (`ai-engine/main.py`):** Endpoints `POST /webhook/scans` y `POST /scans/{scan_id}/notify-email` validan el `Bearer` JWT contra Supabase (con caché de 120s en Redis).
- **Hardening del VPS:** Redis cerrado al exterior, FastAPI en `127.0.0.1:5000`, `/docs`/`/redoc`/`/dataset_images` deshabilitados, validación estricta de UUIDs y emails, *Rate Limit* por IP/scan en Redis, escape HTML (`escapeHtml` / `html.escape`) contra XSS y confirmación antes de eliminar zonas o pueblos.
- **Token Mapbox restringido:** `VITE_MAPBOX_TOKEN` en Vercel restringido por URL a `https://ai-greenhouse-detection.vercel.app/*` y `http://localhost:5173/*` (el VPS mantiene su token propio en `.env`).

### Mapa y Flujo de Usuario (Desktop y Mobile)
- **Vista inicial:** Centrada en **Ereván, Armenia** (`[44.5136, 40.1811]`), zoom `12.5` (mobile) / `13` (desktop), estilo `mapbox://styles/mapbox/satellite-streets-v12`.
- **Branding:** Logo `SUPER+` blanco con fondo transparente centrado en `Sidebar.tsx` y pantalla de login; favicon personalizado (`favicon.png`, `favicon.ico`, `apple-touch-icon.png`).
- **Base de Pueblos y Métricas (`Sidebar.tsx`, `App.tsx`):**
  - Pestaña `🏘️ Pueblos` para dar de alta localidades de Armenia y consultar métricas consolidadas (escaneos, invernaderos totales y nuevos, superficie cubierta y lona estimada en `m²` y `ha`).
  - Al seleccionar un pueblo, carga automáticamente su última zona delimitada y los invernaderos previos ya marcados, listos para re-escanear.
- **Texto movible en el mapa (`Map.tsx`):** Las anotaciones creadas con `draw_text` se pueden arrastrar libremente (`drag & drop` en mouse y touch), editar, borrar y se persisten en `custom_labels`.
- **Soporte Mobile (`useIsMobile.ts`):**
  - Sidebar colapsado por defecto en celular; se abre a pantalla completa con botón `✕`.
  - **Trazar con el dedo** (`isSwipeDrawing`), **Encuadrar Vista (1-tap)** y zoom/paneo seguro post-escaneo.

### Motor de Detección, Re-escaneo y Reportes
- **Escaneo de pueblos enteros por tandas:** Límite ampliado a **1.500 ha** en frontend y **650 cuadrículas satelitales** en backend (`ai-engine/tasks.py`). Procesa de a **8 teselas por lote**, libera imágenes de RAM (`gc.collect()`), guarda progreso y detecciones parciales en vivo, y refresca `scan_heartbeat:{scan_id}` en Redis para que el Watcher recupere automáticamente escaneos zombies tras un reinicio.
- **Detección diferencial al re-escanear:** Compara contra `previous_features` (IoU / contención), marca los invernaderos nuevos (`isNew: true`, color celeste `#00E5FF` y etiqueta `★ NUEVO`), conserva los manuales previos y permite filtrar `Ver Todos` vs `Solo Nuevos`.
- **Post-procesamiento optimizado:** pre-filtros por bounding box (`_bboxes_overlap`), área geodésica real (`shapely`), filtro de bordes y NMS inter-teselas (`networkx`).
- **Cálculo en `m²` y `ha` + Exportación Excel:** Superficie cubierta y lona estimada mostradas en **`m²` y `ha`** en panel, popups, barra mobile y reporte **Excel (`.xlsx`)** (con columna `"Estado"` y pueblo asociado).
- **Notificación por correo y reanudación:** Campo de email en panel izquierdo (y en el modal de escaneo solo si no se cargó previamente), persistencia en `localStorage` (`super_active_scan`) y envío automático de resumen HTML al finalizar vía `notifications.retails@gmail.com`.

---

## 4. Historial de Problemas Resueltos (Referencia Rápida)
1. **Escaneo trabado en 5% por OOM (zona de ~3.091 ha):** Se agregó swap (3 GB), política `restart: unless-stopped` y luego procesamiento por lotes (`BATCH_SIZE = 8`) con liberación explícita de memoria hasta 1.500 ha / 650 cuadrículas.
2. **Escaneo trabado en 5% por `VersionMismatch` de Kombu:** Se fijó `kombu==5.3.7` en `ai-engine/requirements.txt` (commit `512b865`).
3. **Desaparición de invernaderos al hacer zoom en mobile:** Corregido deseleccionando el polígono y protegiendo `handleZoneUpdate` (commit `8019410`).
4. **Hardening de acceso y seguridad (Noviembre 2026):** Cierre de puerto `6379` de Redis, restricción de `:5000` a `127.0.0.1`, Login con Supabase Auth, RLS solo `authenticated`, JWT en FastAPI, rate-limit, recuperación de zombies y Mapbox restringido por URL (commits `bc57d8a`, `2935622`, `560c022`).
5. **Notificaciones por mail en producción (Noviembre 2026):** Envío HTML vía Gmail SMTP (`notifications.retails@gmail.com`) con `SMTP_PASS` inyectado desde GitHub Secrets (commit `e7b072c`).

---

## 5. Roadmap / Mejoras Opcionales Futuras
- **Upgrade de VPS (cuando escale el uso diario de pueblos enteros):** Migrar de ~1 GB RAM a 2 vCPU / 4 GB RAM (ej. Hetzner CX23) para acelerar la inferencia en pueblos grandes sin depender del swap.
- **Refresco automático al volver a la pestaña (`visibilitychange`):** Forzar chequeo inmediato de `ai_scans` si el navegador pausó el polling mientras la pestaña estuvo en segundo plano.
