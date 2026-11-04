from fastapi import FastAPI, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Any
from tasks import process_ai_scan
import json
import os

app = FastAPI(title="AI Greenhouse Engine API")

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

class WebhookPayload(BaseModel):
    type: str
    table: str
    record: dict
    schema_: str = "public"
    old_record: dict = None

@app.post("/webhook/scans")
async def handle_scan_webhook(payload: dict):
    """
    Recibe el webhook de Supabase cuando se inserta un nuevo registro en ai_scans.
    """
    print("Webhook recibido:", payload)
    
    # Supabase manda un payload con formato de base de datos
    record = payload.get("record", {})
    if not record:
        return {"status": "ignored", "reason": "No record found"}

    scan_id = record.get("id")
    status = record.get("status")
    zone_id = record.get("zone_id")
    
    # Solo procesamos si el status es processing
    if status == "processing":
        # Necesitamos el geojson de la zona. 
        # Idealmente, Supabase nos manda todo, pero si no, el Celery worker podría buscarlo.
        # Para hacer la PoC rápida, vamos a disparar la tarea.
        # Como Celery Worker necesita el area y el geojson, lo pedimos desde Supabase
        
        from config import SUPABASE_URL, SUPABASE_SERVICE_KEY
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        
        zone_data = supabase.table('zones').select('*').eq('id', zone_id).execute()
        if zone_data.data:
            zone = zone_data.data[0]
            area_ha = zone.get('area_ha', 0)
            geom = zone.get('geom', {})
            
            # Encolar la tarea en Celery
            print(f"Encolando tarea para scan {scan_id}...")
            process_ai_scan.delay(scan_id, zone_id, geom, area_ha)
            return {"status": "queued", "scan_id": scan_id}
        else:
            print("Zona no encontrada.")
            return {"status": "error", "reason": "Zone not found"}
            
    return {"status": "ignored", "reason": f"Status is {status}"}

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ai-engine"}
