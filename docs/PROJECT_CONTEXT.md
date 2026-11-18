# Contexto Maestro del Proyecto — Detección Inteligente de Invernaderos (`SUPER+`)

> **Última actualización:** Noviembre 2026  
> **Propósito:** Documento de referencia rápida para compartir entre chats y mantener continuidad técnica, comercial y de infraestructura sin perder contexto.

---

## 1. Reglas Críticas y Estilo
- **Prohibición de marca:** Está **TERMINANTEMENTE PROHIBIDO** usar o mencionar la palabra `"Agrotech"` en el código, UI, documentos o respuestas. La marca visible es **`SUPER+` — Detección Inteligente de Invernaderos**.
- **Idioma y tono:** Español argentino ("che/vos"), claro, directo y práctico.
- **No exponer credenciales en código fuente:** Las claves privadas (`SUPABASE_SERVICE_KEY`, tokens de acceso, contraseñas SSH) viven exclusivamente en `.env` del servidor/Vercel y nunca deben commitearse al repositorio.

---

## 2. Arquitectura e Infraestructura Actual

| Componente | Tecnología / Servicio | Ubicación / Detalle |
| :--- | :--- | :--- |
| **Repositorio** | GitHub | `SarkisPano/ai-greenhouse-detection` (rama `main`) |
| **Frontend** | React + Vite + TypeScript + Mapbox GL JS | `frontend/` — Auto-deploy en **Vercel** (`https://ai-greenhouse-detection.vercel.app`) |
| **Backend API** | FastAPI + Uvicorn (Docker) | `ai-engine/main.py` — VPS `192.255.228.35:5000` (webhook + watcher Supabase) |
| **Cola y Worker** | Redis 7 + Celery Worker (Docker) | `ai-engine/tasks.py` — Procesamiento asíncrono de escaneos |
| **Modelo IA** | Roboflow YOLOv11 (`deteccion-de-invernaderos`, v6) | Inferencia en CPU (`inference==0.26.1`, `CPUExecutionProvider`) sobre teselas Mapbox HD (`2000×2000 px` @2x) |
| **Base de Datos** | Supabase Cloud (PostgreSQL + PostGIS) | Proyecto `lldcmcegcxkqaxvibckk` (`https://lldcmcegcxkqaxvibckk.supabase.co`) |
| **CI/CD** | GitHub Actions | `.github/workflows/` (deploy automático a Vercel y VPS) |

### Especificaciones del VPS (`192.255.228.35`)
- **Recursos:** ~961 MiB RAM + 3.0 GB Swap, CPU (sin GPU).
- **Contenedores (`ai-engine/docker-compose.yml`):** `ai-engine-api-1`, `ai-engine-worker-1`, `ai-engine-redis-1` (con `restart: unless-stopped`).
- **Dependencias críticas fijadas (`ai-engine/requirements.txt`):** `celery==5.3.6`, `kombu==5.3.7`, `redis==5.0.3`, `inference==0.26.1`, `Pillow==10.4.0`.

### Tablas en Supabase (`public`)
- `zones`: polígonos de zonas guardadas (`id`, `name`, `area_ha`, `plastic_percent`, `geom`).
- `ai_scans`: estado, progreso, conteo, área total y `result_geojson`.
- `ai_detections`: polígonos individuales detectados.
- **Seguridad:** RLS (Row Level Security) habilitado en las 3 tablas con políticas `FOR ALL TO anon, authenticated`.

---

## 3. Funcionalidades Implementadas

### Mapa y Flujo de Usuario (Desktop y Mobile)
- **Vista inicial:** Centrada en **Ereván, Armenia** (`[44.5136, 40.1811]`), zoom `12.5` (mobile) / `13` (desktop), estilo `mapbox://styles/mapbox/satellite-streets-v12`.
- **Branding:** Logo `SUPER+` blanco con fondo transparente centrado sobre el texto en `Sidebar.tsx` y favicon personalizado (`favicon.png`, `favicon.ico`, `apple-touch-icon.png`).
- **Soporte Mobile (`useIsMobile.ts`):**
  - Sidebar colapsado por defecto en celular; se abre a pantalla completa con botón `✕` en esquina superior derecha.
  - **Trazar con el dedo** (`isSwipeDrawing`): capa táctil para dibujar un rectángulo arrastrando el dedo.
  - **Encuadrar Vista (1-tap):** enmarca el área visible en pantalla con 15% de margen.
  - **Zoom / Paneo seguro post-escaneo:** el polígono delimitador se deselecciona automáticamente (`featureIds: []`) y se ignoran eventos `draw.update` accidentales al pellizcar la pantalla (*pinch-to-zoom*) para no borrar las detecciones.

### Motor de Detección y Edición
- **Límites de seguridad (Guardrails):** máximo **120 ha** en frontend (`App.tsx`, `Map.tsx`) y **55 cuadrículas satelitales** en backend (`ai-engine/tasks.py`) para proteger la RAM del VPS.
- **Post-procesamiento:** cálculo de área geodésica real (`shapely`), filtro de bordes y NMS inter-teselas (`networkx`).
- **Edición en pantalla:** filtro dinámico por umbral de confianza, agregado manual de invernaderos faltantes (rectángulo o polígono), eliminación desde popup, ajuste de % adicional de lona plástica y exportación de reporte a **Excel (`.xlsx`)**.

---

## 4. Historial de Problemas Resueltos (Referencia Rápida)
1. **Escaneo trabado en 5% por OOM (zona de ~3.091 ha):** Se agregó swap (3 GB), política `restart: unless-stopped` y límites duros de 120 ha / 55 cuadrículas.
2. **Escaneo trabado en 5% por `VersionMismatch` de Kombu:** `kombu 5.7.0` exigía `redis >= 6.1.0` mientras el proyecto usa `redis==5.0.3`. Se fijó `kombu==5.3.7` en `ai-engine/requirements.txt` (commit `512b865`).
3. **Desajuste entre 120 ha y tope de teselas (40 vs 42 en 106 ha):** Se amplió el límite en `ai-engine/tasks.py` de 40 a 55 cuadrículas (commit `acdf257`).
4. **Desaparición de invernaderos al hacer zoom en mobile:** `MapboxDraw` interpretaba el gesto de *pinch-to-zoom* sobre el polígono seleccionado como `draw.update`, lo que ejecutaba `setRawScanResult(null)`. Corregido deseleccionando el polígono y protegiendo `handleZoneUpdate` (commit `8019410`).
5. **Alerta de seguridad RLS en Supabase:** Se habilitó RLS y se crearon políticas explícitas en `zones`, `ai_scans` y `ai_detections`.

---

## 5. Roadmap / Mejoras Opcionales (Pendientes de Solicitud del Cliente)
- **Escaneo de pueblos o regiones enteras (>120 ha):** Implementar procesamiento por bloques/tandas en `tasks.py` con liberación de RAM entre bloques y guardado incremental en Supabase (opcionalmente acompañado de upgrade de VPS a 2 vCPU / 4 GB RAM para mayor velocidad).
- **Notificación por correo al finalizar:** Agregar campo `notify_email` en `ai_scans` y disparo de email automático desde el worker (vía Resend o SMTP) para que el usuario pueda cerrar la app mientras se procesan zonas grandes.
