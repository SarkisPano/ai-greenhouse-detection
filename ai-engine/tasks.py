from celery import Celery
import time
import math
import io
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image
from supabase import create_client
from config import (
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    REDIS_URL,
    ROBOFLOW_API_KEY,
    ROBOFLOW_PROJECT_ID,
    ROBOFLOW_VERSION,
    MAPBOX_ACCESS_TOKEN,
)
from inference import get_model
from shapely.geometry import Polygon, box
from shapely.affinity import rotate
from shapely.ops import unary_union
import networkx as nx

# Iniciar Celery
app = Celery('ai_engine', broker=REDIS_URL, backend=REDIS_URL)
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Caché en memoria del modelo para evitar recargas innecesarias entre escaneos
_MODEL_CACHE = {}

def get_cached_model():
    model_key = f"{ROBOFLOW_PROJECT_ID}/{ROBOFLOW_VERSION}"
    if model_key not in _MODEL_CACHE:
        _MODEL_CACHE[model_key] = get_model(model_id=model_key, api_key=ROBOFLOW_API_KEY)
    return _MODEL_CACHE[model_key]

# Configuración del Slicing (Zoom 18 cubre ~300m x 300m por baldosa)
ZOOM = 18
WIDTH = 1000
HEIGHT = 1000
IMAGE_PX_SIZE = 2000  # Mapbox @2x devuelve 2000x2000 píxeles


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


def get_grid_centers(bbox, zoom, logical_width, logical_height, zone_poly_merc=None):
    min_x, min_y = lonlat_to_mercator(bbox[0], bbox[1])
    max_x, max_y = lonlat_to_mercator(bbox[2], bbox[3])

    # Mapbox usa tiles base de 512px: 40075016.68557849 / (512 * 2^zoom) = 78271.51696402048 / 2^zoom
    logical_res = 78271.51696402048 / (2 ** zoom)

    tile_w_meters = logical_width * logical_res
    tile_h_meters = logical_height * logical_res

    # Solapamiento de 25% (step 0.75) para evitar cortes en invernaderos largos
    step_w = tile_w_meters * 0.75
    step_h = tile_h_meters * 0.75

    centers = []
    curr_x = min_x + (tile_w_meters / 2)
    while curr_x < max_x + (tile_w_meters / 2):
        curr_y = min_y + (tile_h_meters / 2)
        while curr_y < max_y + (tile_h_meters / 2):
            # Si tenemos el polígono de la zona en Mercator, saltar teselas que no toquen la zona
            if zone_poly_merc is not None:
                tile_box = box(
                    curr_x - tile_w_meters / 2,
                    curr_y - tile_h_meters / 2,
                    curr_x + tile_w_meters / 2,
                    curr_y + tile_h_meters / 2,
                )
                if not zone_poly_merc.intersects(tile_box):
                    curr_y += step_h
                    continue

            c_lon, c_lat = mercator_to_lonlat(curr_x, curr_y)
            centers.append((c_lon, c_lat))
            curr_y += step_h
        curr_x += step_w

    return centers


def calculate_iou_and_containment(poly1, poly2):
    try:
        inter = poly1.intersection(poly2).area
        if inter <= 0:
            return 0, 0
        union = poly1.union(poly2).area
        iou = inter / union if union > 0 else 0
        min_area = min(poly1.area, poly2.area)
        containment = inter / min_area if min_area > 0 else 0
        return iou, containment
    except Exception:
        return 0, 0


