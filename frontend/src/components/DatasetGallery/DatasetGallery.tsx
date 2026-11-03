import React, { useEffect, useState } from 'react';
import styles from './DatasetGallery.module.css';

interface DatasetGalleryProps {
  onClose: () => void;
}

const DatasetGallery: React.FC<DatasetGalleryProps> = ({ onClose }) => {
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  useEffect(() => {
    const fetchImages = async () => {
      try {
        const response = await fetch('http://localhost:5000/dataset/list');
        const data = await response.json();
        setImages(data.images || []);
      } catch (error) {
        console.error("Error fetching dataset images:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchImages();
  }, []);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        
        {/* Header */}
        <div className={styles.header}>
          <div>
            <h2>Imágenes Satelitales Crudas (Zoom 19)</h2>
            <p>Imágenes descargadas de Mapbox listas para exportar a Roboflow ({images.length} encontradas)</p>
          </div>
          <button onClick={onClose} className={styles.closeBtn}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        {/* Gallery Content */}
        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>
              <p>Cargando...</p>
            </div>
          ) : images.length === 0 ? (
            <div className={styles.empty}>
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{marginBottom: '1rem'}}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              <p>No hay imágenes descargadas aún.</p>
            </div>
          ) : (
            <div className={styles.grid}>
              {images.map((img, idx) => (
                <div 
                  key={idx} 
                  className={styles.card}
                  onClick={() => setSelectedImage(`http://localhost:5000${img}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <img 
                    src={`http://localhost:5000${img}`} 
                    alt={`Dataset ${idx}`} 
                    loading="lazy"
                  />
                  <div className={styles.label}>
                    {img.split('/').pop()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Lightbox Overlay */}
        {selectedImage && (
          <div className={styles.lightbox} onClick={() => setSelectedImage(null)}>
            <button className={styles.lightboxClose} onClick={(e) => { e.stopPropagation(); setSelectedImage(null); }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
            <img src={selectedImage} alt="Expanded view" className={styles.lightboxImg} />
            <p style={{ color: '#a3a3a3', marginTop: '1rem' }}>{selectedImage.split('/').pop()}</p>
          </div>
        )}

      </div>
    </div>
  );
};

export default DatasetGallery;
