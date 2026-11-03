import os
import time
import requests
import math
import shutil
from config import MAPBOX_ACCESS_TOKEN

# Coordenadas de las zonas de entrenamiento para V6 (incluyendo las 2 zonas auditadas con invernaderos blancos/mixtos)
# Formato: nombre -> [min_lon, min_lat, max_lon, max_lat]
ZONES_BBOX = {
    "ZonaTest_1_Blancos": [44.424982, 40.146749, 44.436341, 40.152098],
    "ZonaTest_2_Nuevos": [44.413599, 40.139306, 44.428440, 40.145674],
}

ZOOM = 18
WIDTH = 1000
HEIGHT = 1000
OUTPUT_DIR = "dataset_images_v6"


def lonlat_to_mercator(lon, lat):
    x = lon * 20037508.34 / 180
    y = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180)
    y = y * 20037508.34 / 180
    return x, y


def mercator_to_lonlat(x, y):
    lon = (x / 20037508.34) * 180
    lat = (y / 20037508.34) * 180
    lat = 180 / math.pi * (2 * math.atan(math.exp(lat * math.pi / 180)) - math.pi / 2)
    return lon, lat


def get_grid_centers(bbox, zoom, logical_width, logical_height):
    min_x, min_y = lonlat_to_mercator(bbox[0], bbox[1])
    max_x, max_y = lonlat_to_mercator(bbox[2], bbox[3])

    logical_res = 78271.51696402048 / (2 ** zoom)
    tile_w_meters = logical_width * logical_res
    tile_h_meters = logical_height * logical_res

    # Paso sin solapamiento excesivo (0.85) para etiquetar en Roboflow sin duplicar trabajo
    step_w = tile_w_meters * 0.85
    step_h = tile_h_meters * 0.85

    centers = []
    curr_x = min_x + (tile_w_meters / 2)
    while curr_x < max_x + (tile_w_meters / 2):
        curr_y = min_y + (tile_h_meters / 2)
        while curr_y < max_y + (tile_h_meters / 2):
            c_lon, c_lat = mercator_to_lonlat(curr_x, curr_y)
            centers.append((c_lon, c_lat))
            curr_y += step_h
        curr_x += step_w

    return centers

def download_images():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    if MAPBOX_ACCESS_TOKEN == "YOUR_MAPBOX_TOKEN_HERE" or not MAPBOX_ACCESS_TOKEN:
        print("ERROR: Debes configurar tu MAPBOX_ACCESS_TOKEN en config.py o en las variables de entorno.")
        return

    # Pre-calcular cuadrículas para todas las zonas y calcular total esperado de imágenes
    town_grids = {}
    total_expected = 0
    for zone_name, bbox in ZONES_BBOX.items():
        centers = get_grid_centers(bbox, ZOOM, WIDTH, HEIGHT)
        town_grids[zone_name] = centers
        total_expected += len(centers)

    print("=" * 70)
    print(f"Total de zonas a procesar: {len(ZONES_BBOX)} (ZOOM={ZOOM})")
    print(f"Total esperado de imágenes a descargar: {total_expected}")
    for z_name, centers in town_grids.items():
        print(f"  - {z_name}: {len(centers)} imágenes")
    print("=" * 70)

    total_downloaded = 0
    total_skipped = 0
    global_index = 0

    for town_name, centers in town_grids.items():
        print(f"\nIniciando descarga para {town_name} ({len(centers)} imágenes)...")
        
        for i, (c_lon, c_lat) in enumerate(centers):
            global_index += 1
            filename = os.path.join(OUTPUT_DIR, f"{town_name.lower()}_{i}_{c_lon:.6f}_{c_lat:.6f}.jpg")
            
            # 1. Comprobar si ya existe en el directorio de salida (dataset_images_v2)
            if os.path.exists(filename):
                print(f"[{global_index}/{total_expected}] ({town_name} {i+1}/{len(centers)}) {filename} ya existe, saltando...")
                total_skipped += 1
                continue

            # 2. Si existe en el directorio previo dataset_images, copiarlo a dataset_images_v2
            legacy_filename = os.path.join("dataset_images", os.path.basename(filename))
            if os.path.exists(legacy_filename):
                shutil.copy2(legacy_filename, filename)
                print(f"[{global_index}/{total_expected}] ({town_name} {i+1}/{len(centers)}) Imagen existente en dataset_images, copiada a {OUTPUT_DIR} (saltando descarga)...")
                total_skipped += 1
                continue
                
            url = f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/{c_lon},{c_lat},{ZOOM}/{WIDTH}x{HEIGHT}@2x?access_token={MAPBOX_ACCESS_TOKEN}"
            
            try:
                print(f"[{global_index}/{total_expected}] ({town_name} {i+1}/{len(centers)}) Descargando imagen en {c_lon:.6f}, {c_lat:.6f}...")
                response = requests.get(url)
                if response.status_code == 200:
                    with open(filename, 'wb') as f:
                        f.write(response.content)
                        total_downloaded += 1
                else:
                    print(f"Error {response.status_code}: {response.text}")
            except Exception as e:
                print(f"Error de red: {e}")
                
            time.sleep(0.05)
            
    print(f"\n¡Descarga completada! Total descargadas: {total_downloaded}, omitidas (existentes): {total_skipped}, total esperado: {total_expected}")

if __name__ == "__main__":
    download_images()

