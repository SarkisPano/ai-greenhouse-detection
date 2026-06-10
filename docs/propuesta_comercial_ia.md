# Propuesta: Sistema de Detección y Análisis de Invernaderos con IA

## 1. Visión del Producto (El "Pitch" para tu cliente)
El objetivo es transformar un proceso manual, tedioso y propenso a errores (buscar en Google Maps a ojo) en un **motor de generación de leads automático**. 

El cliente tendrá acceso a un panel web o reporte donde el sistema procesa las imágenes satelitales con Inteligencia Artificial para devolverle un listado accionable de potenciales clientes, priorizando aquellos con lona dañada o faltante.

---

## 2. Solución a los Requerimientos Planteados

1. **Cantidad de invernaderos en el pueblo:** 
   El sistema utilizará un modelo de **Detección de Objetos** para escanear zonas enteras, colocando un marcador sobre cada estructura identificada como invernadero y devolviendo el conteo total.

2. **Metros cuadrados de los invernaderos (Cálculo de Área):**
   En lugar de solo detectar "dónde" está, la IA usará **Segmentación de Instancias (Instance Segmentation)** para dibujar el contorno (polígono) exacto del techo. Conociendo la escala del mapa (relación píxel/metro), el sistema calcula automáticamente los metros cuadrados aproximados, dándole al cliente una estimación de venta inmediata.

3. **Detección de invernaderos rotos o sin lona:**
   Cada polígono detectado pasará por un modelo de **Clasificación / Detección de Anomalías**. 
   * **Rotos:** La IA detectará anomalías visuales (parches oscuros, irregularidades, diferencias de textura en el techo).
   * **Sin Lona / Estructura desnuda:** La IA será entrenada para reconocer el patrón de cuadrícula de la estructura metálica/madera que queda expuesta cuando no hay cubierta.

---

## 3. Arquitectura Técnica Proyectada (Para que demuestres dominio)

Para armar una solución robusta y profesional, la tecnología se dividiría en 3 componentes principales:

* **Adquisición de Datos (Imágenes) y Proveedores:**
  * **Opción Básica (Para empezar): APIs de Google Maps / Mapbox.** Google *sí* tiene API (Map Tiles API y Static Maps API). Es *muy económica* (aprox. $2 USD cada 1,000 imágenes llamadas). **Limitación:** Google no te permite "pagar extra" por mayor calidad o frecuencia. Las imágenes se actualizan cuando Google decide (cada 6 a 12 meses en zonas urbanas densas, pero de 2 a 5 años en zonas rurales/agrícolas).
  * **Opciones Avanzadas (Alta Frecuencia y Calidad): Proveedores Satelitales Privados.** Para lograr detectar problemas la misma semana que ocurren, hay que salir de Google y pasar a APIs comerciales:
    * **Planet Labs:** Su propuesta de valor es fotografiar todo el mundo **casi a diario**. Su resolución estándar es de 3 metros (ideal para conteo, quizás ajustado para roturas pequeñas) y tienen satélites premium (SkySat) de 50cm. Se manejan mayormente con suscripciones anuales o paquetes, el costo de acceso a su archivo puede rondar entre los $1 a $2 USD por km² en grandes volúmenes.
    * **Maxar Technologies / Airbus:** Son el "estándar de oro" de la ultra-alta resolución (hasta 30cm por píxel, ves el techo a la perfección). Si compras imágenes que *ya están en su archivo*, el costo ronda los **$10 a $25 USD por km²**. Si requieres "Tasking" (darle una orden al satélite para que tome una foto mañana enfocada en tu zona), el precio sube a **$40 - $60 USD por km²**, y suelen exigir un mínimo de área de compra (ej. 25 a 100 km²).
  * *Estrategia para la reunión:* Recomiéndale arrancar la "Fase 1 (Prueba de Concepto)" usando la API barata de Google Maps para no gastar una fortuna en imágenes sin antes validar que la IA detecta la lona. Si el modelo es exitoso y el cliente se queja de la "antigüedad" de la foto, ahí se justifica pagar un proveedor premium.

* **Motor de IA (Computer Vision):**
  * **Modelo de Segmentación (El Cerebro):** Arquitecturas avanzadas como **YOLOv8-Seg** o **Mask R-CNN**. Son los estándares de la industria para detectar formas complejas en imágenes.
  * **Entrenamiento:** Se requerirá armar en la fase 1 un dataset de validación recolectando imágenes y etiquetando a mano algunos invernaderos rotos/sanos para "enseñarle" al modelo.

* **Plataforma de Usuario:**
  * Un mapa interactivo con los polígonos superpuestos.
  * Un panel con las métricas estimadas (Ej: "Hay 5,000 m2 de lona dañada en este pueblo, potencial de X mil dólares").
  * Exportación de "Leads" a Excel.

---

## 4. Preguntas clave para hacerle al cliente en la reunión

Hacerle estas preguntas demostrará que estás pensando como un socio tecnológico:

1. **Sobre la calidad de las imágenes que usa hoy:** *"Cuando buscas hoy en Google Maps, ¿siempre logras ver bien las roturas o a veces la imagen está pixelada/desactualizada?"* (Esto te permitirá saber si la resolución de Google es suficiente en su área).
2. **Sobre el flujo de trabajo posterior:** *"Una vez que identificas un invernadero roto, ¿cómo averiguas el contacto del dueño del campo?"* (Quizás puedas sumar una integración con catastro local o directorios en el futuro).
3. **Sobre las expectativas de la herramienta:** *"¿Qué margen de error en metros cuadrados te sirve para hacer una primera estimación?"* (Ninguna estimación satelital es 100% exacta por el ángulo de la cámara; es bueno establecer expectativas reales).
4. **Frecuencia de revisión:** *"¿Cada cuánto necesitas revisar los pueblos? ¿Las roturas suceden rápido por fuertes tormentas recientes o es desgaste?"* (Esto influye en cuán dinámico tiene que ser el sistema).
5. **Características visuales:** *"En esa zona, ¿hay otros galpones (ej: avícolas) que se vean parecidos desde arriba?"* (Importante para evitar "Falsos Positivos" en la IA).

---

## 5. Propuesta de Fases (Roadmap sugerido que le puedes contar)

No le vendas un sistema masivo de entrada, proponle fases para mitigar riesgos:

* **Fase 1: Prueba de Concepto (PoC) (Primer mes):** Seleccionar 1 o 2 pueblos piloto. Tú (o tu equipo de IA) descargan imágenes manualmente, entrenan un pequeño modelo base y le devuelven un Excel con resultados + capturas. El cliente valida y te dice: "Sí, este porcentaje de acierto nos sirve".
* **Fase 2: Producto Mínimo Viable (MVP) (Mes 2-4):** Integración con plataforma Web. El usuario pone un área y el sistema se conecta a la API de mapas, corre el modelo y muestra polígonos (Verde=Sano, Rojo=Roto, Amarillo=Sin lona).
* **Fase 3: Escalabilidad Comercial:** Pipeline automático 100% cloud, historiales, reportes detallados y eventual cruce con datos meteorológicos para mandar alertas cuando hubo granizo en una zona de cultivos.
