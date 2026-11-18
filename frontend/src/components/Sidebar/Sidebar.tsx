import { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import { formatAreaHa, type ScanResult, type SavedZone, type TownMetrics } from '../../App';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  zoneAreaHa: number;
  isScanning: boolean;
  scanProgress?: { percent: number; text: string } | null;
  scanResult: ScanResult | null;
  confidenceThreshold?: number;
  onConfidenceThresholdChange?: (val: number) => void;
  filterMode?: 'all' | 'new';
  onFilterModeChange?: (mode: 'all' | 'new') => void;
  isAddingManual?: boolean;
  onToggleAddManual?: () => void;
  onScan: (draftName?: string) => void;
  savedZones: SavedZone[];
  onSaveZone: (name: string, townOverride?: string) => void;
  onLoadZone: (zone: SavedZone) => void;
  canSave: boolean;
  activeZoneId: string | null;
  activeZoneName: string;
  onUpdateZone: (name: string, townOverride?: string) => void;
  onCancelEdit: () => void;
  onDeleteZone: (id: string) => void;
  plasticPercent: number;
  onPlasticPercentChange: (val: number) => void;
  autoSaveStatus?: 'idle' | 'saving' | 'saved';
  onExportExcel: () => void;
  onCancelScan?: () => void;
  isMobile?: boolean;
  towns: TownMetrics[];
  selectedTown: string;
  onSelectTown: (townName: string) => void;
  onSetSelectedTownOnly: (townName: string) => void;
  onAddTown: (townName: string, centerCoords?: [number, number]) => Promise<void> | void;
  onDeleteTown: (town: TownMetrics) => void;
  notifyEmail: string;
  onNotifyEmailChange: (email: string) => void;
  notifyEmailSavedMsg?: string;
  onRegisterNotifyEmail: (email: string) => void;
}

