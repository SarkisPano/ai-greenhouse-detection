import os

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "YOUR_SERVICE_ROLE_KEY_HERE")
MAPBOX_ACCESS_TOKEN = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# Roboflow Config
ROBOFLOW_API_KEY = os.environ.get("ROBOFLOW_API_KEY", "")
ROBOFLOW_PROJECT_ID = os.environ.get("ROBOFLOW_PROJECT_ID", "deteccion-de-invernaderos") 
ROBOFLOW_VERSION = int(os.environ.get("ROBOFLOW_VERSION", 6))

# Notificaciones por Email y URL publica de la App (SUPER+)
APP_PUBLIC_URL = os.environ.get("APP_PUBLIC_URL", "https://ai-greenhouse-detection.vercel.app")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
NOTIFY_FROM_EMAIL = os.environ.get("NOTIFY_FROM_EMAIL", "SUPER+ <onboarding@resend.dev>")
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "")
