import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { area } from '@turf/area';
import bbox from '@turf/bbox';
import length from '@turf/length';
import DrawRectangle from 'mapbox-gl-draw-rectangle-mode';

import DrawText from './modes/DrawText';
import DrawingToolbar from '../DrawingToolbar/DrawingToolbar';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import styles from './Map.module.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

interface MapComponentProps {
  onZoneUpdate: (areaHectares: number, geojson: any) => void;
  zoneToLoad: { geojson: any; timestamp: number } | null;
  scanResult?: any;
  plasticPercent?: number;
  onDeleteDetection?: (featureId: string) => void;
  isAddingManual?: boolean;
  onManualDetectionAdded?: (feature: any) => void;
  onCancelAddManual?: () => void;
  isScanning?: boolean;
  scanProgress?: { percent: number; text: string } | null;
  onCancelScan?: () => void;
  isMobile?: boolean;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
}

interface SearchSuggestion {
  id: string;
  place_name: string;
  center: [number, number];
  bbox?: [number, number, number, number];
}

const MapComponent: React.FC<MapComponentProps> = ({ 
  onZoneUpdate, 
  zoneToLoad, 
  scanResult,
  plasticPercent = 0,
  onDeleteDetection,
  isAddingManual = false,
  onManualDetectionAdded,
  onCancelAddManual,
  isScanning = false,
  scanProgress,
  onCancelScan,
  isMobile = false,
  onToggleSidebar
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);

  const onDeleteDetectionRef = useRef(onDeleteDetection);
  onDeleteDetectionRef.current = onDeleteDetection;

  const isAddingManualRef = useRef(isAddingManual);
  isAddingManualRef.current = isAddingManual;

  const onManualDetectionAddedRef = useRef(onManualDetectionAdded);
  onManualDetectionAddedRef.current = onManualDetectionAdded;

  const plasticPercentRef = useRef(plasticPercent);
  plasticPercentRef.current = plasticPercent;

  const [textPrompt, setTextPrompt] = useState<{lngLat: {lng: number, lat: number} | null, featureId?: string | null, visible: boolean}>({ lngLat: null, visible: false });
  const [textInput, setTextInput] = useState('');
  const [selectedTextFeature, setSelectedTextFeature] = useState<string | null>(null);
  const [showDetections, setShowDetections] = useState(true);
  const [showStreets, setShowStreets] = useState(true);
  const [manualShapeType, setManualShapeType] = useState<'polygon' | 'rectangle'>('polygon');

  // Buscador de localidades / coordenadas
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Initialize map and draw (with custom modes)
  useEffect(() => {
    if (map.current) return;
    if (!mapContainer.current) return;

    if (!mapboxgl.accessToken || mapboxgl.accessToken.includes('tu_token_aqui')) {
      return;
    }

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [44.5136, 40.1811], // Ereván, Armenia
      zoom: 12,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.current.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
      }),
      'top-right'
    );

    draw.current = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: false, trash: false },
      modes: {
        ...MapboxDraw.modes,
        draw_rectangle: (DrawRectangle as any).default || DrawRectangle,

        draw_text: DrawText,
      },
    });

    map.current.addControl(draw.current as any, 'bottom-left');

    // Hide native MapboxDraw UI container
    const drawContainer = document.querySelector('.mapboxgl-ctrl-group');
    if (drawContainer) {
      (drawContainer as HTMLElement).style.display = 'none';
    }

    const updateCustomLabels = () => {
      try {
        if (!draw.current) return;
        const data = draw.current.getAll();
        const labelFeatures: any[] = [];

        data.features.forEach((f: any) => {
          if (f.geometry.type === 'LineString' && (!f.properties.mode || f.properties.mode === 'draw_line_string')) {
            const dist = length(f, { units: 'kilometers' });
            const text = dist > 1 ? `${dist.toFixed(2)} km` : `${(dist * 1000).toFixed(0)} m`;
            labelFeatures.push({
              type: 'Feature',
              geometry: f.geometry,
              properties: { text, isLine: true }
            });
          }
          if (f.geometry.type === 'Point' && f.properties.mode === 'draw_text') {
            labelFeatures.push({
              type: 'Feature',
              geometry: f.geometry,
              properties: { text: f.properties.text, isText: true }
            });
          }
        });

        const labelsSource = map.current?.getSource('custom-labels-source') as mapboxgl.GeoJSONSource;
        if (labelsSource) {
          labelsSource.setData({ type: 'FeatureCollection', features: labelFeatures });
        }
      } catch (error) {
        console.error('Error al actualizar etiquetas:', error);
      }
    };

    const recalculateZonePolygon = () => {
      try {
        if (!draw.current) return;
        updateCustomLabels();
        const data = draw.current.getAll();
        const polygonFeatures = data.features.filter(
          (f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
        );

        if (polygonFeatures.length > 0) {
          const polyCollection = {
            type: 'FeatureCollection' as const,
            features: [polygonFeatures[polygonFeatures.length - 1]]
          };
          const areaSquareMeters = area(polyCollection as any);
          const areaHectares = areaSquareMeters / 10000;
          onZoneUpdate(areaHectares, polyCollection);
        } else {
          onZoneUpdate(0, null);
        }
      } catch (error) {
        console.error('Error al calcular el área:', error);
      }
    };

    const handleDrawCreate = (e: any) => {
      if (isAddingManualRef.current && e.features && e.features.length > 0) {
        const createdFeature = e.features[0];
        const areaM2 = Math.round(area(createdFeature));
        
        // Remove from draw instance so it doesn't affect the search zone area
        draw.current?.delete(createdFeature.id);

        const newId = `manual_${Date.now()}`;
        const manualFeature = {
          type: 'Feature',
          id: newId,
          geometry: createdFeature.geometry,
          properties: {
            id: newId,
            class: 'invernadero',
            confidence: 100,
            isAiDetection: true,
            isManual: true,
            area_m2: areaM2
          }
        };

        if (onManualDetectionAddedRef.current) {
          onManualDetectionAddedRef.current(manualFeature);
        }
        return;
      }

      // Si el usuario creó una línea (Regla) o un texto, solo actualizamos las etiquetas sin reiniciar la zona ni borrar el escaneo
      if (e.features && e.features.length > 0) {
        const created = e.features[0];
        if (created.geometry?.type === 'LineString' || created.geometry?.type === 'Point') {
          updateCustomLabels();
          return;
        }
        // Si dibujó un nuevo polígono de zona, eliminar polígonos de zona viejos para que siempre haya 1 sola zona activa limpia
        if (created.geometry?.type === 'Polygon' && draw.current) {
          const all = draw.current.getAll();
          all.features.forEach((f: any) => {
            if ((f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') && f.id !== created.id) {
              draw.current?.delete(f.id);
            }
          });
        }
      }
      
      recalculateZonePolygon();
    };

    const handleDrawUpdateOrDelete = (e: any) => {
      // Si solo se editó o borró una línea de regla o un texto, no reiniciar el escaneo de la zona
      if (e.features && e.features.length > 0 && e.features.every((f: any) => f.geometry?.type === 'LineString' || f.geometry?.type === 'Point')) {
        updateCustomLabels();
        return;
      }
      recalculateZonePolygon();
    };

    map.current.on('draw.create', handleDrawCreate);
    map.current.on('draw.delete', handleDrawUpdateOrDelete);
    map.current.on('draw.update', handleDrawUpdateOrDelete);

    map.current.on('draw.text_prompt', (e: any) => {
      setTextPrompt({ lngLat: e.lngLat, visible: true });
      setTextInput('');
    });

    map.current.on('draw.selectionchange', (e: any) => {
      if (e.features && e.features.length === 1 && e.features[0].properties.mode === 'draw_text') {
        setSelectedTextFeature(e.features[0].id);
      } else {
        setSelectedTextFeature(null);
      }
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      map.current?.resize();
    });
    if (mapContainer.current) {
      resizeObserver.observe(mapContainer.current);
    }

    return () => {
      resizeObserver.disconnect();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Load saved zone
  useEffect(() => {
    if (zoneToLoad?.geojson && draw.current && map.current) {
      draw.current.deleteAll();
      draw.current.add(zoneToLoad.geojson);
      try {
        const [minX, minY, maxX, maxY] = bbox(zoneToLoad.geojson);
        if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
          if (Math.abs(minY) <= 90 && Math.abs(maxY) <= 90) {
            map.current.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, duration: 1500 });
          }
        }
      } catch (e) {
        console.error('Error al centrar el mapa en la zona cargada:', e);
      }
    }
  }, [zoneToLoad]);

  // Add text label layer when map loads
  useEffect(() => {
    if (!map.current) return;
    map.current.on('load', () => {
      // Add custom source for labels
      map.current!.addSource('custom-labels-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Text Layer
      map.current!.addLayer({
        id: 'text-labels-custom',
        type: 'symbol',
        source: 'custom-labels-source',
        filter: ['==', 'isText', true],
        layout: {
          'text-field': ['get', 'text'],
          'text-size': 20,
          'text-offset': [0, 0.8],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 4,
          'text-halo-blur': 1,
        },
      });

      // Ruler Distance Label Layer
      map.current!.addLayer({
        id: 'distance-labels-custom',
        type: 'symbol',
        source: 'custom-labels-source',
        filter: ['==', 'isLine', true],
        layout: {
          'symbol-placement': 'line-center',
          'text-field': ['get', 'text'],
          'text-size': 14,
          'text-offset': [0, -1],
        },
        paint: {
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        },
      });

      // AI Detections
      map.current!.addSource('ai-detections-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.current!.addLayer({
        id: 'ai-detections-fill',
        type: 'fill',
        source: 'ai-detections-source',
        layout: {
          visibility: 'visible'
        },
        paint: {
          'fill-color': [
            'case',
            ['>', ['coalesce', ['get', 'confidence'], 0], 80], '#00C853',
            ['>=', ['coalesce', ['get', 'confidence'], 0], 50], '#FFD600',
            '#FF6D00'
          ],
          'fill-opacity': 0.35
        }
      });

      map.current!.addLayer({
        id: 'ai-detections-line',
        type: 'line',
        source: 'ai-detections-source',
        layout: {
          visibility: 'visible'
        },
        paint: {
          'line-color': [
            'case',
            ['>', ['coalesce', ['get', 'confidence'], 0], 80], '#00C853',
            ['>=', ['coalesce', ['get', 'confidence'], 0], 50], '#FFD600',
            '#FF6D00'
          ],
          'line-width': 2.5
        }
      });

      map.current!.addLayer({
        id: 'ai-detections-labels',
        type: 'symbol',
        source: 'ai-detections-source',
        minzoom: 15.5,
        layout: {
          visibility: 'visible',
          'text-field': ['concat', '#', ['to-string', ['coalesce', ['get', 'displayIndex'], '']]],
          'text-size': 12,
          'text-allow-overlap': false,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0f172a',
          'text-halo-width': 2
        }
      });

      // Add popup on click with interactive delete button
      map.current!.on('click', 'ai-detections-fill', (e: any) => {
        if (!e.features || e.features.length === 0) return;

        // Si no estamos dibujando manualmente, deseleccionar la zona azul para evitar arrastrar sus vértices por error
        if (!isAddingManualRef.current && draw.current) {
          try {
            draw.current.changeMode('simple_select', { featureIds: [] });
          } catch (err) {
            // ignore
          }
        }

        const feature = e.features[0];
        const { confidence, area_m2, id: featureId, isManual, displayIndex } = feature.properties || {};
        const rawId = featureId !== undefined && featureId !== null && featureId !== '' ? featureId : feature.id;
        const fid = String(rawId ?? '');
        
        if (popupRef.current) {
          popupRef.current.remove();
          popupRef.current = null;
        }

        const confText = isManual ? '100% (Manual)' : `${confidence}%`;
        const badgeColor = confidence > 80 ? '#00C853' : confidence >= 50 ? '#FFD600' : '#FF6D00';
        const titleText = displayIndex ? `Invernadero #${displayIndex}` : 'Invernadero';
        const numArea = Number(area_m2 || 0);
        const pct = plasticPercentRef.current || 0;
        const lonaM2 = Math.round(numArea * (1 + pct / 100));

        const popupNode = document.createElement('div');
        popupNode.style.color = '#1f2937';
        popupNode.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        popupNode.style.padding = '4px 2px';
        popupNode.style.minWidth = '185px';

        // Detener propagación en el nodo para que ningún clic o interacción llegue al canvas de Mapbox
        popupNode.addEventListener('click', (ev) => ev.stopPropagation());
        popupNode.addEventListener('mousedown', (ev) => ev.stopPropagation());
        popupNode.addEventListener('touchstart', (ev) => ev.stopPropagation());

        popupNode.innerHTML = `
          <div style="font-weight: 700; font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span>${titleText}</span>
            <span style="background: ${badgeColor}; color: ${confidence >= 50 && confidence <= 80 ? '#000' : '#fff'}; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 10px;">${confText}</span>
          </div>
          <div style="font-size: 13px; color: #4b5563; margin-bottom: ${pct > 0 ? '4px' : '10px'};">
            Superficie: <strong style="color: #111827;">${numArea.toLocaleString()} m²</strong>
          </div>
          ${pct > 0 ? `
          <div style="font-size: 12.5px; color: #059669; margin-bottom: 10px;">
            Lona (+${pct}%): <strong>${lonaM2.toLocaleString()} m²</strong>
          </div>
          ` : ''}
          <button id="btn-del-det" style="
            width: 100%;
            background: #ef4444;
            color: white;
            border: none;
            padding: 6px 10px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: background 0.15s;
          ">
            🗑️ Eliminar Detección
          </button>
        `;

        const deleteBtn = popupNode.querySelector('#btn-del-det') as HTMLButtonElement;
        if (deleteBtn) {
          deleteBtn.onmouseenter = () => { deleteBtn.style.background = '#dc2626'; };
          deleteBtn.onmouseleave = () => { deleteBtn.style.background = '#ef4444'; };
          deleteBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            if (onDeleteDetectionRef.current && fid) {
              onDeleteDetectionRef.current(fid);
            }
            if (popupRef.current) {
              popupRef.current.remove();
              popupRef.current = null;
            }
          });
        }

        const popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat(e.lngLat)
          .setDOMContent(popupNode)
          .addTo(map.current!);

        popupRef.current = popup;

        // Evitar que el contenedor general del popup de Mapbox propague eventos al canvas
        const popupEl = popup.getElement();
        if (popupEl) {
          popupEl.addEventListener('click', (ev) => ev.stopPropagation());
          popupEl.addEventListener('mousedown', (ev) => ev.stopPropagation());
        }
      });

      // Change cursor
      map.current!.on('mouseenter', 'ai-detections-fill', () => {
        if (map.current) map.current.getCanvas().style.cursor = 'pointer';
      });

      map.current!.on('mouseleave', 'ai-detections-fill', () => {
        if (map.current) map.current.getCanvas().style.cursor = '';
      });

    });
  }, []);

  const overlayIdsRef = useRef<string[]>([]);

  // Update AI detections when scanResult changes
  useEffect(() => {
    if (!map.current) return;
    
    // Si hay un popup abierto al actualizar el scanResult, removerlo para evitar popups desfasados
    if (popupRef.current) {
      popupRef.current.remove();
      popupRef.current = null;
    }

    // Limpiar overlays de imagen si quedaron algunos
    overlayIdsRef.current.forEach(id => {
      try {
        if (map.current?.getLayer(id)) map.current.removeLayer(id);
        if (map.current?.getSource(id)) map.current.removeSource(id);
      } catch (e) {
        // ignore
      }
    });
    overlayIdsRef.current = [];
    
    const updateSource = () => {
      try {
        const source = map.current?.getSource('ai-detections-source') as mapboxgl.GeoJSONSource;
        if (source) {
          if (scanResult?.geojson) {
            source.setData(scanResult.geojson);
          } else {
            source.setData({ type: 'FeatureCollection', features: [] });
          }
        }
      } catch (e) {
        console.warn('Map source not ready yet:', e);
      }
    };

    if (map.current.getSource('ai-detections-source')) {
      updateSource();
    } else {
      map.current.once('load', updateSource);
    }
  }, [scanResult]);

  // Toggle detections layer visibility
  useEffect(() => {
    if (!map.current) return;
    const visibility = showDetections ? 'visible' : 'none';
    const applyVisibility = () => {
      try {
        if (map.current?.getLayer('ai-detections-fill')) {
          map.current.setLayoutProperty('ai-detections-fill', 'visibility', visibility);
        }
        if (map.current?.getLayer('ai-detections-line')) {
          map.current.setLayoutProperty('ai-detections-line', 'visibility', visibility);
        }
        if (map.current?.getLayer('ai-detections-labels')) {
          map.current.setLayoutProperty('ai-detections-labels', 'visibility', visibility);
        }
      } catch (e) {
        console.warn('Error setting layer visibility:', e);
      }
    };

    if (map.current.getLayer('ai-detections-fill')) {
      applyVisibility();
    } else {
      map.current.once('load', applyVisibility);
    }
    
    if (!showDetections && popupRef.current) {
      popupRef.current.remove();
      popupRef.current = null;
    }
  }, [showDetections]);

  // Toggle streets and place labels visibility without reloading MapboxDraw
  useEffect(() => {
    if (!map.current) return;
    const visibility = showStreets ? 'visible' : 'none';

    const applyStreetsVisibility = () => {
      try {
        const style = map.current?.getStyle();
        if (!style || !style.layers) return;
        style.layers.forEach((layer) => {
          const id = layer.id;
          if (
            layer.type === 'raster' ||
            layer.type === 'background' ||
            id.startsWith('gl-draw-') ||
            id.startsWith('ai-detections-') ||
            id === 'text-labels-custom' ||
            id === 'distance-labels-custom'
          ) {
            return;
          }
          map.current?.setLayoutProperty(id, 'visibility', visibility);
        });
      } catch (e) {
        // ignore if style not yet loaded
      }
    };

    if (map.current.isStyleLoaded()) {
      applyStreetsVisibility();
    } else {
      map.current.once('load', applyStreetsVisibility);
    }
  }, [showStreets]);

  // Mode switcher for adding manual greenhouses
  useEffect(() => {
    if (!draw.current) return;
    if (isAddingManual) {
      const targetMode = manualShapeType === 'polygon' ? 'draw_polygon' : 'draw_rectangle';
      (draw.current as any).changeMode(targetMode);
    } else {
      const mode = draw.current.getMode();
      if (mode === 'draw_rectangle' || mode === 'draw_polygon') {
        draw.current.changeMode('simple_select');
      }
    }
  }, [isAddingManual, manualShapeType]);

  // Buscador de ciudades, pueblos, rutas o coordenadas GPS (exclusivo para Armenia)
  const fetchArmeniaPlaces = async (q: string): Promise<SearchSuggestion[]> => {
    const combined: SearchSuggestion[] = [];

    const addUnique = (item: SearchSuggestion) => {
      const isDuplicate = combined.some((existing) => {
        const dLon = Math.abs(existing.center[0] - item.center[0]);
        const dLat = Math.abs(existing.center[1] - item.center[1]);
        return dLon < 0.008 && dLat < 0.008;
      });
      if (!isDuplicate) {
        combined.push(item);
      }
    };

    const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=am&format=jsonv2&limit=6&accept-language=en,es,hy,ru`;
    const mapboxUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxgl.accessToken}&country=am&proximity=44.5136,40.1811&types=place,locality,neighborhood,district,region,address,poi&limit=5`;

    const [nomRes, mbxRes] = await Promise.allSettled([
      fetch(nominatimUrl),
      fetch(mapboxUrl)
    ]);

    if (nomRes.status === 'fulfilled' && nomRes.value.ok) {
      try {
        const nomData = await nomRes.value.json();
        (nomData || []).forEach((item: any) => {
          const lon = parseFloat(item.lon);
          const lat = parseFloat(item.lat);
          if (!isNaN(lon) && !isNaN(lat)) {
            let bboxVal: [number, number, number, number] | undefined;
            if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
              // Nominatim devuelve [minLat, maxLat, minLon, maxLon]
              const minLat = parseFloat(item.boundingbox[0]);
              const maxLat = parseFloat(item.boundingbox[1]);
              const minLon = parseFloat(item.boundingbox[2]);
              const maxLon = parseFloat(item.boundingbox[3]);
              if (!isNaN(minLat) && !isNaN(maxLat) && !isNaN(minLon) && !isNaN(maxLon)) {
                bboxVal = [minLon, minLat, maxLon, maxLat];
              }
            }
            addUnique({
              id: `nom_${item.place_id}`,
              place_name: item.display_name,
              center: [lon, lat],
              bbox: bboxVal
            });
          }
        });
      } catch {
        // ignore parse error
      }
    }

    if (mbxRes.status === 'fulfilled' && mbxRes.value.ok) {
      try {
        const mbxData = await mbxRes.value.json();
        (mbxData.features || []).forEach((f: any) => {
          if (Array.isArray(f.center) && f.center.length === 2) {
            addUnique({
              id: `mbx_${f.id}`,
              place_name: f.place_name,
              center: f.center,
              bbox: f.bbox
            });
          }
        });
      } catch {
        // ignore parse error
      }
    }

    return combined.slice(0, 7);
  };

  const skipNextAutocompleteRef = useRef(false);

  // Autocompletado en vivo mientras escribe (restringido a Armenia)
  useEffect(() => {
    if (skipNextAutocompleteRef.current) {
      skipNextAutocompleteRef.current = false;
      return;
    }
    const q = searchQuery.trim();
    if (q.length < 2 || /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.test(q)) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setIsSearching(true);
        const feats = await fetchArmeniaPlaces(q);
        setSearchResults(feats);
      } catch (err) {
        console.error('Error en autocompletado:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSearchLocation = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = searchQuery.trim();
    if (!q || !map.current) return;

    // 1. Chequear si ingresó coordenadas directas "lat, lon"
    const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      const first = parseFloat(coordMatch[1]);
      const second = parseFloat(coordMatch[2]);
      const lat = Math.abs(first) <= 90 ? first : second;
      const lon = Math.abs(first) <= 90 ? second : first;
      map.current.flyTo({ center: [lon, lat], zoom: 16, duration: 1400 });
      setSearchResults([]);
      return;
    }

    // 2. Si ya hay resultados cargados por el autocompletado, ir directo al primero al apretar Enter / Ir
    if (searchResults.length > 0) {
      selectSearchResult(searchResults[0]);
      return;
    }

    // 3. Buscar localidad en Armenia (OpenStreetMap Nominatim + Mapbox Armenia)
    try {
      setIsSearching(true);
      const feats = await fetchArmeniaPlaces(q);
      setSearchResults(feats);
      if (feats.length > 0) {
        selectSearchResult(feats[0]);
      }
    } catch (err) {
      console.error('Error buscando ubicación:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const selectSearchResult = (item: SearchSuggestion) => {
    if (!map.current) return;
    if (item.bbox && item.bbox.length === 4) {
      map.current.fitBounds(
        [[item.bbox[0], item.bbox[1]], [item.bbox[2], item.bbox[3]]],
        { padding: 60, maxZoom: 16, duration: 1400 }
      );
    } else {
      map.current.flyTo({ center: item.center, zoom: 15, duration: 1400 });
    }
    skipNextAutocompleteRef.current = true;
    setSearchQuery(item.place_name);
    setSearchResults([]);
  };

  const handleAddText = () => {
    if (!textInput.trim() || !draw.current || !map.current) return;
    
    if (textPrompt.featureId) {
      // Editing existing feature
      draw.current.setFeatureProperty(textPrompt.featureId, 'text', textInput.trim());
      map.current.fire('draw.update', { features: [draw.current.get(textPrompt.featureId)] });
    } else if (textPrompt.lngLat) {
      // Adding new feature
      const point: any = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [textPrompt.lngLat.lng, textPrompt.lngLat.lat] },
        properties: { mode: 'draw_text', text: textInput.trim() }
      };
      draw.current.add(point);
      map.current.fire('draw.create', { features: [point] });
    }
    
    setTextPrompt({ lngLat: null, visible: false });
  };

  const openEditModal = () => {
    if (!draw.current || !selectedTextFeature) return;
    const feature = draw.current.get(selectedTextFeature);
    if (feature && feature.properties) {
      setTextPrompt({ lngLat: null, featureId: selectedTextFeature, visible: true });
      setTextInput(feature.properties.text || '');
    }
  };

  return (
    <div className={styles.mapWrapper}>
      {isAddingManual && (
        <div style={{
          position: 'absolute',
          top: '60px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          backgroundColor: '#1e293b',
          color: '#ffffff',
          padding: '6px 14px',
          borderRadius: '30px',
          fontWeight: 500,
          fontSize: '13px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
          border: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.08)', borderRadius: '20px', padding: '2px' }}>
            <button
              onClick={() => setManualShapeType('polygon')}
              style={{
                background: manualShapeType === 'polygon' ? '#00C853' : 'transparent',
                color: manualShapeType === 'polygon' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '16px',
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              🔷 Polígono (Puntos)
            </button>
            <button
              onClick={() => setManualShapeType('rectangle')}
              style={{
                background: manualShapeType === 'rectangle' ? '#00C853' : 'transparent',
                color: manualShapeType === 'rectangle' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '16px',
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              ⏹️ Rectángulo
            </button>
          </div>

          <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
            {manualShapeType === 'polygon' 
              ? 'Hacé click punto por punto y cerralo en el primer punto' 
              : 'Arrastrá para marcar el rectángulo'}
          </span>

          <button 
            onClick={onCancelAddManual}
            style={{
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              color: '#fff',
              borderRadius: '50%',
              width: '22px',
              height: '22px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
            title="Cancelar dibujo manual"
          >✕</button>
        </div>
      )}

      {/* Barra superior del mapa: Buscador de localidades/coordenadas + Controles de capas */}
      <div style={{
        position: 'absolute',
        top: '12px',
        left: isMobile ? '10px' : '34px',
        right: isMobile ? '56px' : 'auto',
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: isMobile ? 'nowrap' : 'wrap',
        maxWidth: isMobile ? 'calc(100vw - 68px)' : 'none'
      }}>
        {isMobile && onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            style={{
              background: 'rgba(17, 24, 39, 0.94)',
              color: '#10b981',
              border: '1px solid #374151',
              borderRadius: '8px',
              height: '34px',
              padding: '0 9px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
              backdropFilter: 'blur(6px)',
              flexShrink: 0
            }}
            title="Abrir Menú / Panel"
          >
            <span style={{ fontSize: '14px' }}>☰</span>
            <span>Panel</span>
          </button>
        )}

        <div style={{ position: 'relative', flex: isMobile ? 1 : 'none', minWidth: 0 }}>
          <form onSubmit={handleSearchLocation} style={{
            display: 'flex',
            alignItems: 'center',
            background: 'rgba(17, 24, 39, 0.92)',
            border: '1px solid #374151',
            borderRadius: '8px',
            padding: '2px 5px 2px 8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            backdropFilter: 'blur(6px)',
            width: isMobile ? '100%' : 'auto'
          }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (!e.target.value.trim()) setSearchResults([]);
              }}
              placeholder={isMobile ? "Buscar..." : "Buscar en Armenia o lat, lon..."}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#f9fafb',
                fontSize: '12px',
                width: isMobile ? '100%' : '210px',
                minWidth: '50px',
                outline: 'none',
                padding: '4px 0'
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => { setSearchQuery(''); setSearchResults([]); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '0 3px'
                }}
                title="Limpiar búsqueda"
              >
                ✕
              </button>
            )}
            <button
              type="submit"
              style={{
                background: 'var(--color-primary)',
                border: 'none',
                color: '#ffffff',
                borderRadius: '6px',
                padding: '4px 7px',
                fontSize: '11.5px',
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0
              }}
              title="Buscar ubicación"
            >
              {isSearching ? '...' : 'Ir'}
            </button>
          </form>

          {searchResults.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              width: isMobile ? '260px' : '280px',
              maxWidth: '90vw',
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '8px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
              overflow: 'hidden',
              zIndex: 20
            }}>
              {searchResults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectSearchResult(item)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid #1f2937',
                    color: '#e5e7eb',
                    padding: '8px 10px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'block'
                  }}
                >
                  📍 {item.place_name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button 
          style={{
            background: showDetections ? 'rgba(17, 24, 39, 0.92)' : 'rgba(239, 68, 68, 0.9)',
            color: '#f9fafb',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            border: '1px solid #374151',
            padding: isMobile ? '6px 8px' : '6px 11px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            flexShrink: 0
          }}
          onClick={() => setShowDetections(!showDetections)}
          title={showDetections ? "Ocultar polígonos detectados" : "Mostrar polígonos detectados"}
        >
          <span>{showDetections ? '👁️' : '🚫'}</span>
          {!isMobile && <span>Detecciones</span>}
        </button>

        <button 
          style={{
            background: showStreets ? 'rgba(17, 24, 39, 0.92)' : 'rgba(31, 41, 55, 0.75)',
            color: showStreets ? '#10b981' : '#9ca3af',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            border: `1px solid ${showStreets ? '#10b981' : '#374151'}`,
            padding: isMobile ? '6px 8px' : '6px 11px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            flexShrink: 0
          }}
          onClick={() => setShowStreets(!showStreets)}
          title={showStreets ? "Ocultar nombres de calles y ciudades" : "Mostrar nombres de calles y ciudades"}
        >
          <span>🗺️</span>
          {!isMobile && <span>Calles y Nombres</span>}
        </button>
      </div>

      <div ref={mapContainer} className={styles.mapContainer} />
      
      {isScanning && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(10, 15, 29, 0.65)',
          backdropFilter: 'blur(3px)',
          WebkitBackdropFilter: 'blur(3px)',
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'all'
        }}>
          <div style={{
            backgroundColor: '#111827',
            border: '1px solid #374151',
            borderRadius: '14px',
            padding: '1.75rem 2.25rem',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.75)',
            maxWidth: '430px',
            width: '88%',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            animation: 'fadeIn 0.25s ease'
          }}>
            <div style={{
              width: '46px',
              height: '46px',
              border: '3px solid rgba(16, 185, 129, 0.2)',
              borderTopColor: '#10b981',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            <div>
              <h3 style={{ margin: 0, color: '#f9fafb', fontSize: '1.15rem', fontWeight: 600 }}>
                Escaneo IA en Curso ({scanProgress?.percent ?? 5}%)
              </h3>
              <p style={{ margin: '0.45rem 0 0', color: '#9ca3af', fontSize: '0.85rem' }}>
                {scanProgress?.text || 'Analizando imágenes satelitales en alta resolución...'}
              </p>
            </div>
            <div style={{ width: '100%', height: '8px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '999px', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(5, Math.min(100, scanProgress?.percent ?? 5))}%`,
                height: '100%',
                backgroundColor: '#10b981',
                borderRadius: '999px',
                transition: 'width 0.4s ease'
              }} />
            </div>
            {onCancelScan && (
              <button
                type="button"
                onClick={onCancelScan}
                style={{
                  marginTop: '0.4rem',
                  padding: '0.5rem 1.25rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(239, 68, 68, 0.5)',
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  color: '#fca5a5',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.25)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)')}
              >
                ✕ Cancelar Escaneo
              </button>
            )}
          </div>
        </div>
      )}

      <DrawingToolbar drawRef={draw} mapRef={map} />
      {(!import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_TOKEN.includes('tu_token_aqui')) && (
        <div className={styles.tokenWarning}>
          <p>⚠️ Falta el Access Token de Mapbox.</p>
        </div>
      )}
      
      {selectedTextFeature && !textPrompt.visible && (
        <div className={styles.floatingEditBtn}>
          <button onClick={openEditModal}>
            ✏️ Editar Texto
          </button>
        </div>
      )}

      {textPrompt.visible && (
        <div className={styles.textModalOverlay}>
          <div className={styles.textModal}>
            <h3>{textPrompt.featureId ? 'Editar Texto' : 'Añadir Texto'}</h3>
            <input 
              type="text" 
              autoFocus
              value={textInput} 
              onChange={e => setTextInput(e.target.value)} 
              onKeyDown={e => { if(e.key === 'Enter') handleAddText() }}
              placeholder="Escribe algo..."
            />
            <div className={styles.textModalActions}>
              <button onClick={() => setTextPrompt({ lngLat: null, visible: false })}>Cancelar</button>
              <button className={styles.primaryBtn} onClick={handleAddText}>Aceptar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapComponent;
