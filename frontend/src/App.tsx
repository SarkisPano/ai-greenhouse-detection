import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { supabase, API_BASE_URL } from './supabaseClient';
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

const extractZonePolygonGeometry = (geojson: any): any => {
  if (!geojson) return null;
  if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
    return geojson;
  }
  if (geojson.type === 'Feature') {
    return geojson.geometry;
  }
  if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
    const polyFeat = geojson.features.find(
      (f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
    );
    return polyFeat ? polyFeat.geometry : (geojson.features[0]?.geometry || null);
  }
  return null;
};

const getPolygonCentroidLatLon = (geometry: any): { lat: number; lon: number } | null => {
  try {
    let ring: number[][] = [];
    if (geometry?.type === 'Polygon' && geometry.coordinates?.[0]) {
      ring = geometry.coordinates[0];
    } else if (geometry?.type === 'MultiPolygon' && geometry.coordinates?.[0]?.[0]) {
      ring = geometry.coordinates[0][0];
    }
    if (!ring || ring.length === 0) return null;
    const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
    const sumLon = pts.reduce((acc, p) => acc + p[0], 0);
    const sumLat = pts.reduce((acc, p) => acc + p[1], 0);
    return {
      lon: sumLon / pts.length,
      lat: sumLat / pts.length
    };
  } catch {
    return null;
  }
};

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Estado de la Zona actual
  const [zoneAreaHa, setZoneAreaHa] = useState<number>(0);
  const [currentGeoJSON, setCurrentGeoJSON] = useState<any>(null);
  const [zoneToLoad, setZoneToLoad] = useState<{ geojson: any, timestamp: number } | null>(null);
  
  // Estado de Edición
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const activeZoneIdRef = useRef<string | null>(null);
  activeZoneIdRef.current = activeZoneId;
  
  // Estado del Escaneo y Edición Interactiva
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ percent: number; text: string } | null>(null);
  const [rawScanResult, setRawScanResult] = useState<ScanResult | null>(null);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(40);
  const [isAddingManual, setIsAddingManual] = useState<boolean>(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  
  // Estado de la Calculadora de Material
  const [plasticPercent, setPlasticPercent] = useState<number>(0);

  // Estado de la Librería de Proyectos (Supabase)
  const [savedZones, setSavedZones] = useState<SavedZone[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentScanIdRef = useRef<string | null>(null);

  const handleCancelScan = useCallback(async () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    const scanId = currentScanIdRef.current;
    if (scanId) {
      try {
        await supabase
          .from('ai_scans')
          .update({ status: 'cancelled' })
          .eq('id', scanId);
      } catch (err) {
        console.error('Error cancelling scan:', err);
      }
      currentScanIdRef.current = null;
    }
    setIsScanning(false);
    setScanProgress(null);
  }, []);

  const fetchZones = useCallback(async () => {
    const { data, error } = await supabase
      .from('zones')
      .select('id, name, area_ha, plastic_percent, created_at, geom')
      .order('created_at', { ascending: false });
    if (!error && data) {
      setSavedZones(data.map(z => ({
        id: z.id,
        name: z.name,
        areaHa: Number(z.area_ha),
        plasticPercent: Number(z.plastic_percent),
        date: new Date(z.created_at).toLocaleDateString(),
        geojson: z.geom
      })));
    } else if (error) {
      console.error('Error fetching zones:', error);
    }
  }, []);

  useEffect(() => {
    fetchZones();
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchZones]);

  const ensureFeatureIds = (features: any[]) => {
    return (features || []).map((f: any, idx: number) => {
      const rawId = (f.properties?.id !== undefined && f.properties?.id !== null && f.properties?.id !== '')
        ? f.properties.id
        : ((f.id !== undefined && f.id !== null && f.id !== '') ? f.id : `feat_${idx}_${Date.now()}`);
      const id = String(rawId);
      return {
        ...f,
        id,
        properties: {
          ...f.properties,
          id
        }
      };
    });
  };

  const persistScanToDb = useCallback(async (zoneId: string, scanToSave: ScanResult) => {
    try {
      setAutoSaveStatus('saving');
      const { data: existingScan } = await supabase
        .from('ai_scans')
        .select('id')
        .eq('zone_id', zoneId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingScan) {
        await supabase.from('ai_scans').update({
          total_area_detected: scanToSave.totalArea,
          detection_count: scanToSave.count,
          result_geojson: scanToSave.geojson,
          completed_at: new Date().toISOString()
        }).eq('id', existingScan.id);
      } else {
        await supabase.from('ai_scans').insert({
          zone_id: zoneId,
          status: 'completed',
          total_area_detected: scanToSave.totalArea,
          detection_count: scanToSave.count,
          result_geojson: scanToSave.geojson,
          completed_at: new Date().toISOString()
        });
      }
      setAutoSaveStatus('saved');
    } catch (err) {
      console.error('Error autoguardando escaneo:', err);
      setAutoSaveStatus('idle');
    }
  }, []);

  // Resultado de escaneo filtrado dinámicamente según el umbral de confianza, con numeración correlativa (#1, #2...)
  const scanResult = useMemo<ScanResult | null>(() => {
    if (!rawScanResult || !rawScanResult.geojson) return null;
    const allFeatures = rawScanResult.geojson.features || [];
    const filteredFeatures = allFeatures
      .filter((f: any) => {
        if (f.properties?.isManual) return true; // Adiciones manuales siempre se conservan
        const conf = f.properties?.confidence ?? 0;
        return conf >= confidenceThreshold;
      })
      .map((f: any, idx: number) => ({
        ...f,
        properties: {
          ...f.properties,
          displayIndex: idx + 1
        }
      }));
    const totalArea = filteredFeatures.reduce((sum: number, f: any) => sum + (f.properties?.area_m2 || 0), 0);
    return {
      count: filteredFeatures.length,
      totalArea: Math.round(totalArea * 10) / 10,
      geojson: {
        ...rawScanResult.geojson,
        features: filteredFeatures
      }
    };
  }, [rawScanResult, confidenceThreshold]);

  const handleDeleteDetection = useCallback((featureId: string) => {
    const targetId = String(featureId);
    setRawScanResult(prev => {
      if (!prev || !prev.geojson) return null;
      const currentFeatures = prev.geojson.features || [];
      const newFeatures = currentFeatures.filter((f: any) => {
        const rawFid = (f.properties?.id !== undefined && f.properties?.id !== null && f.properties?.id !== '')
          ? f.properties.id
          : f.id;
        const fid = String(rawFid ?? '');
        return fid !== targetId;
      });
      const newTotalArea = newFeatures.reduce((sum: number, f: any) => sum + (f.properties?.area_m2 || 0), 0);
      const nextRaw: ScanResult = {
        ...prev,
        count: newFeatures.length,
        totalArea: Math.round(newTotalArea * 10) / 10,
        geojson: {
          ...prev.geojson,
          features: newFeatures
        }
      };
      if (activeZoneIdRef.current) {
        persistScanToDb(activeZoneIdRef.current, nextRaw);
      }
      return nextRaw;
    });
  }, [persistScanToDb]);

  const handleManualDetectionAdded = useCallback((feature: any) => {
    const rawId = (feature.properties?.id !== undefined && feature.properties?.id !== null && feature.properties?.id !== '')
      ? feature.properties.id
      : ((feature.id !== undefined && feature.id !== null && feature.id !== '') ? feature.id : `manual_${Date.now()}`);
    const cleanId = String(rawId);
    const normalizedFeature = {
      ...feature,
      id: cleanId,
      properties: {
        ...feature.properties,
        id: cleanId
      }
    };
    setRawScanResult(prev => {
      const currentFeatures = prev?.geojson?.features ? [...prev.geojson.features] : [];
      const updatedFeatures = [...currentFeatures, normalizedFeature];
      const newTotalArea = updatedFeatures.reduce((sum: number, f: any) => sum + (f.properties?.area_m2 || 0), 0);
      const nextRaw: ScanResult = {
        count: updatedFeatures.length,
        totalArea: Math.round(newTotalArea * 10) / 10,
        geojson: {
          type: 'FeatureCollection',
          features: updatedFeatures
        }
      };
      if (activeZoneIdRef.current) {
        persistScanToDb(activeZoneIdRef.current, nextRaw);
      }
      return nextRaw;
    });
    setIsAddingManual(false);
  }, [persistScanToDb]);

  const handlePlasticPercentChange = useCallback(async (val: number) => {
    setPlasticPercent(val);
    if (activeZoneIdRef.current) {
      setAutoSaveStatus('saving');
      const { error } = await supabase
        .from('zones')
        .update({ plastic_percent: val })
        .eq('id', activeZoneIdRef.current);
      if (!error) {
        setAutoSaveStatus('saved');
        fetchZones();
      }
    }
  }, [fetchZones]);

  const handleZoneUpdate = useCallback((areaHectares: number, geojson: any) => {
    setZoneAreaHa(areaHectares);
    setCurrentGeoJSON(geojson);
    setRawScanResult(null);
    setAutoSaveStatus('idle');
  }, []);

  const handleSaveZone = async (name: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (!geom || zoneAreaHa === 0) return;
    
    // 1. Guardar la Zona
    const { data: zoneData, error: zoneError } = await supabase.from('zones').insert({
      name,
      area_ha: zoneAreaHa,
      plastic_percent: plasticPercent,
      geom
    }).select().single();

    if (zoneError || !zoneData) {
      console.error('Error saving zone:', zoneError);
      return;
    }
    
    // 2. Si había un escaneo previo en memoria, persistir el resultado completo (rawScanResult)
    if (rawScanResult) {
      await persistScanToDb(zoneData.id, rawScanResult);
    }
    
    await fetchZones();
    setActiveZoneId(zoneData.id);
  };

  const handleUpdateZone = async (name: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (!activeZoneId || !geom || zoneAreaHa === 0) return;
    
    const { error } = await supabase.from('zones').update({
      name,
      area_ha: zoneAreaHa,
      plastic_percent: plasticPercent,
      geom
    }).eq('id', activeZoneId);

    if (error) {
      console.error('Error updating zone:', error);
      return;
    }

    // Persistir siempre rawScanResult (sin amputar las detecciones ocultas por el slider de confianza)
    if (rawScanResult) {
      await persistScanToDb(activeZoneId, rawScanResult);
    }
    
    await fetchZones();
  };

  const handleLoadZone = async (zone: SavedZone) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setIsScanning(false);
    setScanProgress(null);
    setAutoSaveStatus('idle');
    setActiveZoneId(zone.id);
    const featureCollection = zone.geojson.type === 'FeatureCollection' ? zone.geojson : {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: zone.geojson, properties: {} }]
    };
    setZoneToLoad({ geojson: featureCollection, timestamp: Date.now() });
    setZoneAreaHa(zone.areaHa);
    setCurrentGeoJSON(featureCollection);
    setPlasticPercent(zone.plasticPercent || 0);
    setRawScanResult(null); 

    // Recuperar el resultado del escaneo de la base de datos si existe
    const { data, error } = await supabase
      .from('ai_scans')
      .select('detection_count, total_area_detected, result_geojson')
      .eq('zone_id', zone.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data && !error) {
      const feats = ensureFeatureIds(data.result_geojson?.features || []);
      setRawScanResult({
        count: data.detection_count,
        totalArea: data.total_area_detected,
        geojson: {
          ...data.result_geojson,
          features: feats
        }
      });
    }
  };

  const handleCancelEdit = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setIsScanning(false);
    setScanProgress(null);
    setAutoSaveStatus('idle');
    setActiveZoneId(null);
    setZoneAreaHa(0);
    setCurrentGeoJSON(null);
    setZoneToLoad({ geojson: { type: 'FeatureCollection', features: [] }, timestamp: Date.now() });
    setPlasticPercent(0);
    setRawScanResult(null);
  };

  const handleDeleteZone = async (id: string) => {
    const { error } = await supabase.from('zones').delete().eq('id', id);
    if (!error) {
      if (activeZoneId === id) {
        handleCancelEdit();
      }
      await fetchZones();
    }
  };

  const handleScanZone = async (draftName?: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (zoneAreaHa === 0 || !geom) return;
    
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    setIsScanning(true);
    setScanProgress({ percent: 5, text: 'Preparando zona y conectando con el motor IA...' });
    setRawScanResult(null);
    setAutoSaveStatus('idle');

    // 1. Si la zona aún no fue guardada, la autoguardamos en Supabase para ejecutar siempre el motor IA real
    let targetZoneId = activeZoneId;
    if (!targetZoneId) {
      const autoName = draftName && draftName.trim() !== ''
        ? draftName.trim()
        : `Zona ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      const { data: newZone, error: saveErr } = await supabase.from('zones').insert({
        name: autoName,
        area_ha: zoneAreaHa,
        plastic_percent: plasticPercent,
        geom
      }).select().single();

      if (saveErr || !newZone) {
        console.error('Error auto-saving zone before scan:', saveErr);
        alert('No se pudo guardar la zona para iniciar el escaneo.');
        setIsScanning(false);
        setScanProgress(null);
        return;
      }

      targetZoneId = newZone.id;
      setActiveZoneId(newZone.id);
      await fetchZones();
    }

    // 2. Crear el registro de escaneo en ai_scans
    const { data, error } = await supabase.from('ai_scans').insert({
      zone_id: targetZoneId,
      status: 'processing'
    }).select().single();
    
    if (error || !data) {
      console.error("Error creating AI Scan:", error);
      alert("No se pudo iniciar el registro de escaneo en la base de datos.");
      setIsScanning(false);
      setScanProgress(null);
      return;
    }

    const scanId = data.id;
    currentScanIdRef.current = scanId;
    
    // 3. Llamar al motor de IA en Python
    try {
      await fetch(`${API_BASE_URL}/webhook/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'INSERT',
          table: 'ai_scans',
          record: { id: scanId, status: 'processing', zone_id: targetZoneId }
        })
      });
      
      // Iniciar polling para ver el progreso en tiempo real y cuándo termina
      pollIntervalRef.current = setInterval(async () => {
        const { data: scanCheck } = await supabase
          .from('ai_scans')
          .select('status, detection_count, total_area_detected, result_geojson')
          .eq('id', scanId)
          .single();

        if (!scanCheck) return;

        if (scanCheck.status === 'processing' && scanCheck.result_geojson?.progress) {
          setScanProgress(scanCheck.result_geojson.progress);
        } else if (scanCheck.status === 'completed') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          currentScanIdRef.current = null;
          const feats = ensureFeatureIds(scanCheck.result_geojson?.features || []);
          setRawScanResult({
            count: scanCheck.detection_count,
            totalArea: scanCheck.total_area_detected,
            geojson: {
              ...scanCheck.result_geojson,
              features: feats
            }
          });
          setScanProgress(null);
          setIsScanning(false);
        } else if (scanCheck.status === 'failed' || scanCheck.status === 'cancelled') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          currentScanIdRef.current = null;
          setScanProgress(null);
          setIsScanning(false);
          if (scanCheck.status === 'failed') {
            alert("Ocurrió un error al procesar el escaneo de IA. Por favor intentá nuevamente.");
          }
        }
      }, 1500);
    } catch (e) {
      console.error("Error calling AI Engine:", e);
      alert("No se pudo conectar con el motor de Inteligencia Artificial.");
      currentScanIdRef.current = null;
      setScanProgress(null);
      setIsScanning(false);
    }
  };

  const handleExportExcel = () => {
    if (!scanResult) return;
    
    const zoneName = activeZoneId ? (savedZones.find(z => z.id === activeZoneId)?.name || "Sin_nombre") : "Nueva_Zona";
    const totalLona = Math.round(scanResult.totalArea * (1 + plasticPercent / 100));
    
    // 1. Datos del Resumen
    const summaryData = [
      {
        "Nombre de Zona": zoneName,
        "Fecha de Reporte": new Date().toLocaleDateString(),
        "Área Escaneada (ha)": Number(zoneAreaHa.toFixed(2)),
        "Filtro de Confianza IA": `>= ${confidenceThreshold}%`,
        "Invernaderos Contabilizados": scanResult.count,
        "Área Total Cubierta (m²)": Number(scanResult.totalArea.toFixed(1)),
        "Margen de Lona Aplicado": `+${plasticPercent}%`,
        "Lona Total Estimada (m²)": totalLona
      }
    ];

    // 2. Datos Detallados de Invernaderos (numeración idéntica a la del mapa #1, #2...)
    const features = scanResult.geojson?.features || [];
    const detailsData = features.map((f: any, index: number) => {
      const displayIdx = f.properties?.displayIndex ?? (index + 1);
      const isManual = Boolean(f.properties?.isManual);
      const origen = isManual ? "Agregado Manual" : "Detectado por IA";
      const conf = isManual ? "100% (Manual)" : (f.properties?.confidence ? `${f.properties.confidence}%` : "N/A");
      const rawArea = Number(f.properties?.area_m2 || (scanResult.totalArea / Math.max(1, scanResult.count)));
      const areaM2 = Number(rawArea.toFixed(1));
      const lonaIndividualM2 = Math.round(rawArea * (1 + plasticPercent / 100));
      const center = getPolygonCentroidLatLon(f.geometry);
      const coordsText = center ? `${center.lat.toFixed(6)}, ${center.lon.toFixed(6)}` : "N/A";
      const mapsUrl = center ? `https://www.google.com/maps?q=${center.lat.toFixed(6)},${center.lon.toFixed(6)}` : "";
      
      return {
        "N° Invernadero": `#${displayIdx}`,
        "Origen": origen,
        "Confianza IA": conf,
        "Superficie Huella (m²)": areaM2,
        "Lona Estimada (m²)": lonaIndividualM2,
        "Coordenadas GPS (Lat, Lon)": coordsText,
        "Ubicación Google Maps": mapsUrl
      };
    });

    // Crear libro de trabajo con anchos de columna prolijos
    const wb = XLSX.utils.book_new();
    
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary['!cols'] = [
      { wch: 24 },
      { wch: 16 },
      { wch: 20 },
      { wch: 22 },
      { wch: 26 },
      { wch: 24 },
      { wch: 22 },
      { wch: 24 }
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen");

    if (detailsData.length > 0) {
      const wsDetails = XLSX.utils.json_to_sheet(detailsData);
      wsDetails['!cols'] = [
        { wch: 16 },
        { wch: 18 },
        { wch: 16 },
        { wch: 22 },
        { wch: 20 },
        { wch: 26 },
        { wch: 48 }
      ];
      XLSX.utils.book_append_sheet(wb, wsDetails, "Detalle Invernaderos");
    }

    const fileName = `Reporte_${zoneName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, fileName);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden' }}>
      
      <Sidebar 
        isOpen={isSidebarOpen} 
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        zoneAreaHa={zoneAreaHa}
        isScanning={isScanning}
        scanProgress={scanProgress}
        scanResult={scanResult}
        confidenceThreshold={confidenceThreshold}
        onConfidenceThresholdChange={setConfidenceThreshold}
        isAddingManual={isAddingManual}
        onToggleAddManual={() => setIsAddingManual(prev => !prev)}
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
        onPlasticPercentChange={handlePlasticPercentChange}
        autoSaveStatus={autoSaveStatus}
        onExportExcel={handleExportExcel}
        onCancelScan={handleCancelScan}
      />

      <MapComponent 
        onZoneUpdate={handleZoneUpdate} 
        zoneToLoad={zoneToLoad}
        scanResult={scanResult}
        plasticPercent={plasticPercent}
        onDeleteDetection={handleDeleteDetection}
        isAddingManual={isAddingManual}
        onManualDetectionAdded={handleManualDetectionAdded}
        onCancelAddManual={() => setIsAddingManual(false)}
        isScanning={isScanning}
        scanProgress={scanProgress}
        onCancelScan={handleCancelScan}
      />
    </div>
  );
}

export default App;
