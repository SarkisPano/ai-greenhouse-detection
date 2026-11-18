from celery import Celery
import gc
import time
import math
import io
import smtplib
import requests
import redis as redis_lib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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
    APP_PUBLIC_URL,
    RESEND_API_KEY,
    NOTIFY_FROM_EMAIL,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
)
from inference import get_model
from shapely.geometry import Polygon, box
from shapely.affinity import rotate
from shapely.ops import unary_union
import networkx as nx

# Iniciar Celery y clientes
app = Celery('ai_engine', broker=REDIS_URL, backend=REDIS_URL)
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
redis_client = redis_lib.from_url(REDIS_URL, decode_responses=True)

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
    - Limpia espigas/orejas muy finas (<= 1.4m) antes de medir la caja envolvente.
    - Alinea el polígono con el ángulo dominante de sus paredes largas (ponderación cúbica 4*theta).
    - En detecciones de confianza < 75%, solo fuerza rectángulo puro si el polígono ya es aprox. rectangular
      (fill_ratio >= 0.78); si tiene forma en L/T o huecos grandes, conserva los bolsillos vacíos.
    - Detecta bolsillos vacíos independientes respecto a la caja envolvente rotada (erosionando 1.3m)
      y exige que cada bolsillo real tenga >= 20 m² Y represente >= 2.2% del área de la caja envolvente.
    - Garantiza un tope anti-inflación (<= +25% sobre la máscara cruda) y preserva patios internos grandes.
    """
    if poly_merc.is_empty or poly_merc.area <= 0:
        return poly_merc

    scale_m = 1.0 / max(cos_lat, 0.1)  # Unidades Mercator por metro físico
    raw_area = poly_merc.area

    large_holes = []
    if hasattr(poly_merc, 'interiors'):
        for ring in poly_merc.interiors:
            hole_poly = Polygon(ring).buffer(0)
            if not hole_poly.is_empty and (hole_poly.area * (cos_lat ** 2)) >= 25.0:
                large_holes.append(hole_poly)

    work_poly = poly_merc
    spike_trimmed = poly_merc.buffer(-0.7 * scale_m, join_style=2).buffer(0.7 * scale_m, join_style=2)
    if spike_trimmed.geom_type == 'MultiPolygon':
        spike_trimmed = max(spike_trimmed.geoms, key=lambda p: p.area)
    if not spike_trimmed.is_empty and spike_trimmed.area >= 0.88 * raw_area:
        work_poly = spike_trimmed

    rect_merc = work_poly.minimum_rotated_rectangle
    if rect_merc.is_empty or rect_merc.area <= 0:
        return poly_merc

    def _finalize(cand: Polygon) -> Polygon:
        res = cand
        if large_holes and not res.is_empty:
            res = res.difference(unary_union(large_holes)).buffer(0)
            if res.geom_type == 'MultiPolygon':
                res = max(res.geoms, key=lambda p: p.area)
        if res.is_empty or res.area <= 0:
            return poly_merc
        if res.area > 1.25 * raw_area:
            if not large_holes and rect_merc.area <= 1.25 * raw_area:
                return rect_merc
            fallback = work_poly.simplify(0.8 * scale_m, preserve_topology=True)
            if fallback.geom_type == 'MultiPolygon':
                fallback = max(fallback.geoms, key=lambda p: p.area)
            return fallback if (not fallback.is_empty and fallback.area > 0) else poly_merc
        return res

    # 1. Obtener el ángulo dominante real de las paredes usando media circular armónica (4*theta, invariante a 90°)
    rough_simp = work_poly.simplify(0.8 * scale_m, preserve_topology=True)
    if rough_simp.geom_type == 'MultiPolygon':
        rough_simp = max(rough_simp.geoms, key=lambda p: p.area)
    rough_coords = list(rough_simp.exterior.coords) if not rough_simp.is_empty else list(work_poly.exterior.coords)

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
    origin = work_poly.centroid
    rot_poly = rotate(work_poly, -angle_deg, origin=origin, use_radians=False).buffer(0)
    if rot_poly.geom_type == 'MultiPolygon':
        rot_poly = max(rot_poly.geoms, key=lambda p: p.area)
    if rot_poly.is_empty:
        return _finalize(rect_merc)

    rot_box = box(*rot_poly.bounds)
    if rot_box.is_empty or rot_box.area <= 0:
        return _finalize(rect_merc)

    best_rect = rotate(rot_box, angle_deg, origin=origin, use_radians=False)
    if rect_merc.area * 1.06 < rot_box.area:
        best_rect = rect_merc

    fill_ratio = work_poly.area / min(rot_box.area, rect_merc.area)

    # En predicciones amarillas/naranjas (< 75% de confianza), solo forzar rectángulo si ya llena >= 78% de su caja
    if confidence < 75.0 and fill_ratio >= 0.78 and not large_holes:
        return _finalize(best_rect)

    diff = rot_box.difference(rot_poly)

    # 2. Detectar bolsillos vacíos reales (erosión de 1.3m para ignorar bordes redondeados y conservar huecos >= 2.7m)
    eroded_diff = diff.buffer(-1.3 * scale_m) if not diff.is_empty else Polygon()
    eroded_geoms = []
    if not eroded_diff.is_empty:
        if eroded_diff.geom_type == 'Polygon':
            eroded_geoms = [eroded_diff]
        elif hasattr(eroded_diff, 'geoms'):
            eroded_geoms = [g for g in eroded_diff.geoms if g.geom_type == 'Polygon']

    valid_eroded_pockets = [
        g for g in eroded_geoms
        if (g.area * (cos_lat ** 2)) >= 20.0 and (g.area / rot_box.area) >= 0.022
    ]

    # Si no hay ningún bolsillo vacío real significativo, devolver rectángulo si es rectangular o contorno simplificado si es cóncavo
    if not valid_eroded_pockets:
        if fill_ratio >= 0.78 and not large_holes:
            return _finalize(best_rect)
        return _finalize(work_poly.simplify(0.8 * scale_m, preserve_topology=True))

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
        return _finalize(best_rect)

    pts = list(simp_rot.exterior.coords)[:-1]
    if len(pts) < 4:
        return _finalize(best_rect)

    # Filtrar micro-vértices (< 2.0m)
    clean_pts = [pts[0]]
    min_seg_len = 2.0 * scale_m
    for pt in pts[1:]:
        if math.hypot(pt[0] - clean_pts[-1][0], pt[1] - clean_pts[-1][1]) >= min_seg_len:
            clean_pts.append(pt)
    if len(clean_pts) > 1 and math.hypot(clean_pts[0][0] - clean_pts[-1][0], clean_pts[0][1] - clean_pts[-1][1]) < min_seg_len:
        clean_pts.pop()

    if len(clean_pts) < 4:
        return _finalize(best_rect)

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
        return _finalize(best_rect)

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
                    return _finalize(rotate(cand_poly, angle_deg, origin=origin, use_radians=False))
        except Exception:
            pass

    return _finalize(rotate(simp_rot, angle_deg, origin=origin, use_radians=False))


def _bboxes_overlap(b1, b2) -> bool:
    return not (b1[2] < b2[0] or b1[0] > b2[2] or b1[3] < b2[1] or b1[1] > b2[3])


def _clean_display_zone_name(raw_name: str) -> str:
    if not raw_name:
        return "Zona sin nombre"
    if raw_name.startswith("[PUEBLO] "):
        return raw_name.replace("[PUEBLO] ", "", 1).strip()
    if raw_name.startswith("[Pueblo:") and "]" in raw_name:
        idx = raw_name.find("]")
        cleaned = raw_name[idx + 1:].strip()
        return cleaned or raw_name
    return raw_name


def send_scan_completion_email(
    to_email: str,
    zone_name: str,
    town_name: str,
    area_ha: float,
    count: int,
    new_count: int,
    total_area_m2: float,
    plastic_percent: float,
    has_comparison: bool = False,
):
    if not to_email or "@" not in to_email:
        return

    clean_zone = _clean_display_zone_name(zone_name)
    total_area_ha = total_area_m2 / 10000.0
    lona_m2 = round(total_area_m2 * (1.0 + (plastic_percent or 0.0) / 100.0))
    lona_ha = lona_m2 / 10000.0
    title_place = f"{town_name} — {clean_zone}" if town_name else clean_zone

    subject = f"SUPER+ | Escaneo finalizado: {title_place} ({count} invernaderos)"
    new_row_html = (
        f"<tr><td style='padding:8px 0;color:#94a3b8;'>Invernaderos nuevos</td>"
        f"<td style='padding:8px 0;text-align:right;font-weight:700;color:#00e5ff;'>+{new_count} nuevos</td></tr>"
        if has_comparison
        else ""
    )

    html_body = f"""
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f8fafc;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;">
        <div style="color:#10b981;font-size:13px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">
          SUPER+ · Detección Inteligente de Invernaderos
        </div>
        <h2 style="margin:8px 0 4px;color:#ffffff;font-size:20px;">¡Escaneo completado con éxito!</h2>
        <p style="margin:0 0 18px;color:#cbd5e1;font-size:14px;">
          El procesamiento satelital de <strong>{title_place}</strong> ya terminó y los resultados quedaron guardados en tu panel.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #334155;border-bottom:1px solid #334155;">
          <tr>
            <td style="padding:8px 0;color:#94a3b8;">Área analizada</td>
            <td style="padding:8px 0;text-align:right;font-weight:700;">{area_ha:,.2f} ha</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;">Invernaderos detectados</td>
            <td style="padding:8px 0;text-align:right;font-weight:700;color:#10b981;">{count}</td>
          </tr>
          {new_row_html}
          <tr>
            <td style="padding:8px 0;color:#94a3b8;">Superficie cubierta (huella)</td>
            <td style="padding:8px 0;text-align:right;font-weight:700;">{total_area_m2:,.1f} m² ({total_area_ha:,.2f} ha)</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;">Lona estimada (+{int(plastic_percent)}%)</td>
            <td style="padding:8px 0;text-align:right;font-weight:700;color:#34d399;">{lona_m2:,.0f} m² ({lona_ha:,.2f} ha)</td>
          </tr>
        </table>
        <div style="margin-top:20px;text-align:center;">
          <a href="{APP_PUBLIC_URL}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;font-size:14px;">
            Ver resultados en SUPER+
          </a>
        </div>
      </div>
    </div>
    """

    if RESEND_API_KEY:
        try:
            r = requests.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": NOTIFY_FROM_EMAIL,
                    "to": [to_email],
                    "subject": subject,
                    "html": html_body,
                },
                timeout=15,
            )
            if 200 <= r.status_code < 300:
                print(f"[Email] Notificación enviada vía Resend a {to_email}")
                return
            print(f"[Email] Error Resend ({r.status_code}): {r.text}")
        except Exception as e:
            print(f"[Email] Excepción enviando vía Resend: {e}")

    if SMTP_HOST and SMTP_USER and SMTP_PASS:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = SMTP_FROM or SMTP_USER
            msg["To"] = to_email
            text_part = (
                f"SUPER+ - Escaneo finalizado: {title_place}\n"
                f"Invernaderos: {count} (Nuevos: {new_count})\n"
                f"Superficie: {total_area_m2:,.1f} m2 ({total_area_ha:,.2f} ha)\n"
                f"Lona (+{int(plastic_percent)}%): {lona_m2:,.0f} m2 ({lona_ha:,.2f} ha)\n"
                f"Ver en: {APP_PUBLIC_URL}\n"
            )
            msg.attach(MIMEText(text_part, "plain", "utf-8"))
            msg.attach(MIMEText(html_body, "html", "utf-8"))
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(msg["From"], [to_email], msg.as_string())
            print(f"[Email] Notificación enviada vía SMTP a {to_email}")
            return
        except Exception as e:
            print(f"[Email] Excepción enviando vía SMTP: {e}")

    print(f"[Email] Aviso pendiente para {to_email}, pero faltan configurar RESEND_API_KEY o SMTP_* en el servidor.")


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

    # Recuperar metadatos iniciales (pueblo, detecciones previas para comparar, email de aviso, etiquetas)
    initial_meta = {}
    zone_name = "Zona"
    plastic_percent = 0.0
    try:
        scan_row_res = supabase.table('ai_scans').select('result_geojson').eq('id', scan_id).execute()
        if scan_row_res.data and isinstance(scan_row_res.data[0].get('result_geojson'), dict):
            initial_meta = scan_row_res.data[0].get('result_geojson') or {}
    except Exception as meta_err:
        print(f"[{scan_id}] Aviso leyendo metadata inicial de ai_scans: {meta_err}")

    try:
        zone_row_res = supabase.table('zones').select('name, plastic_percent').eq('id', zone_id).execute()
        if zone_row_res.data:
            zone_name = zone_row_res.data[0].get('name') or zone_name
            plastic_percent = float(zone_row_res.data[0].get('plastic_percent') or 0.0)
    except Exception as z_err:
        print(f"[{scan_id}] Aviso leyendo datos de zona: {z_err}")

    initial_notify_email = str(initial_meta.get('notify_email') or '').strip()
    previous_features = initial_meta.get('previous_features') or []
    town_name = str(initial_meta.get('town_name') or '').strip()
    custom_labels = initial_meta.get('custom_labels') or []

    if initial_notify_email:
        try:
            redis_client.set(f"scan_notify_email:{scan_id}", initial_notify_email, ex=86400)
        except Exception:
            pass

    def get_latest_notify_email() -> str:
        try:
            redis_email = redis_client.get(f"scan_notify_email:{scan_id}")
            if redis_email and str(redis_email).strip():
                return str(redis_email).strip()
        except Exception:
            pass
        return initial_notify_email

    def update_scan_progress(percent: int, text: str, partial_features=None):
        try:
            current_email = get_latest_notify_email()
            payload_geo = {
                'type': 'FeatureCollection',
                'features': partial_features if partial_features is not None else [],
                'town_name': town_name,
                'custom_labels': custom_labels,
                'notify_email': current_email,
                'progress': {
                    'percent': percent,
                    'text': text
                }
            }
            update_data = {'result_geojson': payload_geo}
            if partial_features is not None:
                partial_area = round(sum(f.get('properties', {}).get('area_m2', 0) for f in partial_features), 1)
                update_data['detection_count'] = len(partial_features)
                update_data['total_area_detected'] = partial_area
            supabase.table('ai_scans').update(update_data).eq('id', scan_id).execute()
        except Exception:
            pass

    def is_scan_cancelled() -> bool:
        try:
            check = supabase.table('ai_scans').select('status').eq('id', scan_id).execute()
            if check.data and check.data[0].get('status') == 'cancelled':
                return True
        except Exception:
            pass
        return False

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
    if len(centers) > 650:
        return mark_scan_failed(f"Zona demasiado extensa ({len(centers)} teselas satelitales). El límite máximo por escaneo es de 650 cuadrículas (~1.500 ha). Por favor delimitá el pueblo por sectores.")

    total_tiles = max(1, len(centers))
    BATCH_SIZE = 8
    total_batches = max(1, math.ceil(total_tiles / BATCH_SIZE))
    print(f"[{scan_id}] Procesando {len(centers)} cuadrículas en {total_batches} lotes de a {BATCH_SIZE}...")
    update_scan_progress(10, f"Preparando {len(centers)} cuadrículas en {total_batches} tandas (de a poco)...")

    features = []
    logical_res = 78271.51696402048 / (2 ** ZOOM)
    physical_res = logical_res / 2  # @2x devuelve 2000x2000 px

    tiles_processed = 0
    for batch_idx in range(total_batches):
        if is_scan_cancelled():
            print(f"[{scan_id}] Escaneo cancelado por el usuario. Liberando CPU...")
            return {'status': 'cancelled'}

        start_idx = batch_idx * BATCH_SIZE
        end_idx = min(len(centers), start_idx + BATCH_SIZE)
        batch_centers = centers[start_idx:end_idx]

        # 0. Descarga paralela solo del lote actual para mantener baja la RAM
        tiles_data = []
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [
                executor.submit(fetch_mapbox_tile, start_idx + offset, c_lon, c_lat)
                for offset, (c_lon, c_lat) in enumerate(batch_centers)
            ]
            for future in as_completed(futures):
                tiles_data.append(future.result())

        tiles_data.sort(key=lambda x: x[0])

        for i, c_lon, c_lat, img in tiles_data:
            tiles_processed += 1
            if is_scan_cancelled():
                print(f"[{scan_id}] Escaneo cancelado por el usuario. Liberando CPU...")
                if img is not None:
                    try:
                        img.close()
                    except Exception:
                        pass
                return {'status': 'cancelled'}

            if img is None:
                continue

            print(f"[{scan_id}] Analizando cuadrícula {i+1}/{len(centers)} (Lote {batch_idx + 1}/{total_batches})")
            try:
                results = model.infer(img, confidence=0.18)
                if results and results[0].predictions:
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
            finally:
                try:
                    img.close()
                except Exception:
                    pass
                del img

        del tiles_data
        gc.collect()

        pct = 10 + int(78 * (tiles_processed / total_tiles))
        update_scan_progress(
            pct,
            f"Lote {batch_idx + 1}/{total_batches} ({tiles_processed}/{total_tiles} sectores) — {len(features)} detecciones parciales",
            partial_features=features
        )

    update_scan_progress(90, "Regularizando, uniendo polígonos y comparando históricos...", partial_features=features)

    # 1A. Absorción previa de duplicados contenidos y protección frente a ruido de baja confianza
    # Evita que una detección duplicada de borde o de baja confianza deforme (agregue "picos") a una detección limpia
    if len(features) > 1:
        features.sort(key=lambda f: f['properties']['confidence'], reverse=True)
        filtered_raw = []
        filtered_polys = []
        filtered_bounds = []

        for f in features:
            poly_f = Polygon(f['geometry']['coordinates'][0]).buffer(0)
            if poly_f.is_empty or poly_f.area <= 0:
                continue
            if poly_f.geom_type == 'MultiPolygon':
                poly_f = max(poly_f.geoms, key=lambda p: p.area)

            b_f = poly_f.bounds
            conf_f = f['properties']['confidence']
            absorb = False

            for idx_kept, poly_k in enumerate(filtered_polys):
                if not _bboxes_overlap(b_f, filtered_bounds[idx_kept]):
                    continue
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
                filtered_bounds.append(b_f)

        features = filtered_raw

    # 1B. Spatial Stitching: Fusionar únicamente piezas genuinamente cortadas entre teselas vecinas
    if len(features) >= 1:
        G = nx.Graph()
        polys_1b = []
        bounds_1b = []
        confs_1b = []
        for idx, f in enumerate(features):
            G.add_node(idx, feat=f)
            p_obj = Polygon(f['geometry']['coordinates'][0]).buffer(0)
            if not p_obj.is_empty and p_obj.area > 0 and p_obj.geom_type == 'MultiPolygon':
                p_obj = max(p_obj.geoms, key=lambda p: p.area)
            polys_1b.append(p_obj)
            bounds_1b.append(p_obj.bounds if (not p_obj.is_empty and p_obj.area > 0) else None)
            confs_1b.append(f['properties']['confidence'])

        for i in range(len(features)):
            p1 = polys_1b[i]
            b1 = bounds_1b[i]
            if b1 is None:
                continue
            conf1 = confs_1b[i]

            for j in range(i + 1, len(features)):
                b2 = bounds_1b[j]
                if b2 is None or not _bboxes_overlap(b1, b2):
                    continue
                p2 = polys_1b[j]
                conf2 = confs_1b[j]

                if p1.intersects(p2):
                    inter = p1.intersection(p2).area
                    min_area = min(p1.area, p2.area)
                    overlap_ratio = inter / min_area if min_area > 0 else 0

                    # No permitir que una predicción débil (< 48%) deforme a una fuerte (>= 75%)
                    if min(conf1, conf2) < 48.0 and max(conf1, conf2) >= 75.0:
                        continue

                    if overlap_ratio > 0.25:
                        G.add_edge(i, j)

        merged_features = []
        for comp in nx.connected_components(G):
            comp_nodes = list(comp)
            comp_feats = [G.nodes[n]['feat'] for n in comp_nodes]
            comp_polys = [polys_1b[n] for n in comp_nodes if bounds_1b[n] is not None]
            if not comp_polys:
                continue

            if len(comp_polys) == 1:
                united = comp_polys[0]
            else:
                united = unary_union(comp_polys).buffer(0)

            if united.geom_type == 'MultiPolygon':
                united = max(united.geoms, key=lambda p: p.area)
            if united.is_empty or not hasattr(united, 'exterior') or united.exterior is None:
                continue

            # Regularización y ortogonalización en proyección métrica Web Mercator (preservando patios internos)
            max_conf = max(f['properties']['confidence'] for f in comp_feats)
            cos_lat = math.cos(math.radians(united.centroid.y))
            exterior_merc = [lonlat_to_mercator(lon, lat) for lon, lat in united.exterior.coords]
            interiors_merc = [
                [lonlat_to_mercator(lon, lat) for lon, lat in ring.coords]
                for ring in united.interiors
            ]
            united_merc_poly = Polygon(exterior_merc, interiors_merc).buffer(0)
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

            exterior_lonlat = [list(mercator_to_lonlat(mx, my)) for mx, my in ortho_merc_poly.exterior.coords]
            interiors_lonlat = [
                [list(mercator_to_lonlat(mx, my)) for mx, my in hole.coords]
                for hole in ortho_merc_poly.interiors
            ]
            coords_rings = [exterior_lonlat] + interiors_lonlat

            merged_features.append({
                'type': 'Feature',
                'id': comp_feats[0]['id'],
                'geometry': {'type': 'Polygon', 'coordinates': coords_rings},
                'properties': {
                    'id': comp_feats[0]['id'],
                    'class': 'invernadero',
                    'confidence': max_conf,
                    'isAiDetection': True,
                    'area_m2': round(area_m2, 1)
                }
            })
        features = merged_features

    # 2. NMS Deduplication + recorte de solapamiento residual para evitar doble conteo de m²
    features.sort(key=lambda f: f['properties']['confidence'], reverse=True)
    final_features = []
    final_merc_polys = []
    final_merc_bounds = []

    for f in features:
        coords_rings = f['geometry']['coordinates']
        ext_wgs = coords_rings[0]
        holes_wgs = coords_rings[1:] if len(coords_rings) > 1 else []
        poly_f = Polygon(ext_wgs, holes_wgs).buffer(0)
        if poly_f.is_empty or poly_f.area <= 0:
            continue
        if poly_f.geom_type == 'MultiPolygon':
            poly_f = max(poly_f.geoms, key=lambda p: p.area)

        cos_lat = math.cos(math.radians(poly_f.centroid.y))
        scale_m = 1.0 / max(cos_lat, 0.1)
        ext_merc = [lonlat_to_mercator(lon, lat) for lon, lat in poly_f.exterior.coords]
        holes_merc = [[lonlat_to_mercator(lon, lat) for lon, lat in r.coords] for r in poly_f.interiors]
        merc_f = Polygon(ext_merc, holes_merc).buffer(0)
        if merc_f.is_empty or merc_f.area <= 0:
            continue
        if merc_f.geom_type == 'MultiPolygon':
            merc_f = max(merc_f.geoms, key=lambda p: p.area)

        b_merc_f = merc_f.bounds
        keep = True
        overlapping_kept = []
        for idx_ff, merc_ff in enumerate(final_merc_polys):
            if not _bboxes_overlap(b_merc_f, final_merc_bounds[idx_ff]):
                continue
            if not merc_f.intersects(merc_ff):
                continue
            iou, containment = calculate_iou_and_containment(merc_f, merc_ff)
            if iou > 0.35 or containment > 0.50:
                keep = False
                break
            overlapping_kept.append(merc_ff)

        if not keep:
            continue

        if overlapping_kept:
            kept_union = unary_union(overlapping_kept)
            trimmed = merc_f.difference(kept_union).buffer(0)
            if trimmed.geom_type == 'MultiPolygon':
                trimmed = max(trimmed.geoms, key=lambda p: p.area)
            if trimmed.is_empty or not hasattr(trimmed, 'exterior') or trimmed.exterior is None:
                continue
            if trimmed.buffer(-1.0 * scale_m).is_empty:
                continue
            new_area_m2 = trimmed.area * (cos_lat ** 2)
            conf_f = f['properties']['confidence']
            if new_area_m2 < 35.0 or (conf_f < 50.0 and new_area_m2 < 70.0):
                continue
            merc_f = trimmed
            new_ext = [list(mercator_to_lonlat(mx, my)) for mx, my in merc_f.exterior.coords]
            new_holes = [[list(mercator_to_lonlat(mx, my)) for mx, my in h.coords] for h in merc_f.interiors]
            f['geometry']['coordinates'] = [new_ext] + new_holes
            f['properties']['area_m2'] = round(new_area_m2, 1)

        final_features.append(f)
        final_merc_polys.append(merc_f)
        final_merc_bounds.append(merc_f.bounds)

    # 3. Comparación diferencial contra escaneo previo (detectar invernaderos nuevos y conservar manuales)
    has_comparison = isinstance(previous_features, list) and len(previous_features) > 0
    if has_comparison:
        prev_merc_list = []
        prev_manual_feats = []
        for pf in previous_features:
            try:
                p_geom = pf.get('geometry') or {}
                p_coords = p_geom.get('coordinates') or []
                if not p_coords:
                    continue
                if p_geom.get('type') == 'Polygon':
                    p_ext = p_coords[0]
                elif p_geom.get('type') == 'MultiPolygon':
                    p_ext = p_coords[0][0]
                else:
                    continue
                p_merc = Polygon([lonlat_to_mercator(lon, lat) for lon, lat in p_ext]).buffer(0)
                if p_merc.is_empty or p_merc.area <= 0:
                    continue
                if p_merc.geom_type == 'MultiPolygon':
                    p_merc = max(p_merc.geoms, key=lambda p: p.area)
                prev_merc_list.append((p_merc, p_merc.bounds))
                if pf.get('properties', {}).get('isManual'):
                    prev_manual_feats.append((pf, p_merc, p_merc.bounds))
            except Exception:
                continue

        for idx_f, f in enumerate(final_features):
            merc_f = final_merc_polys[idx_f]
            b_f = final_merc_bounds[idx_f]
            matched_existing = False
            for p_merc, b_p in prev_merc_list:
                if not _bboxes_overlap(b_f, b_p):
                    continue
                if not merc_f.intersects(p_merc):
                    continue
                iou, containment = calculate_iou_and_containment(merc_f, p_merc)
                if iou >= 0.18 or containment >= 0.30:
                    matched_existing = True
                    break
            f['properties']['isNew'] = not matched_existing
            f['properties']['status_diff'] = 'existing' if matched_existing else 'new'

        # Conservar invernaderos manuales previos que estén dentro de la zona y no hayan sido absorbidos
        for pf, pm_merc, pm_bounds in prev_manual_feats:
            if zone_poly_merc is not None and not pm_merc.intersects(zone_poly_merc):
                continue
            covered = False
            for idx_f, merc_f in enumerate(final_merc_polys):
                if not _bboxes_overlap(pm_bounds, final_merc_bounds[idx_f]):
                    continue
                if not pm_merc.intersects(merc_f):
                    continue
                iou, containment = calculate_iou_and_containment(pm_merc, merc_f)
                if iou >= 0.20 or containment >= 0.35:
                    covered = True
                    break
            if not covered:
                copied = {
                    'type': 'Feature',
                    'id': pf.get('id') or f"manual_{len(final_features) + 1}",
                    'geometry': pf['geometry'],
                    'properties': {
                        **pf.get('properties', {}),
                        'isManual': True,
                        'isNew': False,
                        'status_diff': 'existing'
                    }
                }
                final_features.append(copied)
                final_merc_polys.append(pm_merc)
                final_merc_bounds.append(pm_bounds)

    # Normalizar IDs limpios en string para cada feature tras NMS y comparación
    for idx, f in enumerate(final_features, 1):
        is_manual = bool(f.get('properties', {}).get('isManual'))
        clean_id = str(f.get('properties', {}).get('id') or f.get('id') or f"manual_{idx}") if is_manual else f"det_{idx}"
        f['id'] = clean_id
        f['properties']['id'] = clean_id
        if not has_comparison:
            f['properties'].setdefault('isNew', False)
            f['properties'].setdefault('status_diff', 'existing')

    features = final_features
    total_area_detected = round(sum(f['properties']['area_m2'] for f in features), 1)
    new_count = sum(1 for f in features if f.get('properties', {}).get('isNew'))
    final_email = get_latest_notify_email()

    result_geojson = {
        'type': 'FeatureCollection',
        'features': features,
        'town_name': town_name,
        'custom_labels': custom_labels,
        'notify_email': final_email,
        'new_count': new_count,
        'compared_with_previous': has_comparison
    }

    print(f"[{scan_id}] Detección completada: {len(features)} invernaderos (nuevos: {new_count}, {total_area_detected} m2).")

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    supabase.table('ai_scans').update({
        'status': 'completed',
        'total_area_detected': total_area_detected,
        'detection_count': len(features),
        'result_geojson': result_geojson,
        'completed_at': now
    }).eq('id', scan_id).execute()

    if final_email:
        send_scan_completion_email(
            to_email=final_email,
            zone_name=zone_name,
            town_name=town_name,
            area_ha=float(area_ha or 0),
            count=len(features),
            new_count=new_count,
            total_area_m2=total_area_detected,
            plastic_percent=plastic_percent,
            has_comparison=has_comparison
        )

    return {'status': 'completed', 'detections': len(features), 'new_detections': new_count}
