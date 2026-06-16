import React, { useState, useEffect } from 'react';
import styles from './DrawingToolbar.module.css';

interface DrawingToolbarProps {
  drawRef: React.MutableRefObject<any | null>;
  mapRef: React.MutableRefObject<any | null>;
}

const DrawingToolbar: React.FC<DrawingToolbarProps> = ({ drawRef, mapRef }) => {
  const [currentMode, setCurrentMode] = useState('simple_select');
  const [showShapesMenu, setShowShapesMenu] = useState(false);

  useEffect(() => {
    if (!mapRef.current) return;
    
    const handleModeChange = (e: any) => {
      setCurrentMode(e.mode);
    };
    
    mapRef.current.on('draw.modechange', handleModeChange);

    // Soporte para borrar con las teclas Delete o Backspace
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignorar si el usuario está escribiendo en un input (ej: nombre de zona)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Delete' || e.key === 'Backspace' || e.keyCode === 46 || e.keyCode === 8) {
        if (drawRef.current) {
          const selected = drawRef.current.getSelectedIds();
          if (selected && selected.length > 0) {
            drawRef.current.trash();
          }
        }
      }
    };

    // Usamos el tercer parámetro (true) para capturar el evento antes de que Mapbox lo bloquee
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      mapRef.current?.off('draw.modechange', handleModeChange);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [mapRef, drawRef]);

  const [activeTool, setActiveTool] = useState<string>('simple_select');

  const changeMode = (mode: string) => {
    if (drawRef.current) {
      if (mode === 'draw_brush') {
        // Pass current brush options (color and width) to the custom brush mode
        drawRef.current.changeMode(mode, { color: brushOptions.color, width: brushOptions.width });
      } else {
        drawRef.current.changeMode(mode);
      }
      setActiveTool(mode);
    }
    setShowShapesMenu(false);
  };

  const trash = (e: React.MouseEvent) => {
    e.preventDefault(); // Evita que el mapa pierda el foco y deseleccione la figura
    if (drawRef.current) {
      drawRef.current.trash();
    }
  };

  // Íconos SVG limpios y modernos
  const CursorIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path>
      <path d="M13 13l6 6"></path>
    </svg>
  );

  const PolygonIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12l5-9 8 2 5 9-6 7-8-3-4-6z"></path>
      <circle cx="3" cy="12" r="2" fill="currentColor"></circle>
      <circle cx="8" cy="3" r="2" fill="currentColor"></circle>
      <circle cx="16" cy="5" r="2" fill="currentColor"></circle>
      <circle cx="21" cy="14" r="2" fill="currentColor"></circle>
      <circle cx="15" cy="21" r="2" fill="currentColor"></circle>
      <circle cx="7" cy="18" r="2" fill="currentColor"></circle>
    </svg>
  );

  const RectangleIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="3" cy="3" r="1.5" fill="currentColor"></circle>
      <circle cx="21" cy="3" r="1.5" fill="currentColor"></circle>
      <circle cx="21" cy="21" r="1.5" fill="currentColor"></circle>
      <circle cx="3" cy="21" r="1.5" fill="currentColor"></circle>
    </svg>
  );

  const TrashIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  );

  return (
    <div className={styles.toolbarWrapper}>
      <div className={styles.toolbar}>
        
        {/* Libre */}
        <button
          className={`${styles.toolButton} ${activeTool === 'draw_polygon' ? styles.active : ''}`}
          onClick={() => changeMode('draw_polygon')}
          title="Polígono Libre"
        >
          {PolygonIcon()}
        </button>

        {/* Rectángulo */}
        <button
          className={`${styles.toolButton} ${activeTool === 'draw_rectangle' ? styles.active : ''}`}
          onClick={() => changeMode('draw_rectangle')}
          title="Rectángulo"
        >
          {RectangleIcon()}
        </button>





        {/* Regla */}
        <button
          className={`${styles.toolButton} ${activeTool === 'draw_line_string' ? styles.active : ''}`}
          onClick={() => changeMode('draw_line_string')}
          title="Regla (medir distancia)"
        >
          {/* regla */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="10" rx="2" ry="2"></rect><line x1="6" y1="7" x2="6" y2="10"></line><line x1="10" y1="7" x2="10" y2="10"></line><line x1="14" y1="7" x2="14" y2="10"></line><line x1="18" y1="7" x2="18" y2="10"></line></svg>
        </button>

        {/* Texto */}
        <button
          className={`${styles.toolButton} ${activeTool === 'draw_text' ? styles.active : ''}`}
          onClick={() => changeMode('draw_text')}
          title="Texto"
        >
          {/* A */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><text x="12" y="16" textAnchor="middle" fontSize="12" fontFamily="Arial">A</text></svg>
        </button>

        {/* Borrar */}
        <button className={styles.toolButton} onClick={trash} title="Borrar elemento seleccionado">
          {TrashIcon()}
        </button>




      </div>
    </div>
  );
};

export default DrawingToolbar;
