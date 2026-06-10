# Guía Definitiva: Reunión Proyecto IA Invernaderos

Esta es tu "hoja de trucos" (Cheat Sheet) para la reunión. Léela antes de entrar para tener todos los conceptos técnicos y comerciales frescos en la mente.

---

## 1. El "Elevator Pitch" (Visión del Proyecto)
*"Hoy pasas horas rastreando Google Maps a ojo para encontrar posibles ventas, y dependes de la suerte para ver un techo roto. Mi propuesta es construir una fábrica de datos invisible: un sistema de software donde tú configuras un área, y una Inteligencia Artificial entrenada específicamente en invernaderos escanea miles de hectáreas devolviéndote un tablero ordenado con la cantidad, metros cuadrados estimativos, y una bandera roja en los que tienen la lona rota o ausente. Pasamos de prospección manual a predicción automática de ventas."*

---

## 2. Oferta Comercial (Estrategia de Módulos)

No vendas un monolito gigante. Vende el inicio con una promesa a futuro:

* **Fase 1: Módulo Base (El "Catastro") — Costo de setup: ~$2,500 USD**
  * **Qué incluye:** Entrenamiento de la IA desde cero para reconocer invernaderos. Desarrollo de Base de Datos para guardar históricos y área. Panel Web para visualizar el mapa y los leads.
  * **Datos:** **Google Maps**.
  * **Funcionalidad:** Servirá para tener la base total de mercado. Encontrar dónde están, contarlos y saber el tamaño de todos los invernaderos del país usando el "Street View satelital" gratuito (Imágenes de 1 a 4 años de antigüedad).
* **Fase 2: Módulo Pro (El "Radar post-tormentas") — Costo de Upsell: ~$500 USD + Insumos.**
  * **Qué incluye:** Conexión (API) con proveedores comerciales como **SkyFi** o **UP42**. 
  * **Datos:** Satélites que pasan diariamente o semanalmente.
  * **Funcionalidad:** Cuando hay una tormenta o necesidad de datos nuevos, se "compra" la imagen de la última semana de ese pueblo puntual. Esto permite saber rápidamente quién sufrió daños recientes.

---

## 3. Explicación de Costos de Mantenimiento para el Cliente
Asegúrale que *no* lo vas a atar a costos fijos gigantes:
* **Costos Fijos:** Nulos o bajísimos. Básicamente el costo de mantener el servidor de la página web o base de datos encendido (Hetzner). 
* **Costos Variables:** Solo gasta cuando aprieta el botón de "Escanear".
  * *En Google Maps (Fase 1):* Prácticamente $0 por imagen. Solo se pagan algunos centavitos por los segundos mágicos en los que la IA en la nube analiza la foto.
  * *En SkyFi (Fase 2):* Se pagará un promedio de $5 a $10 USD por Km2 que él decida escanear de puro archivo fotográfico nuevo.

---

## 4. Stack Técnico (Por si hay algún ingeniero en la sala)
* **Visualización/Frontend:** App React con Next.js + Mapbox GL JS (para pintar miles de polígonos sin trabar la PC).
* **Backend:** Edge Functions conectadas a Base de datos geoespacial.
* **Base de datos:** PostGIS (PostgreSQL via Supabase). Maneja coordenadas y cálculos de área geográficos nativamente.
* **Alojamiento Central:** VPS en Hetzner (ultra rápido y costo-eficiente).
* **Motor IA (La joya):** YOLOv8-Seg (Segmentación de instancias). Inferencia corriendo en servicios *Serverless GPU* a demanda para no pagar placas de video fijas mensuales.

---

## 5. FAQ: Preguntas Anticipadas (¡Estudia estas respuestas!)

**🔴 Cliente: "¿Qué precisión tiene la IA? ¿Se equivoca?"**
**🟢 Tu respuesta:** *"La IA no hace magia el día 1, aprende con ejemplos. Al principio puede que confunda un galpón avícola o una cancha de tenis techada con un invernadero si son del mismo tamaño y color."* El valor de la Fase 1 es precisamente entrenarla a mano. *"Yo me sentaré a mostrarle miles de ejemplos correctos. Podemos llegar tranquilamente a una precisión del 85-90%."*

**🔴 Cliente: "¿Me va a decir el área EXACTA al milímetro?"**
**🟢 Tu respuesta:** *"No. Va a ser un área estimativa comercialmente muy útil. Al mapear satelitalmente, el ángulo en el que el de la cámara toma la foto (Nadir) puede tapar un borde. Te servirá para saber si vas a vender 50m2 o 500m2 de lona, pero no sirve para hacer los cortes de la tijera sin ir presencialmente."*

**🔴 Cliente: "¿Pero por qué me cobras $2,500 en Fase 1 si las imágenes de Google son gratis?"**
**🟢 Tu respuesta:** *"Tú no me pagas por las imágenes porque yo no soy fotógrafo. Me pagas por construir la 'Fábrica Matemática' detrás. Te cobro la arquitectura del servidor, la base de datos geoespacial y las largas horas que pasaré enseñándole a una red neuronal a distinguir qué es lona nueva y qué es una estructura pelada."*

**🔴 Cliente: "¿Me avisa el mismo día que cae granizo?"**
**🟢 Tu respuesta:** *"Con Google Maps (Fase 1), no. Con el módulo Premium (SkyFi - Fase 2), tú podrás ordenar manualmente una foto al día siguiente, o podemos ver de conectarlo a una API del Clima en un futuro Módulo 3 para que dispare alertas de forma totalmente automática de compra."*

**🔴 Cliente: "¿A quién le pertenecen los datos de los invernaderos descubiertos?"**
**🟢 Tu respuesta:** *"A ti. Supabase, nuestra base de datos, estará alojada privadamente para tu empresa. El padrón de clientes potenciales es el gran activo de tu negocio."*

---

## 6. Preguntas clave que tú debes hacerle a él

1. *"En las fotos que hoy tú miras en Google de Armenia... ¿Puedes ver bien a ojo humano si un techo está roto? (Regla de oro de Computer Vision: Si el ojo humano no lo nota, la IA tampoco)."*
2. *"¿Qué margen de error en metros cuadrados de techo te sirve para que sea un lead útil comercialmente hablando?"*
3. *"Si hacemos que el sistema detecte a todos los invernaderos del país... ¿Tienes fuerza de ventas para contactarlos a todos o tu proceso requiere algo de volumen más chico?"*
