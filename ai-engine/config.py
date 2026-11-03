import os

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "YOUR_SERVICE_ROLE_KEY_HERE")
MAPBOX_ACCESS_TOKEN = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# Roboflow Config
ROBOFLOW_API_KEY = os.environ.get("ROBOFLOW_API_KEY", "")
ROBOFLOW_PROJECT_ID = os.environ.get("ROBOFLOW_PROJECT_ID", "deteccion-de-invernaderos") 
ROBOFLOW_VERSION = int(os.environ.get("ROBOFLOW_VERSION", 6))