interface TownPlaceSuggestion {
  id: string;
  name: string;
  displayName: string;
  center: [number, number];
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen, onToggle, zoneAreaHa, isScanning, scanProgress, scanResult,
  confidenceThreshold = 40, onConfidenceThresholdChange,
  filterMode = 'all', onFilterModeChange,
  isAddingManual = false, onToggleAddManual,
  onScan, savedZones, onSaveZone, onLoadZone, canSave,
  activeZoneId, activeZoneName, onUpdateZone, onCancelEdit, onDeleteZone,
  plasticPercent, onPlasticPercentChange, autoSaveStatus = 'idle', onExportExcel,
  onCancelScan, isMobile = false,
  towns, selectedTown, onSelectTown, onSetSelectedTownOnly, onAddTown, onDeleteTown,
  notifyEmail, onNotifyEmailChange, notifyEmailSavedMsg, onRegisterNotifyEmail
}) => {
  const [view, setView] = useState<'main' | 'pueblos' | 'library'>('main');
  const [zoneName, setZoneName] = useState('');
  const [justSavedFeedback, setJustSavedFeedback] = useState(false);

  // Estado para agregar nuevos pueblos
  const [newTownInput, setNewTownInput] = useState('');
  const [newTownSuggestions, setNewTownSuggestions] = useState<TownPlaceSuggestion[]>([]);
  const [selectedSuggestionCoords, setSelectedSuggestionCoords] = useState<[number, number] | undefined>(undefined);
  const [isAddingTownLoading, setIsAddingTownLoading] = useState(false);

  // Estado para el ancho del panel redimensionable
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const isResizing = useRef(false);

  useEffect(() => {
    if (activeZoneId) {
      setZoneName(activeZoneName);
    } else {
      setZoneName('');
    }
  }, [activeZoneId, activeZoneName]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      let newWidth = e.clientX;
      if (newWidth < 290) newWidth = 290;
      if (newWidth > 600) newWidth = 600;
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = 'default';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Autocompletado de pueblos en Armenia al agregar un pueblo nuevo
  useEffect(() => {
    const q = newTownInput.trim();
    if (view !== 'pueblos' || q.length < 2) {
      setNewTownSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=am&format=jsonv2&limit=5&accept-language=en,es,hy`;
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data = await resp.json();
        const mapped: TownPlaceSuggestion[] = (data || [])
          .filter((item: any) => item.lon && item.lat)
          .map((item: any) => {
            const shortName = (item.name || item.display_name?.split(',')[0] || q).trim();
            return {
              id: String(item.place_id),
              name: shortName,
              displayName: item.display_name,
              center: [parseFloat(item.lon), parseFloat(item.lat)]
            };
          });
        setNewTownSuggestions(mapped);
      } catch {
        // ignore network errors
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [newTownInput, view]);

  const startResizing = (e: React.MouseEvent) => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  };

  const triggerSavedFeedback = () => {
    setJustSavedFeedback(true);
    setTimeout(() => setJustSavedFeedback(false), 2200);
  };

  const handleSave = () => {
    if (zoneName.trim() === '') return;
    onSaveZone(zoneName.trim());
    triggerSavedFeedback();
  };

  const handleUpdate = () => {
    if (zoneName.trim() === '') return;
    onUpdateZone(zoneName.trim());
    triggerSavedFeedback();
  };

  const handleCreateTownSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newTownInput.trim();
    if (!clean || isAddingTownLoading) return;
    setIsAddingTownLoading(true);
    try {
      await onAddTown(clean, selectedSuggestionCoords);
      setNewTownInput('');
      setNewTownSuggestions([]);
      setSelectedSuggestionCoords(undefined);
    } finally {
      setIsAddingTownLoading(false);
    }
  };

  const renderHeaderTabs = () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.35rem', marginTop: '0.8rem' }}>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => setView('main')}
        style={{
          padding: '0.45rem 0.35rem',
          fontSize: '0.75rem',
          fontWeight: view === 'main' ? 700 : 500,
          backgroundColor: view === 'main' ? 'rgba(16, 185, 129, 0.16)' : 'transparent',
          borderColor: view === 'main' ? 'var(--color-primary)' : 'var(--color-border)',
          color: view === 'main' ? '#10b981' : 'var(--color-text-muted)'
        }}
      >
        🔍 Escaneo
      </button>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => setView('pueblos')}
        style={{
          padding: '0.45rem 0.35rem',
          fontSize: '0.75rem',
          fontWeight: view === 'pueblos' ? 700 : 500,
          backgroundColor: view === 'pueblos' ? 'rgba(16, 185, 129, 0.16)' : 'transparent',
          borderColor: view === 'pueblos' ? 'var(--color-primary)' : 'var(--color-border)',
          color: view === 'pueblos' ? '#10b981' : 'var(--color-text-muted)'
        }}
      >
        🏘️ Pueblos ({towns.length})
      </button>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => setView('library')}
        style={{
          padding: '0.45rem 0.35rem',
          fontSize: '0.75rem',
          fontWeight: view === 'library' ? 700 : 500,
          backgroundColor: view === 'library' ? 'rgba(16, 185, 129, 0.16)' : 'transparent',
          borderColor: view === 'library' ? 'var(--color-primary)' : 'var(--color-border)',
          color: view === 'library' ? '#10b981' : 'var(--color-text-muted)'
        }}
      >
        📁 Zonas ({savedZones.length})
      </button>
    </div>
  );

  const renderBrandHeader = (title: string, subtitle: string) => (
    <div className={styles.header}>
      <div className={styles.headerTop}>
        <div className={styles.brandBlock}>
          <img src="/logo.png" alt="Logo" className={styles.brandLogo} />
          <div className={styles.brandText}>
            <h2 className={styles.brandTitle}>{title}</h2>
            <p className={styles.brandSubtitle}>{subtitle}</p>
          </div>
        </div>
        {isMobile && (
          <button className={styles.mobileCloseBtn} onClick={onToggle} title="Cerrar panel" aria-label="Cerrar panel">
            ✕
          </button>
        )}
      </div>
      {renderHeaderTabs()}
    </div>
  );

  // VISTA PUEBLOS Y MÉTRICAS
  if (view === 'pueblos') {
    return (
      <>
        {isMobile && isOpen && <div className={styles.mobileBackdrop} onClick={onToggle} />}
        <div
          className={`${styles.sidebarContainer} ${isOpen ? styles.open : styles.closed}`}
          style={isMobile ? undefined : { width: `${sidebarWidth}px`, marginLeft: isOpen ? '0px' : `-${sidebarWidth}px` }}
        >
          {!isMobile && <div className={styles.resizer} onMouseDown={startResizing} />}
          {renderBrandHeader('Pueblos y Métricas', 'Base de localidades y re-escaneo histórico')}

          <div className={styles.content}>
            <form onSubmit={handleCreateTownSubmit} className={styles.saveSection} style={{ position: 'relative' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase' }}>
                + Agregar Pueblo a la Base
              </div>
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                <input
                  type="text"
                  placeholder="Nombre del pueblo (ej: Masis, Araks...)"
                  className={styles.inputField}
                  value={newTownInput}
                  onChange={(e) => {
                    setNewTownInput(e.target.value);
                    setSelectedSuggestionCoords(undefined);
                  }}
                />
                <button
                  type="submit"
                  className={styles.saveButton}
                  disabled={!newTownInput.trim() || isAddingTownLoading}
                  style={{ width: 'auto', padding: '0 0.9rem', whiteSpace: 'nowrap' }}
                >
                  {isAddingTownLoading ? '...' : 'Agregar'}
                </button>
              </div>
              {newTownSuggestions.length > 0 && (
                <div style={{
                  background: '#111827',
                  border: '1px solid #374151',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  marginTop: '0.2rem'
                }}>
                  {newTownSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setNewTownInput(s.name);
                        setSelectedSuggestionCoords(s.center);
                        setNewTownSuggestions([]);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid #1f2937',
                        color: '#e5e7eb',
                        padding: '0.45rem 0.6rem',
                        fontSize: '0.75rem',
                        cursor: 'pointer'
                      }}
                    >
                      📍 {s.displayName}
                    </button>
                  ))}
                </div>
              )}
            </form>

            {towns.length === 0 ? (
              <p className={styles.emptyState}>
                Todavía no cargaste pueblos. Agregá uno arriba o vinculá una zona desde la pestaña Escaneo para ver sus métricas consolidadas.
              </p>
            ) : (
              towns.map((town) => {
                const isActive = selectedTown.toLowerCase() === town.name.toLowerCase();
                return (
                  <div
                    key={town.name}
                    className={styles.savedZoneCard}
                    style={{
                      borderColor: isActive ? 'var(--color-primary)' : undefined,
                      backgroundColor: isActive ? 'rgba(16, 185, 129, 0.08)' : undefined
                    }}
                    onClick={() => {
                      onSelectTown(town.name);
                      setView('main');
                    }}
                  >
                    <div className={styles.savedZoneHeader}>
                      <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', margin: 0 }}>
                        <span>🏘️ {town.name}</span>
                      </h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span className={styles.savedZoneDate}>
                          {town.lastScanDate ? new Date(town.lastScanDate).toLocaleDateString() : 'Sin escaneos'}
                        </span>
                        {town.zonesCount === 0 && town.catalogZoneId && (
                          <button
                            type="button"
                            className={styles.deleteButton}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteTown(town);
                            }}
                            title="Eliminar pueblo sin zonas"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem', marginTop: '0.55rem', fontSize: '0.75rem' }}>
                      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.4rem 0.5rem', borderRadius: '6px' }}>
                        <div style={{ color: '#9ca3af', fontSize: '0.68rem' }}>Invernaderos</div>
                        <div style={{ fontWeight: 800, color: '#10b981', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                          <span>{town.totalGreenhouses.toLocaleString()}</span>
                          {town.newGreenhouses > 0 && (
                            <span style={{ fontSize: '0.65rem', background: 'rgba(0,229,255,0.18)', color: '#00e5ff', padding: '1px 5px', borderRadius: '999px' }}>
                              +{town.newGreenhouses} nuevos
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.4rem 0.5rem', borderRadius: '6px' }}>
                        <div style={{ color: '#9ca3af', fontSize: '0.68rem' }}>Historial</div>
                        <div style={{ fontWeight: 700, color: '#e5e7eb' }}>
                          {town.scansCount} esc. · {town.zonesCount} zonas
                        </div>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.4rem 0.5rem', borderRadius: '6px' }}>
                        <div style={{ color: '#9ca3af', fontSize: '0.68rem' }}>Superficie cubierta</div>
                        <div style={{ fontWeight: 700, color: '#f3f4f6' }}>
                          {Math.round(town.totalAreaM2).toLocaleString()} m²
                        </div>
                        <div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
                          {formatAreaHa(town.totalAreaM2)} ha
                        </div>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.4rem 0.5rem', borderRadius: '6px' }}>
                        <div style={{ color: '#9ca3af', fontSize: '0.68rem' }}>Lona estimada</div>
                        <div style={{ fontWeight: 700, color: '#34d399' }}>
                          {Math.round(town.totalLonaM2).toLocaleString()} m²
                        </div>
                        <div style={{ fontSize: '0.68rem', color: '#34d399' }}>
                          {formatAreaHa(town.totalLonaM2)} ha
                        </div>
                      </div>
                    </div>

                    <div style={{
                      marginTop: '0.6rem',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: '#10b981',
                      textAlign: 'center',
                      padding: '0.35rem',
                      borderRadius: '6px',
                      border: '1px solid rgba(16, 185, 129, 0.35)',
                      backgroundColor: 'rgba(16, 185, 129, 0.08)'
                    }}>
                      {town.lastZone
                        ? '🔄 Cargar última zona e invernaderos para re-escanear'
                        : '📍 Ir al pueblo y marcar área'}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </>
    );
  }

  // VISTA LIBRERÍA DE ZONAS
  if (view === 'library') {
    return (
      <>
        {isMobile && isOpen && (
          <div className={styles.mobileBackdrop} onClick={onToggle} />
        )}
        <div
          className={`${styles.sidebarContainer} ${isOpen ? styles.open : styles.closed}`}
          style={isMobile ? undefined : { width: `${sidebarWidth}px`, marginLeft: isOpen ? '0px' : `-${sidebarWidth}px` }}
        >
          {!isMobile && <div className={styles.resizer} onMouseDown={startResizing} />}
          {renderBrandHeader('Mis Zonas', 'Librería de prospecciones guardadas')}

          <div className={styles.content}>
            {savedZones.length === 0 ? (
              <p className={styles.emptyState}>No tenés zonas guardadas aún.</p>
            ) : (
              savedZones.map(zone => (
                <div key={zone.id} className={styles.savedZoneCard} onClick={() => {
                  onLoadZone(zone);
                  setView('main');
                }}>
                  <div className={styles.savedZoneHeader}>
                    <h4 style={{ margin: 0 }}>{zone.name}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className={styles.savedZoneDate}>{zone.date}</span>
                      <button
                        className={styles.deleteButton}
                        onClick={(e) => { e.stopPropagation(); onDeleteZone(zone.id); }}
                        title="Eliminar Zona"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: '#d1d5db' }}>
                      {zone.areaHa.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha
                      {zone.lastScanCount !== undefined ? ` · ${zone.lastScanCount} inv.` : ''}
                    </p>
                    {zone.townName && (
                      <span style={{
                        fontSize: '0.68rem',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        color: '#34d399',
                        padding: '2px 7px',
                        borderRadius: '999px',
                        fontWeight: 600
                      }}>
                        🏘️ {zone.townName}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </>
    );
  }

  // VISTA PRINCIPAL (Dashboard y Escaneo)
  const totalLonaM2 = scanResult ? Math.round(scanResult.totalArea * (1 + plasticPercent / 100)) : 0;

  return (
    <>
      {isMobile && isOpen && (
        <div className={styles.mobileBackdrop} onClick={onToggle} />
      )}
      <div
        className={`${styles.sidebarContainer} ${isOpen ? styles.open : styles.closed}`}
        style={isMobile ? undefined : { width: `${sidebarWidth}px`, marginLeft: isOpen ? '0px' : `-${sidebarWidth}px` }}
      >
        {!isMobile && <div className={styles.resizer} onMouseDown={startResizing} />}
        {renderBrandHeader('Detección Inteligente', 'de Invernaderos · SUPER+')}

        <div className={styles.content}>
          {/* Selector de Pueblo asociado */}
          <div className={styles.metricCard} style={{ padding: '0.65rem 0.8rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
              <h3 style={{ margin: 0 }}>Pueblo / Localidad</h3>
              <button
                type="button"
                onClick={() => setView('pueblos')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#10b981',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                + Gestionar pueblos
              </button>
            </div>
            <select
              value={selectedTown}
              onChange={(e) => {
                const val = e.target.value;
                // Si el usuario recién trazó una zona sin guardar y elige asociarla a un pueblo, no borramos su dibujo
                if (zoneAreaHa > 0 && !activeZoneId && !scanResult) {
                  onSetSelectedTownOnly(val);
                } else if (val) {
                  onSelectTown(val);
                } else {
                  onSetSelectedTownOnly('');
                }
              }}
              className={styles.inputField}
              style={{ fontSize: '0.82rem', padding: '0.45rem' }}
            >
              <option value="">— Sin pueblo asignado —</option>
              {towns.map((t) => (
                <option key={t.name} value={t.name}>
                  🏘️ {t.name} {t.totalGreenhouses > 0 ? `(${t.totalGreenhouses} inv.)` : '(Nuevo)'}
                </option>
              ))}
            </select>
            {selectedTown && zoneAreaHa > 0 && !activeZoneId && !scanResult && (
              <button
                type="button"
                onClick={() => onSelectTown(selectedTown)}
                style={{
                  marginTop: '0.4rem',
                  width: '100%',
                  background: 'rgba(16,185,129,0.1)',
                  border: '1px solid rgba(16,185,129,0.35)',
                  color: '#34d399',
                  borderRadius: '4px',
                  padding: '0.3rem 0.5rem',
                  fontSize: '0.72rem',
                  cursor: 'pointer'
                }}
              >
                Cargar última zona y detecciones de {selectedTown}
              </button>
            )}
          </div>

          {canSave && (
            <div className={styles.saveSection}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder={activeZoneId ? "Renombrar zona..." : "Nombre de nueva zona..."}
                  className={styles.inputField}
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                />
                {activeZoneId && (
                  <button
                    className={styles.secondaryButton}
                    onClick={onCancelEdit}
                    style={{ padding: '0.4rem 0.6rem', color: '#ff4d4f', borderColor: '#ff4d4f' }}
                    title="Cerrar proyecto actual"
                  >
                    ✕
                  </button>
                )}
              </div>

              {activeZoneId ? (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className={styles.saveButton}
                    disabled={zoneName.trim() === ''}
                    onClick={handleUpdate}
                    style={{ flex: 1 }}
                  >
                    {justSavedFeedback ? '✓ Actualizado' : 'Actualizar'}
                  </button>
                  <button
                    className={styles.saveButton}
                    disabled={zoneName.trim() === ''}
                    onClick={handleSave}
                    style={{ flex: 1, backgroundColor: 'transparent', border: '1px solid var(--color-primary)', color: 'var(--color-primary)' }}
                    title="Guardar como proyecto nuevo"
                  >
                    Copiar
                  </button>
                </div>
              ) : (
                <button
                  className={styles.saveButton}
                  disabled={zoneName.trim() === ''}
                  onClick={handleSave}
                >
                  {justSavedFeedback ? '✓ Zona Guardada' : 'Guardar Nueva Zona'}
                </button>
              )}

              {activeZoneId && autoSaveStatus !== 'idle' && (
                <div style={{ fontSize: '0.72rem', color: '#10b981', textAlign: 'right' }}>
                  {autoSaveStatus === 'saving' ? '⏳ Guardando cambios...' : '✓ Cambios guardados automáticamente'}
                </div>
              )}
            </div>
          )}

          <div className={styles.metricCard}>
            <h3>Área a Escanear</h3>
            <p className={styles.metricValue}>
              {zoneAreaHa > 0 ? zoneAreaHa.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0'}
            </p>
            <span className={styles.metricSub}>
              Hectáreas (ha) · Máximo 1.500 ha por lotes
            </span>
          </div>

          {isScanning && (
            <div className={styles.metricCard} style={{ borderLeft: '3px solid var(--color-primary)', background: 'rgba(16, 185, 129, 0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
                <h3 style={{ margin: 0, color: 'var(--color-primary)' }}>Progreso del Escaneo IA</h3>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--color-primary)' }}>
                  {scanProgress?.percent ?? 5}%
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '999px', overflow: 'hidden', marginBottom: '0.45rem' }}>
                <div
                  style={{
                    width: `${Math.max(5, Math.min(100, scanProgress?.percent ?? 5))}%`,
                    height: '100%',
                    backgroundColor: 'var(--color-primary)',
                    borderRadius: '999px',
                    transition: 'width 0.4s ease'
                  }}
                />
              </div>
              <span style={{ fontSize: '0.75rem', color: '#d1d5db', display: 'block', marginBottom: onCancelScan ? '0.6rem' : 0 }}>
                {scanProgress?.text || 'Iniciando motor de detección satelital...'}
              </span>
              {onCancelScan && (
                <button
                  type="button"
                  onClick={onCancelScan}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.6rem',
                    backgroundColor: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    color: '#fca5a5',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.35rem',
                    transition: 'all 0.2s ease'
                  }}
                >
                  ✕ Cancelar Escaneo
                </button>
              )}
            </div>
          )}

          {/* Comparativa de Re-escaneo (Nuevos invernaderos) */}
          {scanResult && scanResult.comparedWithPrevious && (
            <div
              className={styles.metricCard}
              style={{
                borderLeft: '3px solid #00e5ff',
                background: 'rgba(0, 229, 255, 0.08)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <h3 style={{ margin: 0, color: '#00e5ff' }}>Comparación Histórica</h3>
                <span style={{ fontWeight: 800, fontSize: '0.9rem', color: '#00e5ff' }}>
                  🆕 +{scanResult.newCount ?? 0} nuevos
                </span>
              </div>
              {onFilterModeChange && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginTop: '0.35rem' }}>
                  <button
                    type="button"
                    onClick={() => onFilterModeChange('all')}
                    style={{
                      padding: '0.35rem 0.4rem',
                      borderRadius: '6px',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: filterMode === 'all' ? '1px solid #10b981' : '1px solid var(--color-border)',
                      backgroundColor: filterMode === 'all' ? 'rgba(16,185,129,0.2)' : 'transparent',
                      color: filterMode === 'all' ? '#34d399' : '#9ca3af'
                    }}
                  >
                    Ver Todos
                  </button>
                  <button
                    type="button"
                    onClick={() => onFilterModeChange('new')}
                    style={{
                      padding: '0.35rem 0.4rem',
                      borderRadius: '6px',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: filterMode === 'new' ? '1px solid #00e5ff' : '1px solid var(--color-border)',
                      backgroundColor: filterMode === 'new' ? 'rgba(0,229,255,0.2)' : 'transparent',
                      color: filterMode === 'new' ? '#00e5ff' : '#9ca3af'
                    }}
                  >
                    Solo Nuevos ({scanResult.newCount ?? 0})
                  </button>
                </div>
              )}
            </div>
          )}

          {scanResult && onConfidenceThresholdChange && (
            <div className={styles.metricCard} style={{ borderLeft: '3px solid var(--color-primary)', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <h3 style={{ margin: 0 }}>Filtro de Confianza</h3>
                <span style={{
                  fontWeight: 'bold',
                  fontSize: '0.95rem',
                  color: confidenceThreshold >= 70 ? '#00C853' : confidenceThreshold >= 50 ? '#FFD600' : '#FF6D00'
                }}>
                  ≥ {confidenceThreshold}%
                </span>
              </div>
              <input
                type="range"
                min="30"
                max="90"
                step="5"
                value={confidenceThreshold}
                onChange={(e) => onConfidenceThresholdChange(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#9ca3af', marginTop: '0.2rem' }}>
                <span>30% (Exhaustivo)</span>
                <span>90% (Estricto)</span>
              </div>
            </div>
          )}

          {scanResult && onToggleAddManual && (
            <button
              onClick={onToggleAddManual}
              style={{
                width: '100%',
                padding: '0.65rem 1rem',
                marginBottom: '0.4rem',
                borderRadius: '6px',
                border: isAddingManual ? '2px solid #00C853' : '1px solid var(--color-border)',
                backgroundColor: isAddingManual ? 'rgba(0, 200, 83, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                color: isAddingManual ? '#00C853' : 'var(--color-text-main)',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                transition: 'all 0.2s ease'
              }}
            >
              {isAddingManual ? '✕ Cancelar Dibujo Manual' : '➕ Marcar Invernadero Faltante'}
            </button>
          )}

          <div className={styles.metricCard}>
            <h3>Invernaderos Detectados</h3>
            {isScanning && !scanResult ? (
              <div className={styles.loadingPulse}>Analizando por lotes...</div>
            ) : (
              <>
                <p className={styles.metricValue}>
                  {scanResult ? scanResult.count : '--'}
                </p>
                <span className={styles.metricSub}>
                  {scanResult
                    ? (isScanning ? 'Detectados hasta el momento (en vivo)' : 'Identificados en la zona')
                    : 'Pendiente de escaneo'}
                </span>
              </>
            )}
          </div>

          <div className={styles.metricCard}>
            <h3>Área Total Cubierta (Detectada)</h3>
            {isScanning && !scanResult ? (
              <div className={styles.loadingPulse}>Calculando polígonos...</div>
            ) : (
              <>
                <p className={styles.metricValue}>
                  {scanResult ? `${scanResult.totalArea.toLocaleString()} m²` : '--'}
                </p>
                <span className={styles.metricSub}>
                  {scanResult
                    ? `${formatAreaHa(scanResult.totalArea)} ha de huella plana en el suelo`
                    : 'm² y ha de huella plana'}
                </span>

                {scanResult && (
                  <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <h3 style={{ margin: 0 }}>Cálculo de Lona</h3>
                      <select
                        value={plasticPercent}
                        onChange={(e) => onPlasticPercentChange(Number(e.target.value))}
                        className={styles.percentSelect}
                      >
                        <option value="0">Solo huella (+0%)</option>
                        <option value="5">+ 5%</option>
                        <option value="10">+ 10%</option>
                        <option value="15">+ 15%</option>
                        <option value="20">+ 20%</option>
                        <option value="25">+ 25%</option>
                        <option value="30">+ 30%</option>
                        <option value="35">+ 35%</option>
                        <option value="40">+ 40%</option>
                      </select>
                    </div>
                    <p className={styles.metricValue} style={{ color: 'var(--color-primary)', fontSize: '1.45rem' }}>
                      {totalLonaM2.toLocaleString()} m²
                    </p>
                    <div style={{
                      marginTop: '0.3rem',
                      display: 'inline-block',
                      backgroundColor: 'rgba(16, 185, 129, 0.14)',
                      border: '1px solid rgba(16, 185, 129, 0.35)',
                      color: '#34d399',
                      borderRadius: '6px',
                      padding: '0.2rem 0.55rem',
                      fontSize: '0.88rem',
                      fontWeight: 800
                    }}>
                      {formatAreaHa(totalLonaM2)} ha estimadas de lona
                    </div>
                    <span className={styles.metricSub}>Incluye curvatura y margen (+{plasticPercent}%)</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Aviso por correo para poder salir de la app */}
          <div className={styles.metricCard} style={{ padding: '0.65rem 0.8rem' }}>
            <h3 style={{ marginBottom: '0.35rem' }}>📧 Aviso por mail al terminar</h3>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input
                type="email"
                placeholder="tu-mail@ejemplo.com"
                className={styles.inputField}
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.5rem' }}
                value={notifyEmail}
                onChange={(e) => onNotifyEmailChange(e.target.value)}
              />
              {isScanning && (
                <button
                  type="button"
                  onClick={() => onRegisterNotifyEmail(notifyEmail)}
                  className={styles.saveButton}
                  style={{ width: 'auto', padding: '0 0.7rem', fontSize: '0.75rem' }}
                >
                  Avisar
                </button>
              )}
            </div>
            <span className={styles.metricSub} style={{ fontSize: '0.68rem', color: notifyEmailSavedMsg ? '#34d399' : undefined }}>
              {notifyEmailSavedMsg || 'Opcional: podés cerrar la app en escaneos de pueblos y te llega el resumen por mail.'}
            </span>
          </div>

          <button
            className={styles.scanButton}
            onClick={() => onScan(zoneName)}
            disabled={zoneAreaHa === 0 || isScanning}
          >
            {isScanning
              ? 'Escaneando por lotes...'
              : scanResult
                ? '🔄 Re-escanear y Buscar Nuevos'
                : selectedTown
                  ? `⚡ Escanear ${selectedTown}`
                  : 'Escanear Zona con IA'}
          </button>
        </div>

        <div className={styles.footer}>
          <button className={styles.primaryButton} disabled={!scanResult} onClick={onExportExcel}>
            Generar Reporte Excel
          </button>
          {isMobile && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onToggle}
              style={{ width: '100%', marginTop: '0.65rem', padding: '0.75rem', color: '#9ca3af', borderColor: '#4b5563', fontSize: '0.88rem', fontWeight: 600 }}
            >
              ← Volver al Mapa Satelital
            </button>
          )}
        </div>
      </div>

      {!isMobile && (
        <button
          className={`${styles.toggleButton} ${isOpen ? styles.open : styles.closed}`}
          onClick={onToggle}
          title={isOpen ? "Ocultar Panel" : "Mostrar Panel"}
          style={{ left: isOpen ? `${sidebarWidth}px` : '0px' }}
        >
          {isOpen ? "◀" : "▶"}
        </button>
      )}
    </>
  );
};

export default Sidebar;
