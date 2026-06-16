import { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import type { ScanResult, SavedZone } from '../../App';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  zoneAreaHa: number;
  isScanning: boolean;
  scanResult: ScanResult | null;
  onScan: () => void;
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
}

const Sidebar: React.FC<SidebarProps> = ({ 
  isOpen, onToggle, zoneAreaHa, isScanning, scanResult, onScan,
  savedZones, onSaveZone, onLoadZone, canSave,
  activeZoneId, activeZoneName, onUpdateZone, onCancelEdit, onDeleteZone,
  plasticPercent, onPlasticPercentChange
}) => {
  const [view, setView] = useState<'main' | 'library'>('main');
  const [zoneName, setZoneName] = useState('');
  
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

  const handleSave = () => {
    if (zoneName.trim() === '') return;
    onSaveZone(zoneName);
    setView('library'); 
  };

  const handleUpdate = () => {
    if (zoneName.trim() === '') return;
    onUpdateZone(zoneName);
    setView('library'); 
  };

  if (view === 'library') {
    return (
      <div 
        className={`${styles.sidebarContainer} ${isOpen ? styles.open : styles.closed}`}
        style={{ width: `${sidebarWidth}px`, marginLeft: isOpen ? '0px' : `-${sidebarWidth}px` }}
      >
        <div className={styles.header}>
          <h2>Mis Zonas</h2>
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
    );
  }

  // VISTA PRINCIPAL (Dashboard y Escaneo)
  return (
    <>
      <div 
        className={`${styles.sidebarContainer} ${isOpen ? styles.open : styles.closed}`}
        style={{ width: `${sidebarWidth}px`, marginLeft: isOpen ? '0px' : `-${sidebarWidth}px` }}
      >
        {/* Resizer Handle */}
        <div className={styles.resizer} onMouseDown={startResizing} />

        <div className={styles.header}>
          <h2>Detección Inteligente</h2>
          <p>de Invernaderos</p>
          <button 
            className={styles.secondaryButton} 
            onClick={() => setView('library')}
            style={{marginTop: '0.8rem', width: '100%'}}
          >
            Mis Zonas Guardadas
          </button>
        </div>

        <div className={styles.content}>
          
          {/* SECCIÓN DE GUARDADO DE ZONA */}
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
                    Actualizar
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
                  Guardar Nueva Zona
                </button>
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
                  {scanResult ? 'Identificados por IA' : 'Pendiente de escaneo'}
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
            onClick={onScan}
            disabled={zoneAreaHa === 0 || isScanning}
          >
            {isScanning ? 'Escaneando...' : 'Escanear Zona con IA'}
          </button>
        </div>

        <div className={styles.footer}>
          <button className={styles.primaryButton} disabled={!scanResult}>
            Generar Reporte Excel
          </button>
        </div>
      </div>

      <button 
        className={`${styles.toggleButton} ${isOpen ? styles.open : styles.closed}`} 
        onClick={onToggle}
        title={isOpen ? "Ocultar Panel" : "Mostrar Panel"}
        style={{ left: isOpen ? `${sidebarWidth}px` : '0px' }}
      >
        {isOpen ? "◀" : "▶"}
      </button>
    </>
  );
};

export default Sidebar;