def orthogonalize_mercator_polygon(poly_merc: Polygon, cos_lat: float, confidence: float = 100.0) -> Polygon:
    """
    Regulariza un polígono en coordenadas Web Mercator:
    - Alinea el polígono con el ángulo dominante de sus paredes largas (ponderación cúbica 4*theta).
    - En detecciones de confianza media/baja (< 75%), devuelve directamente el rectángulo puro de 4 esquinas
      para no copiar mordiscos de máscaras dudosas.
    - Detecta bolsillos vacíos independientes respecto a la caja envolvente rotada (erosionando 1.8m)
      y exige que cada bolsillo real tenga >= 35 m² Y represente >= 3.2% del área de la caja envolvente.
    - Rellena las esquinas falsas o mordiscos chicos para que las paredes alineadas queden 100% rectas,
      y reconstruye únicamente los escalones arquitectónicos grandes a 90°.
    """
    if poly_merc.is_empty or poly_merc.area <= 0:
        return poly_merc

    scale_m = 1.0 / max(cos_lat, 0.1)  # Unidades Mercator por metro físico
    rect_merc = poly_merc.minimum_rotated_rectangle
    if rect_merc.is_empty or rect_merc.area <= 0:
        return poly_merc

    # 1. Obtener el ángulo dominante real de las paredes usando media circular armónica (4*theta, invariante a 90°)
    rough_simp = poly_merc.simplify(0.8 * scale_m, preserve_topology=True)
    if rough_simp.geom_type == 'MultiPolygon':
        rough_simp = max(rough_simp.geoms, key=lambda p: p.area)
    rough_coords = list(rough_simp.exterior.coords) if not rough_simp.is_empty else list(poly_merc.exterior.coords)

    sum_sin4 = 0.0
    sum_cos4 = 0.0
    for i in range(len(rough_coords) - 1):
        dx = rough_coords[i + 1][0] - rough_coords[i][0]
        dy = rough_coords[i + 1][1] - rough_coords[i][1]
        seg_len = math.hypot(dx, dy)
        if seg_len > 1.0 * scale_m:
            theta = math.atan2(dy, dx)
            weight = seg_len ** 3
            sum_sin4 += weight * math.sin(4.0 * theta)
            sum_cos4 += weight * math.cos(4.0 * theta)

    if math.hypot(sum_sin4, sum_cos4) > 1e-6:
        angle_rad = 0.25 * math.atan2(sum_sin4, sum_cos4)
    else:
        rect_coords = list(rect_merc.exterior.coords)
        angle_rad = math.atan2(rect_coords[1][1] - rect_coords[0][1], rect_coords[1][0] - rect_coords[0][0])

    angle_deg = math.degrees(angle_rad)
    origin = poly_merc.centroid
    rot_poly = rotate(poly_merc, -angle_deg, origin=origin, use_radians=False).buffer(0)
    if rot_poly.geom_type == 'MultiPolygon':
        rot_poly = max(rot_poly.geoms, key=lambda p: p.area)
    if rot_poly.is_empty:
        return rect_merc

    rot_box = box(*rot_poly.bounds)
    if rot_box.is_empty or rot_box.area <= 0:
        return rect_merc

    # En predicciones amarillas/naranjas (< 75% de confianza), no copiar mordiscos de la máscara: forzar rectángulo limpio
    if confidence < 75.0:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    diff = rot_box.difference(rot_poly)

    # 2. Detectar bolsillos vacíos reales (erosión de 1.8m para ignorar bordes redondeados y ruido)
    eroded_diff = diff.buffer(-1.8 * scale_m) if not diff.is_empty else Polygon()
    eroded_geoms = []
    if not eroded_diff.is_empty:
        if eroded_diff.geom_type == 'Polygon':
            eroded_geoms = [eroded_diff]
        elif hasattr(eroded_diff, 'geoms'):
            eroded_geoms = [g for g in eroded_diff.geoms if g.geom_type == 'Polygon']

    valid_eroded_pockets = [
        g for g in eroded_geoms
        if (g.area * (cos_lat ** 2)) >= 35.0 and (g.area / rot_box.area) >= 0.032
    ]

    # Si no hay ningún bolsillo vacío real significativo, es un invernadero rectangular puro de 4 vértices
    if not valid_eroded_pockets:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    # 3. Rellenar esquinas falsas o mordiscos chicos para que las paredes alineadas queden 100% rectas
    valid_zones = unary_union([
        box(*g.bounds).buffer(2.4 * scale_m, join_style=2)
        for g in valid_eroded_pockets
    ])
    false_pockets = diff.difference(valid_zones)
    cleaned_rot_poly = rot_poly.union(false_pockets).buffer(0)
    if cleaned_rot_poly.geom_type == 'MultiPolygon':
        cleaned_rot_poly = max(cleaned_rot_poly.geoms, key=lambda p: p.area)

    simp_rot = cleaned_rot_poly.simplify(1.4 * scale_m, preserve_topology=True)
    if simp_rot.geom_type == 'MultiPolygon':
        simp_rot = max(simp_rot.geoms, key=lambda p: p.area)
    if simp_rot.is_empty or not hasattr(simp_rot, 'exterior') or simp_rot.exterior is None:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    pts = list(simp_rot.exterior.coords)[:-1]
    if len(pts) < 4:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    # Filtrar micro-vértices (< 2.0m)
    clean_pts = [pts[0]]
    min_seg_len = 2.0 * scale_m
    for pt in pts[1:]:
        if math.hypot(pt[0] - clean_pts[-1][0], pt[1] - clean_pts[-1][1]) >= min_seg_len:
            clean_pts.append(pt)
    if len(clean_pts) > 1 and math.hypot(clean_pts[0][0] - clean_pts[-1][0], clean_pts[0][1] - clean_pts[-1][1]) < min_seg_len:
        clean_pts.pop()

    if len(clean_pts) < 4:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    # Convertir diagonales de bolsillos reales en un único escalón ortogonal limpio a 90°
    tan_thresh = 0.268  # tan(15°)
    step_pts = []
    n_clean = len(clean_pts)
    for i in range(n_clean):
        p1 = clean_pts[i]
        p2 = clean_pts[(i + 1) % n_clean]
        step_pts.append(p1)
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        if abs(dx) > 2.5 * scale_m and abs(dy) > 2.5 * scale_m:
            if abs(dy) > abs(dx) * tan_thresh and abs(dx) > abs(dy) * tan_thresh:
                c1 = (p2[0], p1[1])
                c2 = (p1[0], p2[1])
                tri1 = Polygon([p1, c1, p2])
                tri2 = Polygon([p1, c2, p2])
                r1 = (tri1.intersection(cleaned_rot_poly).area / tri1.area) if tri1.area > 1e-6 else 0.5
                r2 = (tri2.intersection(cleaned_rot_poly).area / tri2.area) if tri2.area > 1e-6 else 0.5

                if r1 >= r2:
                    step_pts.append(c1)
                else:
                    step_pts.append(c2)

    # Clasificar cada arista como Horizontal ('H') o Vertical ('V')
    segments = []
    n = len(step_pts)
    for i in range(n):
        p1 = step_pts[i]
        p2 = step_pts[(i + 1) % n]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        seg_len = math.hypot(dx, dy)
        if seg_len <= 1e-4:
            continue
        if abs(dx) >= abs(dy):
            y_mid = 0.5 * (p1[1] + p2[1])
            segments.append({'type': 'H', 'val': y_mid, 'len': seg_len, 'p1': p1, 'p2': p2})
        else:
            x_mid = 0.5 * (p1[0] + p2[0])
            segments.append({'type': 'V', 'val': x_mid, 'len': seg_len, 'p1': p1, 'p2': p2})

    if len(segments) < 4:
        return rotate(rot_box, angle_deg, origin=origin, use_radians=False)

    # Fusionar aristas consecutivas del mismo tipo si su desnivel es <= 2.4m (elimina escaloncitos chicos)
    merged_segs = [segments[0]]
    merge_tol = 2.4 * scale_m
    for seg in segments[1:]:
        prev = merged_segs[-1]
        if seg['type'] == prev['type']:
            if abs(seg['val'] - prev['val']) <= merge_tol:
                tot_len = prev['len'] + seg['len']
                prev['val'] = (prev['val'] * prev['len'] + seg['val'] * seg['len']) / tot_len
                prev['len'] = tot_len
                prev['p2'] = seg['p2']
                continue
            else:
                perp_type = 'V' if seg['type'] == 'H' else 'H'
                perp_val = prev['p2'][0] if perp_type == 'V' else prev['p2'][1]
                merged_segs.append({'type': perp_type, 'val': perp_val, 'len': abs(seg['val'] - prev['val']), 'p1': prev['p2'], 'p2': seg['p1']})
        merged_segs.append(seg)

    if len(merged_segs) >= 2 and merged_segs[0]['type'] == merged_segs[-1]['type']:
        first = merged_segs[0]
        last = merged_segs[-1]
        if abs(first['val'] - last['val']) <= merge_tol:
            tot_len = first['len'] + last['len']
            first['val'] = (first['val'] * first['len'] + last['val'] * last['len']) / tot_len
            first['len'] = tot_len
            first['p1'] = last['p1']
            merged_segs.pop()
        else:
            perp_type = 'V' if first['type'] == 'H' else 'H'
            perp_val = last['p2'][0] if perp_type == 'V' else last['p2'][1]
            merged_segs.append({'type': perp_type, 'val': perp_val, 'len': abs(first['val'] - last['val']), 'p1': last['p2'], 'p2': first['p1']})

    ortho_pts = []
    m = len(merged_segs)
    for i in range(m):
        s1 = merged_segs[i]
        s2 = merged_segs[(i + 1) % m]
        if s1['type'] == 'H' and s2['type'] == 'V':
            ortho_pts.append((s2['val'], s1['val']))
        elif s1['type'] == 'V' and s2['type'] == 'H':
            ortho_pts.append((s1['val'], s2['val']))
        else:
            ortho_pts.append(s2['p1'])

    if len(ortho_pts) >= 4:
        try:
            cand_poly = Polygon(ortho_pts).buffer(0)
            # Limpiar posibles espigas o escaloncitos estrechos (< 2.4m)
            opened = cand_poly.buffer(-1.2 * scale_m, join_style=2).buffer(1.2 * scale_m, join_style=2)
            if not opened.is_empty and opened.area > 0.85 * cand_poly.area:
                cand_poly = opened.simplify(0.8 * scale_m, preserve_topology=True)
            if cand_poly.geom_type == 'MultiPolygon':
                cand_poly = max(cand_poly.geoms, key=lambda p: p.area)
            if not cand_poly.is_empty and cand_poly.area > 0:
                iou, _ = calculate_iou_and_containment(cand_poly, cleaned_rot_poly)
                if iou >= 0.80:
                    return rotate(cand_poly, angle_deg, origin=origin, use_radians=False)
        except Exception:
            pass

    return rotate(simp_rot, angle_deg, origin=origin, use_radians=False)


