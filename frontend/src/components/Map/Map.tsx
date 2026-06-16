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
}

const MapComponent: React.FC<MapComponentProps> = ({ onZoneUpdate, zoneToLoad, scanResult }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);

  const [textPrompt, setTextPrompt] = useState<{lngLat: {lng: number, lat: number} | null, featureId?: string | null, visible: boolean}>({ lngLat: null, visible: false });
  const [textInput, setTextInput] = useState('');
  const [selectedTextFeature, setSelectedTextFeature] = useState<string | null>(null);

  // Initialize map and draw (with custom modes)
  useEffect(() => {
    if (map.current) return;
    if (!mapContainer.current) return;

    if (!mapboxgl.accessToken || mapboxgl.accessToken.includes('tu_token_aqui')) {
      return;
    }

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-v9',
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

    const calculateAreaAndExport = () => {
      try {
        if (!draw.current) return;
        const data = draw.current.getAll();
        
        const labelFeatures: any[] = [];

        // Calculate distance for line strings (Ruler tool) and find Text labels
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
        
        if (data.features.length > 0) {
          const areaSquareMeters = area(data);
          const areaHectares = areaSquareMeters / 10000;
          onZoneUpdate(areaHectares, data);
        } else {
          onZoneUpdate(0, null);
        }
      } catch (error) {
        console.error('Error al calcular el área:', error);
      }
    };

    map.current.on('draw.create', calculateAreaAndExport);
    map.current.on('draw.delete', calculateAreaAndExport);
    map.current.on('draw.update', calculateAreaAndExport);

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
        map.current.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, duration: 1500 });
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
        paint: {
          'fill-color': '#00FF00',
          'fill-opacity': 0.3
        }
      });

      map.current!.addLayer({
        id: 'ai-detections-line',
        type: 'line',
        source: 'ai-detections-source',
        paint: {
          'line-color': '#00FF00',
          'line-width': 2
        }
      });

    });
  }, []);

  // Update AI detections when scanResult changes
  useEffect(() => {
    if (!map.current) return;
    
    const source = map.current.getSource('ai-detections-source') as mapboxgl.GeoJSONSource;
    if (source) {
      if (scanResult?.geojson) {
        source.setData(scanResult.geojson);
      } else {
        source.setData({ type: 'FeatureCollection', features: [] });
      }
    }
  }, [scanResult]);

  const handleAddText = () => {
    if (!textInput.trim() || !draw.current || !map.current) return;
    
    if (textPrompt.featureId) {
      // Editing existing feature
      draw.current.setFeatureProperty(textPrompt.featureId, 'text', textInput.trim());
      map.current.fire('draw.update', { features: [draw.current.get(textPrompt.featureId)] });
    } else if (textPrompt.lngLat) {
      // Adding new feature
      const point = {
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
      <div ref={mapContainer} className={styles.mapContainer} />
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
