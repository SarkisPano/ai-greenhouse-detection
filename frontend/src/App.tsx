import { useState, useCallback, useEffect } from 'react';
import bbox from '@turf/bbox';
import MapComponent from './components/Map/Map';
import Sidebar from './components/Sidebar/Sidebar';

export interface ScanResult {
  count: number;
  totalArea: number;
  geojson?: any;
}

export interface SavedZone {
  id: string;
  name: string;
  areaHa: number;
  date: string;
  geojson: any; // Coordenadas del polígono
  plasticPercent?: number; // Porcentaje de lona elegido
}

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Estado de la Zona actual
  const [zoneAreaHa, setZoneAreaHa] = useState<number>(0);
  const [currentGeoJSON, setCurrentGeoJSON] = useState<any>(null);
  const [zoneToLoad, setZoneToLoad] = useState<{ geojson: any, timestamp: number } | null>(null);
  
  // Estado de Edición
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  
  // Estado del Escaneo
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  
  // Estado de la Calculadora de Material
  const [plasticPercent, setPlasticPercent] = useState<number>(0);

  // Estado de la Librería de Proyectos (LocalStorage)
  const [savedZones, setSavedZones] = useState<SavedZone[]>(() => {
    const saved = localStorage.getItem('catastro_ai_zones');
    return saved ? JSON.parse(saved) : [];
  });

  const handleZoneUpdate = useCallback((areaHectares: number, geojson: any) => {
    setZoneAreaHa(areaHectares);
    setCurrentGeoJSON(geojson);
    setScanResult(null); 
  }, []);

  const handleSaveZone = (name: string) => {
    if (!currentGeoJSON || zoneAreaHa === 0) return;
    
    const newZone: SavedZone = {
      id: Date.now().toString(),
      name,
      areaHa: zoneAreaHa,
      date: new Date().toLocaleDateString(),
      geojson: currentGeoJSON,
      plasticPercent
    };
    
    const updated = [newZone, ...savedZones]; 
    setSavedZones(updated);
    localStorage.setItem('catastro_ai_zones', JSON.stringify(updated));
    setActiveZoneId(newZone.id);
  };

  const handleUpdateZone = (name: string) => {
    if (!activeZoneId || !currentGeoJSON || zoneAreaHa === 0) return;
    
    const updated = savedZones.map(z => 
      z.id === activeZoneId 
        ? { ...z, name, areaHa: zoneAreaHa, geojson: currentGeoJSON, date: new Date().toLocaleDateString(), plasticPercent } 
        : z
    );
    
    setSavedZones(updated);
    localStorage.setItem('catastro_ai_zones', JSON.stringify(updated));
  };

  const handleLoadZone = (zone: SavedZone) => {
    setActiveZoneId(zone.id);
    setZoneToLoad({ geojson: zone.geojson, timestamp: Date.now() });
    setZoneAreaHa(zone.areaHa);
    setCurrentGeoJSON(zone.geojson);
    setPlasticPercent(zone.plasticPercent || 0);
    setScanResult(null); 
  };

  const handleCancelEdit = () => {
    setActiveZoneId(null);
    setZoneAreaHa(0);
    setCurrentGeoJSON(null);
    setZoneToLoad({ geojson: { type: 'FeatureCollection', features: [] }, timestamp: Date.now() });
    setPlasticPercent(0);
    setScanResult(null);
  };

  const handleDeleteZone = (id: string) => {
    const updated = savedZones.filter(z => z.id !== id);
    setSavedZones(updated);
    localStorage.setItem('catastro_ai_zones', JSON.stringify(updated));
    if (activeZoneId === id) {
      handleCancelEdit();
    }
  };

  const handleScanZone = () => {
    if (zoneAreaHa === 0 || !currentGeoJSON) return;
    
    setIsScanning(true);
    setScanResult(null);

    setTimeout(() => {
      // Calculate bounding box using turf bbox
      let minX = 0, minY = 0, maxX = 0, maxY = 0;
      try {
        const box = bbox(currentGeoJSON);
        minX = box[0];
        minY = box[1];
        maxX = box[2];
        maxY = box[3];
      } catch (e) {
        // Fallback
        minX = -180; minY = -90; maxX = 180; maxY = 90;
      }

      const mockCount = Math.max(1, Math.floor(zoneAreaHa * (Math.random() * 2 + 2)));
      const mockTotalArea = mockCount * 800; 
      
      const features = [];
      for (let i = 0; i < mockCount; i++) {
        // Base coordinate inside bounding box
        const x = minX + Math.random() * (maxX - minX);
        const y = minY + Math.random() * (maxY - minY);
        
        // Approx size of a greenhouse in degrees
        const w = 0.0003 + Math.random() * 0.0002;
        const h = 0.0003 + Math.random() * 0.0002;
        
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [x, y],
              [x + w, y],
              [x + w, y + h],
              [x, y + h],
              [x, y]
            ]]
          },
          properties: {
            confidence: Math.floor(85 + Math.random() * 15),
            isAiDetection: true
          }
        });
      }

      const geojson = {
        type: 'FeatureCollection',
        features
      };
      
      setScanResult({
        count: mockCount,
        totalArea: mockTotalArea,
        geojson
      });
      setIsScanning(false);
    }, 3000);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden' }}>
      
      <Sidebar 
        isOpen={isSidebarOpen} 
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        zoneAreaHa={zoneAreaHa}
        isScanning={isScanning}
        scanResult={scanResult}
        onScan={handleScanZone}
        savedZones={savedZones}
        onSaveZone={handleSaveZone}
        onLoadZone={handleLoadZone}
        canSave={zoneAreaHa > 0 && currentGeoJSON !== null}
        activeZoneId={activeZoneId}
        activeZoneName={activeZoneId ? savedZones.find(z => z.id === activeZoneId)?.name || '' : ''}
        onUpdateZone={handleUpdateZone}
        onCancelEdit={handleCancelEdit}
        onDeleteZone={handleDeleteZone}
        plasticPercent={plasticPercent}
        onPlasticPercentChange={setPlasticPercent}
      />

      <MapComponent 
        onZoneUpdate={handleZoneUpdate} 
        zoneToLoad={zoneToLoad} 
        scanResult={scanResult}
      />
      
    </div>
  );
}

export default App;
