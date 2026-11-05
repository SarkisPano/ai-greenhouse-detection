import { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import type { ScanResult, SavedZone } from '../../App';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  zoneAreaHa: number;
  isScanning: boolean;
  scanProgress?: { percent: number; text: string } | null;
  scanResult: ScanResult | null;
  confidenceThreshold?: number;
  onConfidenceThresholdChange?: (val: number) => void;
  isAddingManual?: boolean;
  onToggleAddManual?: () => void;
  onScan: (draftName?: string) => void;
  savedZones: SavedZone[];
  onSaveZone: (name: string) => void;
  onLoadZone: (zone: SavedZone) => void;
  canSave: boolean;
  activeZoneId: string | null;
  activeZoneName: string;
  onUpdateZone: (name: string) => void;
  onCancelEdit: () => void;
  onDeleteZone: (id: string) => void;
  plasticPercent: number;
  onPlasticPercentChange: (val: number) => void;
  autoSaveStatus?: 'idle' | 'saving' | 'saved';
  onExportExcel: () => void;
  onCancelScan?: () => void;
  isMobile?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ 
  isOpen, onToggle, zoneAreaHa, isScanning, scanProgress, scanResult,
  confidenceThreshold = 40, onConfidenceThresholdChange,
  isAddingManual = false, onToggleAddManual,
  onScan, savedZones, onSaveZone, onLoadZone, canSave,
  activeZoneId, activeZoneName, onUpdateZone, onCancelEdit, onDeleteZone,
  plasticPercent, onPlasticPercentChange, autoSaveStatus = 'idle', onExportExcel,
  onCancelScan, isMobile = false
}) => {
  const [view, setView] = useState<'main' | 'library'>('main');
  const [zoneName, setZoneName] = useState('');
  const [justSavedFeedback, setJustSavedFeedback] = useState(false);
  
  // Estado para el ancho del panel redimensionable
  const [sidebarWidth, setSidebarWidth] = useState(340);
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
      if (newWidth < 280) newWidth = 280; // mínimo
      if (newWidth > 600) newWidth = 600; // máximo
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
          <div className={styles.header}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <h2>Mis Zonas</h2>
              {isMobile && (
                <button className={styles.mobileCloseBtn} onClick={onToggle} title="Cerrar">
                  ✕
                </button>
              )}
            </div>
            <p style={{marginBottom: '0.8rem'}}>Librería de prospecciones guardadas</p>
            <button className={styles.secondaryButton} onClick={() => setView('main')} style={{width: '100%'}}>Volver al mapa</button>
          </div>

          <div className={styles.content}>
          {savedZones.length === 0 ? (
            <p className={styles.emptyState}>No tienes zonas guardadas aún.</p>
          ) : (
            savedZones.map(zone => (
              <div key={zone.id} className={styles.savedZoneCard} onClick={() => {
                onLoadZone(zone);
                setView('main'); // Vuelve a la vista principal
              }}>
                <div className={styles.savedZoneHeader}>
                  <h4>{zone.name}</h4>
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
                <p>{zone.areaHa.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha</p>
              </div>
            ))
          )}
        </div>
      </div>
      </>
    );
  }

  // VISTA PRINCIPAL (Dashboard y Escaneo)
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

        <div className={styles.header}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <h2>Detección Inteligente</h2>
              <p>de Invernaderos</p>
            </div>
            {isMobile && (
              <button className={styles.mobileCloseBtn} onClick={onToggle} title="Cerrar">
                ✕
              </button>
            )}
          </div>
          <button 
            className={styles.secondaryButton} 
            onClick={() => setView(view === 'main' ? 'library' : 'main')}
            style={{marginTop: '0.8rem', width: '100%'}}
          >
            {view === 'main' ? `📁 Mis Zonas Guardadas (${savedZones.length})` : 'Volver a Escanear'}
          </button>
        </div>

        <div className={styles.content}>
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
            <span className={styles.metricSub}>Hectáreas (ha)</span>
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
                    width: `${ Math.max(5, Math.min(100, scanProgress?.percent ?? 5)) }%`,
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
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.22)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.12)')}
                >
                  ✕ Cancelar Escaneo
                </button>
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
                marginBottom: '0.8rem',
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
            {isScanning ? (
              <div className={styles.loadingPulse}>Analizando imágenes...</div>
            ) : (
              <>
                <p className={styles.metricValue}>
                  {scanResult ? scanResult.count : '--'}
                </p>
                <span className={styles.metricSub}>
                  {scanResult ? 'Identificados en la zona' : 'Pendiente de escaneo'}
                </span>
              </>
            )}
          </div>

          <div className={styles.metricCard}>
            <h3>Área Total Cubierta (Detectada)</h3>
            {isScanning ? (
              <div className={styles.loadingPulse}>Calculando polígonos...</div>
            ) : (
              <>
                <p className={styles.metricValue}>
                  {scanResult ? scanResult.totalArea.toLocaleString() : '--'}
                </p>
                <span className={styles.metricSub}>m² de huella en el suelo</span>

                {scanResult && (
                  <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <h3 style={{ margin: 0 }}>Cálculo de Lona</h3>
                      <select 
                        value={plasticPercent} 
                        onChange={(e) => onPlasticPercentChange(Number(e.target.value))}
                        className={styles.percentSelect}
                      >
                        <option value="0">En blanco (+0%)</option>
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
                    <p className={styles.metricValue} style={{ color: 'var(--color-primary)', fontSize: '1.5rem' }}>
                      {Math.round(scanResult.totalArea * (1 + plasticPercent / 100)).toLocaleString()}
                    </p>
                    <span className={styles.metricSub}>m² de material estimado requerido</span>
                  </div>
                )}
              </>
            )}
          </div>

          <button 
            className={styles.scanButton} 
            onClick={() => onScan(zoneName)}
            disabled={zoneAreaHa === 0 || isScanning}
          >
            {isScanning ? 'Escaneando...' : 'Escanear Zona con IA'}
          </button>
        </div>

        <div className={styles.footer}>
          <button className={styles.primaryButton} disabled={!scanResult} onClick={onExportExcel}>
            Generar Reporte Excel
          </button>
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
