import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { supabase, API_BASE_URL } from './supabaseClient';
import MapComponent from './components/Map/Map';
import Sidebar from './components/Sidebar/Sidebar';
import { useIsMobile } from './useIsMobile';

export interface ScanResult {
  count: number;
  totalArea: number;
  newCount?: number;
  comparedWithPrevious?: boolean;
  geojson?: any;
}

export interface SavedZone {
  id: string;
  name: string;
  rawName: string;
  townName: string;
  areaHa: number;
  date: string;
  createdAtIso: string;
  geojson: any; // Coordenadas del polígono
  plasticPercent?: number; // Porcentaje de lona elegido
  lastScanCount?: number;
  lastScanNewCount?: number;
  lastScanAreaM2?: number;
  lastScanDate?: string | null;
}

export interface TownMetrics {
  name: string;
  catalogZoneId?: string;
  zonesCount: number;
  scansCount: number;
  lastZone: SavedZone | null;
  lastScanDate: string | null;
  totalGreenhouses: number;
  newGreenhouses: number;
  totalAreaM2: number;
  totalAreaHa: number;
  totalLonaM2: number;
  totalLonaHa: number;
  scannedAreaHa: number;
  center?: [number, number];
}

export const formatAreaHa = (m2: number): string => {
  const ha = (Number(m2) || 0) / 10000;
  if (ha > 0 && ha < 0.1) {
    return ha.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }
  return ha.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const parseZoneAndTownName = (rawName: string): { isTownCatalog: boolean; townName: string; cleanZoneName: string } => {
  const trimmed = (rawName || '').trim();
  if (trimmed.startsWith('[PUEBLO] ')) {
    const tName = trimmed.slice(9).trim();
    return { isTownCatalog: true, townName: tName, cleanZoneName: tName };
  }
  const match = trimmed.match(/^\[Pueblo:\s*(.+?)\]\s*(.*)$/i);
  if (match) {
    const tName = match[1].trim();
    const clean = (match[2] || '').trim() || tName;
    return { isTownCatalog: false, townName: tName, cleanZoneName: clean };
  }
  return { isTownCatalog: false, townName: '', cleanZoneName: trimmed };
};

const formatZoneNameWithTown = (cleanZoneName: string, townName?: string): string => {
  const clean = parseZoneAndTownName(cleanZoneName).cleanZoneName || cleanZoneName.trim();
  const town = (townName || '').trim();
  if (town) {
    return `[Pueblo: ${town}] ${clean}`;
  }
  return clean;
};

const ACTIVE_SCAN_STORAGE_KEY = 'super_active_scan';
const NOTIFY_EMAIL_STORAGE_KEY = 'super_notify_email';

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
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768;
    }
    return true;
  });

  // Si la pantalla pasa a mobile (ej: al achicar la ventana o activar DevTools),
  // cerramos el panel lateral para que el mapa satelital quede visible al instante.
  const prevIsMobileRef = useRef(isMobile);
  useEffect(() => {
    if (isMobile && !prevIsMobileRef.current) {
      setIsSidebarOpen(false);
    }
    prevIsMobileRef.current = isMobile;
  }, [isMobile]);
  
  // Estado de la Zona actual
  const [zoneAreaHa, setZoneAreaHa] = useState<number>(0);
  const [currentGeoJSON, setCurrentGeoJSON] = useState<any>(null);
  const [zoneToLoad, setZoneToLoad] = useState<{ geojson: any; customLabels?: any[]; timestamp: number } | null>(null);
  const [flyToTarget, setFlyToTarget] = useState<{ center: [number, number]; zoom?: number; timestamp: number } | null>(null);
  
  // Estado de Edición y Pueblos
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const activeZoneIdRef = useRef<string | null>(null);
  activeZoneIdRef.current = activeZoneId;
  const [selectedTown, setSelectedTown] = useState<string>('');
  const selectedTownRef = useRef<string>('');
  selectedTownRef.current = selectedTown;
  const [towns, setTowns] = useState<TownMetrics[]>([]);
  const customLabelsRef = useRef<any[]>([]);
  
  // Estado del Escaneo y Edición Interactiva
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ percent: number; text: string } | null>(null);
  const [rawScanResult, setRawScanResult] = useState<ScanResult | null>(null);
  const rawScanResultRef = useRef<ScanResult | null>(null);
  rawScanResultRef.current = rawScanResult;
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(40);
  const [filterMode, setFilterMode] = useState<'all' | 'new'>('all');
  const [isAddingManual, setIsAddingManual] = useState<boolean>(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [isSwipeDrawing, setIsSwipeDrawing] = useState(false);
  const [frameViewTrigger, setFrameViewTrigger] = useState(0);
  const [notifyEmail, setNotifyEmail] = useState<string>(() => {
    try {
      return localStorage.getItem(NOTIFY_EMAIL_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [notifyEmailSavedMsg, setNotifyEmailSavedMsg] = useState<string>('');
  
  // Estado de la Calculadora de Material
  const [plasticPercent, setPlasticPercent] = useState<number>(0);

  // Estado de la Librería de Proyectos (Supabase)
  const [savedZones, setSavedZones] = useState<SavedZone[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentScanIdRef = useRef<string | null>(null);
  const startingNewZoneRef = useRef<boolean>(false);

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFY_EMAIL_STORAGE_KEY, notifyEmail);
    } catch {
      // ignore storage errors
    }
  }, [notifyEmail]);

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
    try {
      localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
    } catch {
      // ignore
    }
    setIsScanning(false);
    setScanProgress(null);
  }, []);

  const fetchZones = useCallback(async () => {
    const [{ data: zonesData, error: zonesError }, { data: scansData }] = await Promise.all([
      supabase
        .from('zones')
        .select('id, name, area_ha, plastic_percent, created_at, geom')
        .order('created_at', { ascending: false }),
      supabase
        .from('ai_scans')
        .select('id, zone_id, status, detection_count, total_area_detected, result_geojson, completed_at')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(500)
    ]);

    if (zonesError || !zonesData) {
      if (zonesError) console.error('Error fetching zones:', zonesError);
      return;
    }

    const latestScanByZone = new Map<string, any>();
    const scanCountByZone = new Map<string, number>();
    (scansData || []).forEach((s: any) => {
      if (!s.zone_id) return;
      scanCountByZone.set(s.zone_id, (scanCountByZone.get(s.zone_id) || 0) + 1);
      if (!latestScanByZone.has(s.zone_id)) {
        latestScanByZone.set(s.zone_id, s);
      }
    });

    const catalogTowns = new Map<string, { id: string; name: string; center?: [number, number] }>();
    const parsedZones: SavedZone[] = [];

    zonesData.forEach((z: any) => {
      const parsed = parseZoneAndTownName(z.name);
      const latestScan = latestScanByZone.get(z.id);
      const scanTownName = (latestScan?.result_geojson?.town_name || '').trim();
      const effectiveTown = parsed.townName || scanTownName;

      if (parsed.isTownCatalog) {
        const key = parsed.townName.toLowerCase();
        const geom = extractZonePolygonGeometry(z.geom);
        const centerObj = geom ? getPolygonCentroidLatLon(geom) : null;
        if (key && !catalogTowns.has(key)) {
          catalogTowns.set(key, {
            id: z.id,
            name: parsed.townName,
            center: centerObj ? [centerObj.lon, centerObj.lat] : undefined
          });
        }
        return;
      }

      parsedZones.push({
        id: z.id,
        name: parsed.cleanZoneName || z.name,
        rawName: z.name,
        townName: effectiveTown,
        areaHa: Number(z.area_ha),
        plasticPercent: Number(z.plastic_percent),
        date: new Date(z.created_at).toLocaleDateString(),
        createdAtIso: z.created_at,
        geojson: z.geom,
        lastScanCount: latestScan ? Number(latestScan.detection_count || 0) : undefined,
        lastScanNewCount: latestScan ? Number(latestScan.result_geojson?.new_count || 0) : undefined,
        lastScanAreaM2: latestScan ? Number(latestScan.total_area_detected || 0) : undefined,
        lastScanDate: latestScan?.completed_at || null
      });
    });

    setSavedZones(parsedZones);

    // Consolidar métricas por pueblo
    const townMap = new Map<string, TownMetrics>();
    catalogTowns.forEach((cat, key) => {
      townMap.set(key, {
        name: cat.name,
        catalogZoneId: cat.id,
        zonesCount: 0,
        scansCount: 0,
        lastZone: null,
        lastScanDate: null,
        totalGreenhouses: 0,
        newGreenhouses: 0,
        totalAreaM2: 0,
        totalAreaHa: 0,
        totalLonaM2: 0,
        totalLonaHa: 0,
        scannedAreaHa: 0,
        center: cat.center
      });
    });

    parsedZones.forEach((z) => {
      if (!z.townName) return;
      const key = z.townName.toLowerCase();
      if (!townMap.has(key)) {
        const geom = extractZonePolygonGeometry(z.geojson);
        const centerObj = geom ? getPolygonCentroidLatLon(geom) : null;
        townMap.set(key, {
          name: z.townName,
          zonesCount: 0,
          scansCount: 0,
          lastZone: null,
          lastScanDate: null,
          totalGreenhouses: 0,
          newGreenhouses: 0,
          totalAreaM2: 0,
          totalAreaHa: 0,
          totalLonaM2: 0,
          totalLonaHa: 0,
          scannedAreaHa: 0,
          center: centerObj ? [centerObj.lon, centerObj.lat] : undefined
        });
      }

      const tm = townMap.get(key)!;
      tm.zonesCount += 1;
      tm.scansCount += scanCountByZone.get(z.id) || 0;
      tm.scannedAreaHa += z.areaHa || 0;

      if (z.lastScanAreaM2 !== undefined) {
        const areaM2 = z.lastScanAreaM2 || 0;
        const lonaM2 = Math.round(areaM2 * (1 + (z.plasticPercent || 0) / 100));
        tm.totalGreenhouses += z.lastScanCount || 0;
        tm.newGreenhouses += z.lastScanNewCount || 0;
        tm.totalAreaM2 += areaM2;
        tm.totalLonaM2 += lonaM2;
      }

      const zBestDate = z.lastScanDate || z.createdAtIso;
      if (!tm.lastZone) {
        tm.lastZone = z;
        tm.lastScanDate = z.lastScanDate || null;
      } else {
        const prevBest = tm.lastScanDate || tm.lastZone.createdAtIso;
        if (zBestDate > prevBest) {
          tm.lastZone = z;
          tm.lastScanDate = z.lastScanDate || null;
        }
      }

      if (!tm.center) {
        const geom = extractZonePolygonGeometry(z.geojson);
        const centerObj = geom ? getPolygonCentroidLatLon(geom) : null;
        if (centerObj) tm.center = [centerObj.lon, centerObj.lat];
      }
    });

    const computedTowns = Array.from(townMap.values()).map((tm) => ({
      ...tm,
      totalAreaHa: tm.totalAreaM2 / 10000,
      totalLonaHa: tm.totalLonaM2 / 10000
    }));

    computedTowns.sort((a, b) => {
      const da = a.lastScanDate || a.lastZone?.createdAtIso || '';
      const db = b.lastScanDate || b.lastZone?.createdAtIso || '';
      if (da !== db) return db.localeCompare(da);
      return a.name.localeCompare(b.name);
    });

    setTowns(computedTowns);
  }, []);

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
      const payloadGeojson = {
        ...(scanToSave.geojson || { type: 'FeatureCollection', features: [] }),
        town_name: selectedTownRef.current || scanToSave.geojson?.town_name || '',
        custom_labels: customLabelsRef.current || scanToSave.geojson?.custom_labels || [],
        new_count: scanToSave.newCount ?? scanToSave.geojson?.new_count ?? 0,
        compared_with_previous: scanToSave.comparedWithPrevious ?? scanToSave.geojson?.compared_with_previous ?? false
      };

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
          result_geojson: payloadGeojson,
          completed_at: new Date().toISOString()
        }).eq('id', existingScan.id);
      } else {
        await supabase.from('ai_scans').insert({
          zone_id: zoneId,
          status: 'completed',
          total_area_detected: scanToSave.totalArea,
          detection_count: scanToSave.count,
          result_geojson: payloadGeojson,
          completed_at: new Date().toISOString()
        });
      }
      setAutoSaveStatus('saved');
    } catch (err) {
      console.error('Error autoguardando escaneo:', err);
      setAutoSaveStatus('idle');
    }
  }, []);

  const startScanPolling = useCallback((scanId: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    currentScanIdRef.current = scanId;

    const checkOnce = async () => {
      const { data: scanCheck } = await supabase
        .from('ai_scans')
        .select('status, detection_count, total_area_detected, result_geojson')
        .eq('id', scanId)
        .single();

      if (!scanCheck) return;

      if (scanCheck.status === 'processing') {
        if (scanCheck.result_geojson?.progress) {
          setScanProgress(scanCheck.result_geojson.progress);
        }
        const partialFeats = scanCheck.result_geojson?.features;
        if (Array.isArray(partialFeats) && partialFeats.length > 0) {
          const normalized = ensureFeatureIds(partialFeats);
          setRawScanResult({
            count: scanCheck.detection_count || normalized.length,
            totalArea: Number(scanCheck.total_area_detected || 0),
            geojson: {
              ...scanCheck.result_geojson,
              features: normalized
            }
          });
        }
      } else if (scanCheck.status === 'completed') {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        currentScanIdRef.current = null;
        try {
          localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
        } catch {
          // ignore
        }
        const feats = ensureFeatureIds(scanCheck.result_geojson?.features || []);
        const newCount = Number(
          scanCheck.result_geojson?.new_count ??
          feats.filter((f: any) => f.properties?.isNew).length
        );
        const comparedWithPrevious = Boolean(scanCheck.result_geojson?.compared_with_previous);
        if (Array.isArray(scanCheck.result_geojson?.custom_labels)) {
          customLabelsRef.current = scanCheck.result_geojson.custom_labels;
        }
        setRawScanResult({
          count: scanCheck.detection_count,
          totalArea: scanCheck.total_area_detected,
          newCount,
          comparedWithPrevious,
          geojson: {
            ...scanCheck.result_geojson,
            features: feats
          }
        });
        setScanProgress(null);
        setIsScanning(false);
        setNotifyEmailSavedMsg('');
        fetchZones();
      } else if (scanCheck.status === 'failed' || scanCheck.status === 'cancelled') {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        currentScanIdRef.current = null;
        try {
          localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
        } catch {
          // ignore
        }
        setScanProgress(null);
        setIsScanning(false);
        setNotifyEmailSavedMsg('');
        if (scanCheck.status === 'failed') {
          alert("Ocurrió un error al procesar el escaneo de IA. Por favor intentá nuevamente.");
        }
      }
    };

    checkOnce();
    pollIntervalRef.current = setInterval(checkOnce, 2000);
  }, [fetchZones]);

  useEffect(() => {
    fetchZones();

    // Si el usuario cerró la app mientras corría un escaneo largo de un pueblo, retomarlo automáticamente
    const resumePendingScan = async () => {
      try {
        const raw = localStorage.getItem(ACTIVE_SCAN_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed?.scanId || !parsed?.zoneId) return;

        const [{ data: zRow }, { data: sRow }] = await Promise.all([
          supabase.from('zones').select('id, name, area_ha, plastic_percent, geom').eq('id', parsed.zoneId).maybeSingle(),
          supabase.from('ai_scans').select('status, detection_count, total_area_detected, result_geojson').eq('id', parsed.scanId).maybeSingle()
        ]);

        if (!sRow || !zRow) {
          localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
          return;
        }

        if (sRow.status === 'failed' || sRow.status === 'cancelled') {
          localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
          return;
        }

        const parsedName = parseZoneAndTownName(zRow.name);
        const town = parsedName.townName || sRow.result_geojson?.town_name || '';
        setSelectedTown(town);
        setActiveZoneId(zRow.id);
        const featureCollection = zRow.geom?.type === 'FeatureCollection' ? zRow.geom : {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: zRow.geom, properties: {} }]
        };
        const savedLabels = Array.isArray(sRow.result_geojson?.custom_labels) ? sRow.result_geojson.custom_labels : [];
        customLabelsRef.current = savedLabels;
        setZoneToLoad({ geojson: featureCollection, customLabels: savedLabels, timestamp: Date.now() });
        setZoneAreaHa(Number(zRow.area_ha || 0));
        setCurrentGeoJSON(featureCollection);
        setPlasticPercent(Number(zRow.plastic_percent || 0));

        if (sRow.status === 'processing') {
          setIsScanning(true);
          setScanProgress(sRow.result_geojson?.progress || { percent: 10, text: 'Retomando escaneo en curso...' });
          startScanPolling(parsed.scanId);
        } else if (sRow.status === 'completed') {
          const feats = ensureFeatureIds(sRow.result_geojson?.features || []);
          setRawScanResult({
            count: sRow.detection_count,
            totalArea: sRow.total_area_detected,
            newCount: Number(sRow.result_geojson?.new_count ?? feats.filter((f: any) => f.properties?.isNew).length),
            comparedWithPrevious: Boolean(sRow.result_geojson?.compared_with_previous),
            geojson: {
              ...sRow.result_geojson,
              features: feats
            }
          });
          localStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
        }
      } catch {
        // ignore invalid storage
      }
    };

    resumePendingScan();

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchZones, startScanPolling]);

  const handleCustomLabelsChange = useCallback((labels: any[]) => {
    customLabelsRef.current = labels;
    if (activeZoneIdRef.current && rawScanResultRef.current) {
      persistScanToDb(activeZoneIdRef.current, {
        ...rawScanResultRef.current,
        geojson: {
          ...rawScanResultRef.current.geojson,
          custom_labels: labels
        }
      });
    }
  }, [persistScanToDb]);

  // Resultado de escaneo filtrado dinámicamente según umbral de confianza y modo (Todos / Solo Nuevos)
  const scanResult = useMemo<ScanResult | null>(() => {
    if (!rawScanResult || !rawScanResult.geojson) return null;
    const allFeatures = rawScanResult.geojson.features || [];
    const byConfidence = allFeatures.filter((f: any) => {
      if (f.properties?.isManual) return true; // Adiciones manuales siempre se conservan
      const conf = f.properties?.confidence ?? 0;
      return conf >= confidenceThreshold;
    });
    const newFeaturesCount = byConfidence.filter((f: any) => Boolean(f.properties?.isNew)).length;
    const finalFiltered = (filterMode === 'new' && rawScanResult.comparedWithPrevious)
      ? byConfidence.filter((f: any) => Boolean(f.properties?.isNew))
      : byConfidence;

    const indexedFeatures = finalFiltered.map((f: any, idx: number) => ({
      ...f,
      properties: {
        ...f.properties,
        displayIndex: idx + 1
      }
    }));
    const totalArea = indexedFeatures.reduce((sum: number, f: any) => sum + (f.properties?.area_m2 || 0), 0);
    return {
      count: indexedFeatures.length,
      totalArea: Math.round(totalArea * 10) / 10,
      newCount: newFeaturesCount,
      comparedWithPrevious: Boolean(rawScanResult.comparedWithPrevious),
      geojson: {
        ...rawScanResult.geojson,
        features: indexedFeatures
      }
    };
  }, [rawScanResult, confidenceThreshold, filterMode]);

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

  const handleZoneUpdate = useCallback((areaHectares: number, geojson: any, isNewZone = false) => {
    setZoneAreaHa(areaHectares);
    setCurrentGeoJSON(geojson);
    // Reiniciar scanResult si la zona se borró por completo o si el usuario trazó explícitamente una zona nueva
    if (areaHectares === 0 || !geojson || isNewZone) {
      setRawScanResult(null);
      setFilterMode('all');
      setAutoSaveStatus('idle');
      if (startingNewZoneRef.current) {
        setActiveZoneId(null);
        startingNewZoneRef.current = false;
      }
    }
  }, []);

  const handleSaveZone = async (name: string, townOverride?: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (!geom || zoneAreaHa === 0) return;

    const effectiveTown = townOverride !== undefined ? townOverride : selectedTownRef.current;
    const storedName = formatZoneNameWithTown(name, effectiveTown);

    // 1. Guardar la Zona
    const { data: zoneData, error: zoneError } = await supabase.from('zones').insert({
      name: storedName,
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

  const handleUpdateZone = async (name: string, townOverride?: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (!activeZoneId || !geom || zoneAreaHa === 0) return;

    const effectiveTown = townOverride !== undefined ? townOverride : selectedTownRef.current;
    const storedName = formatZoneNameWithTown(name, effectiveTown);

    const { error } = await supabase.from('zones').update({
      name: storedName,
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
    await handleCancelScan();
    setAutoSaveStatus('idle');
    setFilterMode('all');
    setActiveZoneId(zone.id);
    setSelectedTown(zone.townName || '');

    const featureCollection = zone.geojson.type === 'FeatureCollection' ? zone.geojson : {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: zone.geojson, properties: {} }]
    };

    // Recuperar el resultado del escaneo de la base de datos si existe
    const { data, error } = await supabase
      .from('ai_scans')
      .select('detection_count, total_area_detected, result_geojson')
      .eq('zone_id', zone.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const savedLabels = (data && !error && Array.isArray(data.result_geojson?.custom_labels))
      ? data.result_geojson.custom_labels
      : [];
    customLabelsRef.current = savedLabels;

    setZoneToLoad({ geojson: featureCollection, customLabels: savedLabels, timestamp: Date.now() });
    setZoneAreaHa(zone.areaHa);
    setCurrentGeoJSON(featureCollection);
    setPlasticPercent(zone.plasticPercent || 0);

    if (data && !error) {
      const feats = ensureFeatureIds(data.result_geojson?.features || []);
      const newCount = Number(
        data.result_geojson?.new_count ?? feats.filter((f: any) => f.properties?.isNew).length
      );
      setRawScanResult({
        count: data.detection_count,
        totalArea: data.total_area_detected,
        newCount,
        comparedWithPrevious: Boolean(data.result_geojson?.compared_with_previous),
        geojson: {
          ...data.result_geojson,
          features: feats
        }
      });
    } else {
      setRawScanResult(null);
    }
  };

  const handleCancelEdit = async () => {
    await handleCancelScan();
    setAutoSaveStatus('idle');
    setFilterMode('all');
    setActiveZoneId(null);
    setZoneAreaHa(0);
    setCurrentGeoJSON(null);
    customLabelsRef.current = [];
    setZoneToLoad({ geojson: { type: 'FeatureCollection', features: [] }, customLabels: [], timestamp: Date.now() });
    setPlasticPercent(0);
    setRawScanResult(null);
  };

  const handleDeleteZone = async (id: string) => {
    const target = savedZones.find(z => z.id === id);
    const label = target?.name ? `"${target.name}"` : 'esta zona';
    if (!window.confirm(`¿Estás seguro de que querés eliminar ${label} y su historial de escaneos?`)) {
      return;
    }
    const { error } = await supabase.from('zones').delete().eq('id', id);
    if (!error) {
      if (activeZoneId === id) {
        await handleCancelEdit();
      }
      await fetchZones();
    }
  };

  const handleAddTown = async (townName: string, centerCoords?: [number, number]) => {
    const clean = townName.trim();
    if (!clean) return;

    const existing = towns.find(t => t.name.toLowerCase() === clean.toLowerCase());
    if (existing) {
      await handleSelectTown(existing.name);
      return;
    }

    let coords: [number, number] | undefined = centerCoords;
    if (!coords) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(clean)}&countrycodes=am&format=jsonv2&limit=1`;
        const resp = await fetch(url);
        if (resp.ok) {
          const arr = await resp.json();
          if (Array.isArray(arr) && arr[0]?.lon && arr[0]?.lat) {
            coords = [parseFloat(arr[0].lon), parseFloat(arr[0].lat)];
          }
        }
      } catch {
        // fallback al centro de Armenia
      }
    }
    const [lon, lat] = coords || [44.5136, 40.1811];
    const d = 0.003;
    const geom = {
      type: 'Polygon',
      coordinates: [[
        [lon - d, lat + d],
        [lon + d, lat + d],
        [lon + d, lat - d],
        [lon - d, lat - d],
        [lon - d, lat + d]
      ]]
    };

    const { error } = await supabase.from('zones').insert({
      name: `[PUEBLO] ${clean}`,
      area_ha: 0,
      plastic_percent: 20,
      geom
    });

    if (error) {
      console.error('Error agregando pueblo:', error);
      alert('No se pudo agregar el pueblo a la base de datos.');
      return;
    }

    await fetchZones();
    setSelectedTown(clean);
    setFlyToTarget({ center: [lon, lat], zoom: 13.5, timestamp: Date.now() });
  };

  const handleDeleteTown = async (town: TownMetrics) => {
    if (town.zonesCount > 0) {
      alert(`El pueblo "${town.name}" tiene ${town.zonesCount} zona(s) asociada(s). Eliminá o reasigná sus zonas primero.`);
      return;
    }
    if (!town.catalogZoneId) return;
    if (!window.confirm(`¿Querés quitar el pueblo "${town.name}" de la lista?`)) {
      return;
    }
    const { error } = await supabase.from('zones').delete().eq('id', town.catalogZoneId);
    if (!error) {
      if (selectedTown.toLowerCase() === town.name.toLowerCase()) {
        setSelectedTown('');
      }
      await fetchZones();
    }
  };

  const handleSelectTown = async (townName: string) => {
    const clean = townName.trim();
    setSelectedTown(clean);
    if (!clean) return;

    const foundTown = towns.find(t => t.name.toLowerCase() === clean.toLowerCase());
    if (foundTown?.lastZone) {
      await handleLoadZone(foundTown.lastZone);
      return;
    }

    // Buscar si existe alguna zona en savedZones que coincida aunque no tuviera métricas previas
    const fallbackZone = savedZones.find(z => z.townName.toLowerCase() === clean.toLowerCase());
    if (fallbackZone) {
      await handleLoadZone(fallbackZone);
      return;
    }

    // Pueblo sin escaneos previos: limpiar zona anterior y volar al pueblo para delimitarlo
    await handleCancelEdit();
    setSelectedTown(clean);
    if (foundTown?.center) {
      setFlyToTarget({ center: foundTown.center, zoom: 13.5, timestamp: Date.now() });
    }
  };

  const handleRegisterNotifyEmail = async (email: string) => {
    const clean = email.trim();
    setNotifyEmail(clean);
    if (!clean || !clean.includes('@')) {
      setNotifyEmailSavedMsg('Ingresá un correo válido.');
      return;
    }
    if (currentScanIdRef.current) {
      try {
        const res = await fetch(`${API_BASE_URL}/scans/${currentScanIdRef.current}/notify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: clean })
        });
        if (res.ok) {
          setNotifyEmailSavedMsg(`✓ Te avisaremos a ${clean} al terminar. Podés cerrar la app.`);
          return;
        }
      } catch {
        // fallback directo a Supabase
      }
    }
    setNotifyEmailSavedMsg(`✓ Aviso configurado para ${clean}. Podés salir tranquilo durante el escaneo.`);
  };

  const handleScanZone = async (draftName?: string) => {
    const geom = extractZonePolygonGeometry(currentGeoJSON);
    if (zoneAreaHa === 0 || !geom) return;
    
    if (zoneAreaHa > 1500) {
      alert(`⚠️ La zona seleccionada tiene ${Math.round(zoneAreaHa)} hectáreas.\n\nEl límite máximo por escaneo en lotes es de 1.500 hectáreas (~650 cuadrículas satelitales). Por favor delimitá el pueblo en sectores más acotados.`);
      return;
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // Capturar detecciones previas para comparación diferencial (detectar invernaderos nuevos)
    const previousFeatures = rawScanResultRef.current?.geojson?.features
      ? [...rawScanResultRef.current.geojson.features]
      : [];
    const effectiveTown = selectedTownRef.current.trim();
    const cleanEmail = notifyEmail.trim();

    setIsScanning(true);
    setFilterMode('all');
    setScanProgress({
      percent: 5,
      text: effectiveTown
        ? `Preparando escaneo por lotes de ${effectiveTown}...`
        : 'Preparando zona y conectando con el motor IA...'
    });
    setRawScanResult(null);
    setAutoSaveStatus('idle');
    setNotifyEmailSavedMsg('');

    // 1. Si la zona aún no fue guardada, la autoguardamos en Supabase para ejecutar siempre el motor IA real
    let targetZoneId = activeZoneId;
    if (!targetZoneId) {
      const baseAutoName = draftName && draftName.trim() !== ''
        ? draftName.trim()
        : (effectiveTown
          ? `${effectiveTown} (${new Date().toLocaleDateString()})`
          : `Zona ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      const storedName = formatZoneNameWithTown(baseAutoName, effectiveTown);

      const { data: newZone, error: saveErr } = await supabase.from('zones').insert({
        name: storedName,
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
    } else {
      const currentZoneObj = savedZones.find(z => z.id === targetZoneId);
      const baseName = (draftName && draftName.trim() !== '')
        ? draftName.trim()
        : (currentZoneObj?.name || 'Zona');
      const storedName = formatZoneNameWithTown(baseName, effectiveTown);

      // Sincronizar geometría, pueblo y nombre actual en Supabase para no re-escanear un polígono desactualizado
      const { error: syncErr } = await supabase
        .from('zones')
        .update({
          name: storedName,
          area_ha: zoneAreaHa,
          plastic_percent: plasticPercent,
          geom
        })
        .eq('id', targetZoneId);

      if (syncErr) {
        console.error('Error syncing active zone before scan:', syncErr);
        alert('No se pudo actualizar la zona antes de iniciar el escaneo.');
        setIsScanning(false);
        setScanProgress(null);
        return;
      }
      await fetchZones();
    }

    // 2. Crear el registro de escaneo en ai_scans (incluyendo historial previo, pueblo, labels y email)
    const initialMeta: any = {
      type: 'FeatureCollection',
      features: [],
      town_name: effectiveTown,
      custom_labels: customLabelsRef.current || [],
      notify_email: cleanEmail || undefined,
      previous_features: previousFeatures
    };

    const { data, error } = await supabase.from('ai_scans').insert({
      zone_id: targetZoneId,
      status: 'processing',
      result_geojson: initialMeta
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
    try {
      localStorage.setItem(ACTIVE_SCAN_STORAGE_KEY, JSON.stringify({ scanId, zoneId: targetZoneId }));
    } catch {
      // ignore storage errors
    }
    
    // 3. Notificar al motor de IA (con reintentos silenciosos y fallback autónomo de base de datos)
    const notifyAiEngine = async () => {
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const res = await fetch(`${API_BASE_URL}/webhook/scans`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'INSERT',
              table: 'ai_scans',
              record: { id: scanId, status: 'processing', zone_id: targetZoneId }
            })
          });
          if (res.ok) {
            console.log(`[AI Engine] Notificación despachada con éxito en intento ${attempt}`);
            return;
          }
        } catch (netErr) {
          console.warn(`[AI Engine] Intento HTTP ${attempt}/${maxRetries} demorado, reintentando...`, netErr);
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
      console.log('[AI Engine] Notificación directa demorada; el vigilante autónomo de Supabase procesará el escaneo.');
    };

    notifyAiEngine();
    
    // 4. Iniciar polling en tiempo real (muestra progreso por lotes y detecciones parciales)
    startScanPolling(scanId);
  };

  const handleExportExcel = () => {
    if (!scanResult) return;
    
    const activeZone = activeZoneId ? savedZones.find(z => z.id === activeZoneId) : undefined;
    const zoneName = activeZone?.name || "Nueva_Zona";
    const townLabel = selectedTown || activeZone?.townName || "Sin asignar";
    const totalAreaHa = Number((scanResult.totalArea / 10000).toFixed(3));
    const totalLona = Math.round(scanResult.totalArea * (1 + plasticPercent / 100));
    const totalLonaHa = Number((totalLona / 10000).toFixed(3));
    
    // 1. Datos del Resumen
    const summaryData = [
      {
        "Pueblo / Localidad": townLabel,
        "Nombre de Zona": zoneName,
        "Fecha de Reporte": new Date().toLocaleDateString(),
        "Área Escaneada (ha)": Number(zoneAreaHa.toFixed(2)),
        "Filtro de Confianza IA": `>= ${confidenceThreshold}%`,
        "Invernaderos Contabilizados": scanResult.count,
        "Invernaderos Nuevos": scanResult.comparedWithPrevious ? (scanResult.newCount || 0) : "N/A (Primer escaneo)",
        "Área Total Cubierta (m²)": Number(scanResult.totalArea.toFixed(1)),
        "Área Total Cubierta (ha)": totalAreaHa,
        "Margen de Lona Aplicado": `+${plasticPercent}%`,
        "Lona Total Estimada (m²)": totalLona,
        "Lona Total Estimada (ha)": totalLonaHa
      }
    ];

    // 2. Datos Detallados de Invernaderos (numeración idéntica a la del mapa #1, #2...)
    const features = scanResult.geojson?.features || [];
    const detailsData = features.map((f: any, index: number) => {
      const displayIdx = f.properties?.displayIndex ?? (index + 1);
      const isManual = Boolean(f.properties?.isManual);
      const isNew = Boolean(f.properties?.isNew);
      const origen = isManual ? "Agregado Manual" : "Detectado por IA";
      const estado = isManual ? "Manual" : (isNew ? "🆕 Nuevo" : "Existente");
      const conf = isManual ? "100% (Manual)" : (f.properties?.confidence ? `${f.properties.confidence}%` : "N/A");
      const rawArea = Number(f.properties?.area_m2 || (scanResult.totalArea / Math.max(1, scanResult.count)));
      const areaM2 = Number(rawArea.toFixed(1));
      const areaHa = Number((rawArea / 10000).toFixed(4));
      const lonaIndividualM2 = Math.round(rawArea * (1 + plasticPercent / 100));
      const lonaIndividualHa = Number((lonaIndividualM2 / 10000).toFixed(4));
      const center = getPolygonCentroidLatLon(f.geometry);
      const coordsText = center ? `${center.lat.toFixed(6)}, ${center.lon.toFixed(6)}` : "N/A";
      const mapsUrl = center ? `https://www.google.com/maps?q=${center.lat.toFixed(6)},${center.lon.toFixed(6)}` : "";
      
      return {
        "N° Invernadero": `#${displayIdx}`,
        "Pueblo / Localidad": townLabel,
        "Estado": estado,
        "Origen": origen,
        "Confianza IA": conf,
        "Superficie Huella (m²)": areaM2,
        "Superficie Huella (ha)": areaHa,
        "Lona Estimada (m²)": lonaIndividualM2,
        "Lona Estimada (ha)": lonaIndividualHa,
        "Coordenadas GPS (Lat, Lon)": coordsText,
        "Ubicación Google Maps": mapsUrl
      };
    });

    // Crear libro de trabajo con anchos de columna prolijos
    const wb = XLSX.utils.book_new();
    
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary['!cols'] = [
      { wch: 22 },
      { wch: 24 },
      { wch: 16 },
      { wch: 20 },
      { wch: 22 },
      { wch: 26 },
      { wch: 22 },
      { wch: 24 },
      { wch: 24 },
      { wch: 22 },
      { wch: 24 },
      { wch: 24 }
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen");

    if (detailsData.length > 0) {
      const wsDetails = XLSX.utils.json_to_sheet(detailsData);
      wsDetails['!cols'] = [
        { wch: 16 },
        { wch: 20 },
        { wch: 14 },
        { wch: 18 },
        { wch: 16 },
        { wch: 22 },
        { wch: 22 },
        { wch: 20 },
        { wch: 20 },
        { wch: 26 },
        { wch: 48 }
      ];
      XLSX.utils.book_append_sheet(wb, wsDetails, "Detalle Invernaderos");
    }

    const fileName = `Reporte_${(selectedTown ? `${selectedTown}_` : '')}${zoneName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, fileName);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden', position: 'relative' }}>
      
      <Sidebar 
        isOpen={isSidebarOpen} 
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        isMobile={isMobile}
        zoneAreaHa={zoneAreaHa}
        isScanning={isScanning}
        scanProgress={scanProgress}
        scanResult={scanResult}
        confidenceThreshold={confidenceThreshold}
        onConfidenceThresholdChange={setConfidenceThreshold}
        filterMode={filterMode}
        onFilterModeChange={setFilterMode}
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
        towns={towns}
        selectedTown={selectedTown}
        onSelectTown={handleSelectTown}
        onSetSelectedTownOnly={setSelectedTown}
        onAddTown={handleAddTown}
        onDeleteTown={handleDeleteTown}
        notifyEmail={notifyEmail}
        onNotifyEmailChange={setNotifyEmail}
        notifyEmailSavedMsg={notifyEmailSavedMsg}
        onRegisterNotifyEmail={handleRegisterNotifyEmail}
      />

      <MapComponent 
        onZoneUpdate={handleZoneUpdate} 
        zoneToLoad={zoneToLoad}
        flyToTarget={flyToTarget}
        scanResult={scanResult}
        plasticPercent={plasticPercent}
        onDeleteDetection={handleDeleteDetection}
        isAddingManual={isAddingManual}
        onManualDetectionAdded={handleManualDetectionAdded}
        onCancelAddManual={() => setIsAddingManual(false)}
        isScanning={isScanning}
        scanProgress={scanProgress}
        onCancelScan={handleCancelScan}
        isMobile={isMobile}
        onToggleSidebar={() => setIsSidebarOpen(prev => !prev)}
        isSidebarOpen={isSidebarOpen}
        isSwipeDrawing={isSwipeDrawing}
        onCancelSwipeDraw={() => {
          startingNewZoneRef.current = false;
          setIsSwipeDrawing(false);
        }}
        frameViewTrigger={frameViewTrigger}
        onCustomLabelsChange={handleCustomLabelsChange}
        notifyEmail={notifyEmail}
        onNotifyEmailChange={setNotifyEmail}
        onRegisterNotifyEmail={handleRegisterNotifyEmail}
        notifyEmailSavedMsg={notifyEmailSavedMsg}
      />

      {/* Barra de Acciones Rápida para Dispositivos Móviles */}
      {isMobile && !isSidebarOpen && !isScanning && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '10px 14px',
          paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
          background: 'linear-gradient(to top, rgba(15, 17, 21, 0.98), rgba(15, 17, 21, 0.88) 80%, rgba(15, 17, 21, 0))',
          pointerEvents: 'none',
          zIndex: 30,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px'
        }}>
          {scanResult ? (
            <div style={{
              pointerEvents: 'auto',
              width: '100%',
              maxWidth: '420px',
              backgroundColor: '#1a1d24',
              border: '1px solid #374151',
              borderRadius: '14px',
              padding: '10px 14px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px'
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '14px', fontWeight: 800, color: '#10b981', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span>🌿 {scanResult.count} invernaderos</span>
                  {scanResult.comparedWithPrevious && (scanResult.newCount ?? 0) > 0 && (
                    <span style={{ background: 'rgba(0,229,255,0.18)', color: '#00e5ff', fontSize: '10.5px', padding: '1px 6px', borderRadius: '999px' }}>
                      +{scanResult.newCount} nuevos
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.35 }}>
                  {scanResult.totalArea.toLocaleString()} m² ({formatAreaHa(scanResult.totalArea)} ha) huella
                </div>
                <div style={{ fontSize: '11.5px', fontWeight: 700, color: plasticPercent > 0 ? '#34d399' : '#d1d5db' }}>
                  {(() => {
                    const lonaM2 = Math.round(scanResult.totalArea * (1 + plasticPercent / 100));
                    return plasticPercent > 0
                      ? `${lonaM2.toLocaleString()} m² (${formatAreaHa(lonaM2)} ha) lona (+${plasticPercent}%)`
                      : `Lona +0% (${formatAreaHa(lonaM2)} ha — ajustar en Detalles)`;
                  })()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    startingNewZoneRef.current = true;
                    setIsSwipeDrawing(true);
                  }}
                  style={{
                    backgroundColor: '#252a33',
                    border: '1px solid #374151',
                    color: '#d1d5db',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                  title="Trazar otra zona con el dedo"
                >
                  ✏️ Nueva
                </button>
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen(true)}
                  style={{
                    backgroundColor: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    boxShadow: '0 4px 12px rgba(16, 185, 129, 0.35)',
                    flexShrink: 0
                  }}
                >
                  <span>Detalles</span>
                  <span>❯</span>
                </button>
              </div>
            </div>
          ) : zoneAreaHa > 0 ? (
            <div style={{
              pointerEvents: 'auto',
              width: '100%',
              maxWidth: '420px',
              backgroundColor: '#1a1d24',
              border: '1px solid #10b981',
              borderRadius: '14px',
              padding: '10px 14px',
              boxShadow: '0 10px 25px rgba(16, 185, 129, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px'
            }}>
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#9ca3af', fontWeight: 600 }}>
                  Área delimitada
                </div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: '#ffffff' }}>
                  {zoneAreaHa.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  onClick={() => setIsSwipeDrawing(true)}
                  style={{
                    backgroundColor: 'transparent',
                    border: '1px solid #4b5563',
                    color: '#d1d5db',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                  title="Volver a trazar la zona con el dedo"
                >
                  ✏️ Redibujar
                </button>
                <button
                  type="button"
                  onClick={() => handleScanZone(activeZoneId ? savedZones.find(z => z.id === activeZoneId)?.name : undefined)}
                  style={{
                    backgroundColor: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '9px 14px',
                    fontSize: '13px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    boxShadow: '0 4px 14px rgba(16, 185, 129, 0.45)',
                    flexShrink: 0
                  }}
                >
                  <span>⚡ Escanear IA</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              pointerEvents: 'auto',
              width: '100%',
              maxWidth: '420px',
              backgroundColor: '#1a1d24',
              border: '1px solid #374151',
              borderRadius: '14px',
              padding: '11px 14px',
              boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span>🌱</span> Marcar Área a Escanear
                </span>
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#9ca3af',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  Mis Zonas ({savedZones.length})
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setIsSwipeDrawing(true)}
                  style={{
                    flex: 1.2,
                    backgroundColor: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '10px 12px',
                    fontSize: '13px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)'
                  }}
                >
                  <span>👆</span>
                  <span>Deslizar con el Dedo</span>
                </button>

                <button
                  type="button"
                  onClick={() => setFrameViewTrigger(Date.now())}
                  style={{
                    flex: 1,
                    backgroundColor: '#252a33',
                    color: '#f9fafb',
                    border: '1px solid #374151',
                    borderRadius: '10px',
                    padding: '10px 12px',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '5px'
                  }}
                  title="Encuadra automáticamente el área visible en tu pantalla"
                >
                  <span>🎯</span>
                  <span>Encuadrar Vista</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