def fetch_mapbox_tile(idx: int, c_lon: float, c_lat: float):
    url = f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/{c_lon},{c_lat},{ZOOM}/{WIDTH}x{HEIGHT}@2x?access_token={MAPBOX_ACCESS_TOKEN}"
    for attempt in range(2):
        try:
            resp = requests.get(url, timeout=12)
            if resp.status_code == 200:
                img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                return idx, c_lon, c_lat, img
        except Exception as e:
            if attempt == 1:
                print(f"Error descargando tile {idx}: {e}")
    return idx, c_lon, c_lat, None


@app.task(name='process_ai_scan')
def process_ai_scan(scan_id: str, zone_id: str, geojson: dict, area_ha: float):
    print(f"[{scan_id}] Iniciando escaneo de la zona {zone_id}...")

    def update_scan_progress(percent: int, text: str):
        try:
            supabase.table('ai_scans').update({
                'result_geojson': {
                    'progress': {
                        'percent': percent,
                        'text': text
                    }
                }
            }).eq('id', scan_id).execute()
        except Exception:
            pass

    def mark_scan_failed(reason: str):
        print(f"[{scan_id}] Escaneo fallido: {reason}")
        try:
            from datetime import datetime, timezone
            supabase.table('ai_scans').update({
                'status': 'failed',
                'completed_at': datetime.now(timezone.utc).isoformat()
            }).eq('id', scan_id).execute()
        except Exception as db_err:
            print(f"[{scan_id}] Error actualizando estado failed: {db_err}")
        return {'status': 'error', 'reason': reason}

    try:
        model = get_cached_model()
    except Exception as e:
        return mark_scan_failed(f"Error cargando modelo: {e}")

    coords = []
    if geojson.get('type') == 'Polygon':
        coords = geojson['coordinates'][0]
    elif geojson.get('type') == 'MultiPolygon':
        coords = geojson['coordinates'][0][0]
    elif geojson.get('type') == 'FeatureCollection':
        poly_feats = [
            f for f in geojson.get('features', [])
            if f.get('geometry', {}).get('type') in ('Polygon', 'MultiPolygon')
        ]
        if poly_feats:
            geom_obj = poly_feats[0]['geometry']
            coords = geom_obj['coordinates'][0] if geom_obj['type'] == 'Polygon' else geom_obj['coordinates'][0][0]

    if not coords or len(coords) < 3:
        return mark_scan_failed('Invalid GeoJSON')

    try:
        zone_poly_gps = Polygon(coords).buffer(0)
        zone_merc_coords = [lonlat_to_mercator(lon, lat) for lon, lat in coords]
        zone_poly_merc = Polygon(zone_merc_coords).buffer(0)
    except Exception as e:
        return mark_scan_failed(f"Error construyendo polígono de zona: {e}")

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    bbox = [min(lons), min(lats), max(lons), max(lats)]

    centers = get_grid_centers(bbox, ZOOM, WIDTH, HEIGHT, zone_poly_merc=zone_poly_merc)
    total_tiles = max(1, len(centers))
    print(f"[{scan_id}] Descargando en paralelo {len(centers)} recortes de Mapbox...")
    update_scan_progress(10, f"Descargando {len(centers)} cuadrículas satelitales HD...")

    features = []
    logical_res = 78271.51696402048 / (2 ** ZOOM)
    physical_res = logical_res / 2  # @2x devuelve 2000x2000 px

    # 0. Descarga paralela de imágenes satelitales de Mapbox
    tiles_data = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(fetch_mapbox_tile, i, c_lon, c_lat) for i, (c_lon, c_lat) in enumerate(centers)]
        for future in as_completed(futures):
            tiles_data.append(future.result())

    tiles_data.sort(key=lambda x: x[0])
    step_update = max(1, total_tiles // 6)

    for idx_tile, (i, c_lon, c_lat, img) in enumerate(tiles_data):
        if img is None:
            continue
        print(f"[{scan_id}] Analizando cuadrícula {i+1}/{len(centers)}")
        if idx_tile % step_update == 0 or idx_tile == total_tiles - 1:
            pct = 15 + int(70 * ((idx_tile + 1) / total_tiles))
            update_scan_progress(pct, f"Analizando sector {idx_tile + 1} de {total_tiles} con IA...")
        try:
            results = model.infer(img, confidence=0.18)
            if not results or not results[0].predictions:
                continue

            c_x, c_y = lonlat_to_mercator(c_lon, c_lat)
            cos_lat = math.cos(math.radians(c_lat))

            for pred in results[0].predictions:
                if pred.confidence < 0.18:
                    continue

                if not hasattr(pred, 'points') or not pred.points or len(pred.points) < 3:
                    continue

                poly_coords_gps = []
                for pt in pred.points:
                    pt_merc_x = c_x + (pt.x - 1000) * physical_res
                    pt_merc_y = c_y - (pt.y - 1000) * physical_res
                    pt_lon, pt_lat = mercator_to_lonlat(pt_merc_x, pt_merc_y)
                    poly_coords_gps.append([pt_lon, pt_lat])

                if len(poly_coords_gps) >= 3:
                    poly = Polygon(poly_coords_gps).buffer(0)
                    if not poly.is_empty and poly.area > 0:
                        if poly.geom_type == 'MultiPolygon':
                            poly = max(poly.geoms, key=lambda p: p.area)

                        simplified = poly.simplify(0.000003, preserve_topology=True)
                        if simplified.geom_type == 'MultiPolygon':
                            simplified = max(simplified.geoms, key=lambda p: p.area)
                        if simplified.is_empty or not hasattr(simplified, 'exterior') or simplified.exterior is None:
                            continue
                        final_coords = list(simplified.exterior.coords)

                        final_mercator_coords = [lonlat_to_mercator(lon, lat) for lon, lat in final_coords]
                        final_mercator_poly = Polygon(final_mercator_coords)
                        area_m2 = final_mercator_poly.area * (cos_lat ** 2)

                        if area_m2 < 20 or area_m2 > 60000:
                            continue

                        mrr = final_mercator_poly.minimum_rotated_rectangle
                        mrr_coords = list(mrr.exterior.coords)
                        if len(mrr_coords) >= 4:
                            side1 = math.hypot(mrr_coords[0][0] - mrr_coords[1][0], mrr_coords[0][1] - mrr_coords[1][1])
                            side2 = math.hypot(mrr_coords[1][0] - mrr_coords[2][0], mrr_coords[1][1] - mrr_coords[2][1])
                            if side1 > 0 and side2 > 0:
                                aspect_ratio = max(side1, side2) / min(side1, side2)
                                if aspect_ratio > 35:
                                    continue

                        feat_id = f"det_{len(features)+1}"
                        features.append({
                            'type': 'Feature',
                            'id': feat_id,
                            'geometry': {
                                'type': 'Polygon',
                                'coordinates': [final_coords]
                            },
                            'properties': {
                                'id': feat_id,
                                'class': 'invernadero',
                                'confidence': round(pred.confidence * 100, 2),
                                'isAiDetection': True,
                                'area_m2': round(area_m2, 1)
                            }
                        })
        except Exception as e:
            print(f"Error procesando tile {i}: {e}")

    update_scan_progress(90, "Regularizando y uniendo polígonos...")

    # 1A. Absorción previa de duplicados contenidos y protección frente a ruido de baja confianza
    # Evita que una detección duplicada de borde o de baja confianza deforme (agregue "picos") a una detección limpia
    if len(features) > 1:
        features.sort(key=lambda f: f['properties']['confidence'], reverse=True)
        filtered_raw = []
        filtered_polys = []

        for f in features:
            poly_f = Polygon(f['geometry']['coordinates'][0]).buffer(0)
            if poly_f.is_empty or poly_f.area <= 0:
                continue
            if poly_f.geom_type == 'MultiPolygon':
                poly_f = max(poly_f.geoms, key=lambda p: p.area)

            conf_f = f['properties']['confidence']
            absorb = False

            for idx_kept, poly_k in enumerate(filtered_polys):
                conf_k = filtered_raw[idx_kept]['properties']['confidence']
                if not poly_f.intersects(poly_k):
                    continue
                inter_area = poly_f.intersection(poly_k).area
                containment_in_k = inter_area / poly_f.area if poly_f.area > 0 else 0
                containment_in_f = inter_area / poly_k.area if poly_k.area > 0 else 0

                # Si la detección actual ya está contenida en >= 82% dentro de una de mayor confianza, es un duplicado
                if containment_in_k >= 0.82:
                    absorb = True
                    break

                # Si la detección actual es débil (< 38%) y choca (> 8%) con una detección fuerte (>= 75%), descartar la débil
                if conf_f < 38.0 and conf_k >= 75.0 and max(containment_in_k, containment_in_f) > 0.08:
                    absorb = True
                    break

            if not absorb:
                filtered_raw.append(f)
                filtered_polys.append(poly_f)

        features = filtered_raw

    # 1B. Spatial Stitching: Fusionar únicamente piezas genuinamente cortadas entre teselas vecinas
    if len(features) >= 1:
        G = nx.Graph()
        for idx, f in enumerate(features):
            G.add_node(idx, feat=f)

        for i in range(len(features)):
            p1 = Polygon(features[i]['geometry']['coordinates'][0]).buffer(0)
            if p1.is_empty or p1.area <= 0:
                continue
            if p1.geom_type == 'MultiPolygon':
                p1 = max(p1.geoms, key=lambda p: p.area)
            conf1 = features[i]['properties']['confidence']

            for j in range(i + 1, len(features)):
                p2 = Polygon(features[j]['geometry']['coordinates'][0]).buffer(0)
                if p2.is_empty or p2.area <= 0:
                    continue
                if p2.geom_type == 'MultiPolygon':
                    p2 = max(p2.geoms, key=lambda p: p.area)
                conf2 = features[j]['properties']['confidence']

                if p1.intersects(p2):
                    inter = p1.intersection(p2).area
                    min_area = min(p1.area, p2.area)
                    overlap_ratio = inter / min_area if min_area > 0 else 0

                    # No permitir que una predicción débil (< 38%) deforme a una fuerte (>= 75%)
                    if min(conf1, conf2) < 38.0 and max(conf1, conf2) >= 75.0:
                        continue

                    if overlap_ratio > 0.15:
                        G.add_edge(i, j)

        merged_features = []
        for comp in nx.connected_components(G):
            comp_nodes = list(comp)
            comp_feats = [G.nodes[n]['feat'] for n in comp_nodes]
            comp_polys = [Polygon(f['geometry']['coordinates'][0]).buffer(0) for f in comp_feats]

            if len(comp_polys) == 1:
                united = comp_polys[0]
            else:
                united = unary_union(comp_polys).buffer(0)

            if united.geom_type == 'MultiPolygon':
                united = max(united.geoms, key=lambda p: p.area)
            if united.is_empty or not hasattr(united, 'exterior') or united.exterior is None:
                continue

            # Regularización y ortogonalización en proyección métrica Web Mercator
            max_conf = max(f['properties']['confidence'] for f in comp_feats)
            cos_lat = math.cos(math.radians(united.centroid.y))
            united_merc_coords = [lonlat_to_mercator(lon, lat) for lon, lat in united.exterior.coords]
            united_merc_poly = Polygon(united_merc_coords).buffer(0)
            if united_merc_poly.geom_type == 'MultiPolygon':
                united_merc_poly = max(united_merc_poly.geoms, key=lambda p: p.area)

            ortho_merc_poly = orthogonalize_mercator_polygon(united_merc_poly, cos_lat, max_conf)
            if ortho_merc_poly.is_empty or not hasattr(ortho_merc_poly, 'exterior') or ortho_merc_poly.exterior is None:
                continue

            # Recortar exactamente sobre la línea azul del seleccionador (zone_poly_merc)
            if zone_poly_merc is not None:
                if not ortho_merc_poly.intersects(zone_poly_merc):
                    continue
                clipped_merc_poly = ortho_merc_poly.intersection(zone_poly_merc).buffer(0)
                if clipped_merc_poly.geom_type == 'MultiPolygon':
                    clipped_merc_poly = max(clipped_merc_poly.geoms, key=lambda p: p.area)
                if clipped_merc_poly.is_empty or not hasattr(clipped_merc_poly, 'exterior') or clipped_merc_poly.exterior is None:
                    continue
                # Si fue cortado por el borde de la zona, exigir que penetre al menos 2.4m reales y no sea una simple puntita (< 85 m² y < 22%)
                scale_m = 1.0 / max(cos_lat, 0.1)
                if clipped_merc_poly.area < 0.90 * ortho_merc_poly.area:
                    clipped_area_m2 = clipped_merc_poly.area * (cos_lat ** 2)
                    inside_ratio = clipped_merc_poly.area / ortho_merc_poly.area if ortho_merc_poly.area > 0 else 0
                    if clipped_merc_poly.buffer(-1.2 * scale_m).is_empty:
                        continue
                    if clipped_area_m2 < 85.0 and inside_ratio < 0.22:
                        continue
                ortho_merc_poly = clipped_merc_poly

            area_m2 = ortho_merc_poly.area * (cos_lat ** 2)

            if area_m2 < 35 or area_m2 > 60000:
                continue
            # Descartar micro-fragmentos aislados de baja confianza (< 50% y < 70 m²)
            if max_conf < 50.0 and area_m2 < 70.0:
                continue

            final_c = [list(mercator_to_lonlat(mx, my)) for mx, my in ortho_merc_poly.exterior.coords]

            merged_features.append({
                'type': 'Feature',
                'id': comp_feats[0]['id'],
                'geometry': {'type': 'Polygon', 'coordinates': [final_c]},
                'properties': {
                    'id': comp_feats[0]['id'],
                    'class': 'invernadero',
                    'confidence': max_conf,
                    'isAiDetection': True,
                    'area_m2': round(area_m2, 1)
                }
            })
        features = merged_features

    # 2. NMS Deduplication
    features.sort(key=lambda f: f['properties']['confidence'], reverse=True)
    final_features = []

    for f in features:
        poly_f = Polygon(f['geometry']['coordinates'][0]).buffer(0)
        if poly_f.is_empty or poly_f.area <= 0:
            continue
        if poly_f.geom_type == 'MultiPolygon':
            poly_f = max(poly_f.geoms, key=lambda p: p.area)

        keep = True
        for ff in final_features:
            poly_ff = Polygon(ff['geometry']['coordinates'][0]).buffer(0)
            if poly_ff.geom_type == 'MultiPolygon':
                poly_ff = max(poly_ff.geoms, key=lambda p: p.area)
            iou, containment = calculate_iou_and_containment(poly_f, poly_ff)
            if iou > 0.35 or containment > 0.50:
                keep = False
                break
        if keep:
            final_features.append(f)

    # Normalizar IDs limpios en string para cada feature tras NMS
    for idx, f in enumerate(final_features, 1):
        clean_id = f"det_{idx}"
        f['id'] = clean_id
        f['properties']['id'] = clean_id

    features = final_features
    total_area_detected = round(sum(f['properties']['area_m2'] for f in features), 1)

    result_geojson = {
        'type': 'FeatureCollection',
        'features': features
    }

    print(f"[{scan_id}] Detección completada: {len(features)} invernaderos ({total_area_detected} m2).")

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    supabase.table('ai_scans').update({
        'status': 'completed',
        'total_area_detected': total_area_detected,
        'detection_count': len(features),
        'result_geojson': result_geojson,
        'completed_at': now
    }).eq('id', scan_id).execute()

    return {'status': 'completed', 'detections': len(features)}
