# Karaoke interactivo

Proyecto de **Redes y Tecnología** — Iara Churba, Yazmin Kussi, Rocío Prieto Valdez.

> Sentite un cantante profesional, viví tu era popstar.

Instalación de karaoke con estética **editorial / poster** (fondo crema, tipografía
negra bien grande, halftone, estrella magenta, grano de impresión — nada de luces
ni glow). La persona se ve a sí misma y **controla todo desde la cámara**: gestos
con la mano (MediaPipe) y comandos de voz. No hay control por celular.

## Arquitectura

```
web/     -> frontend Astro + Vite (HTML + SVG + canvas 2D) + MediaPipe + Web Speech API
server/  -> "el cerebro": Express + Socket.IO + maquina de estados + catalogo
```

Dos procesos. En dev el frontend corre con `astro dev` (:4321) y habla con el
cerebro (:3000) por WebSocket. `npm start` compila el frontend y lo sirve todo
desde el :3000.

```
                 gestos (MediaPipe Hands) + voz (Web Speech)
[ camara de la pantalla ] ──acciones──► [ server :3000 ] ──estado──► [ pantalla ]
[ sensor ultrasonico Arduino ] ──WS/Serial──►   (maquina de estados)
```

## Arranque

```bash
npm install       # baja tambien modelos de MediaPipe + fuentes (postinstall)
npm run dev
```

Abrí http://localhost:4321/ (Chrome o Edge para la voz). La primera vez pide
permiso de **cámara** y **micrófono**. Arranca directo, sin pantalla de "tocá
para empezar".

`npm start` = build + todo en el :3000 (lo que usarías en el evento).

### Modo kiosco (para que el audio suene solo, sin ningún click)

Los navegadores bloquean el audio con sonido hasta que hay una interacción real
de la persona (por diseño, para evitar autoplay molesto). Como acá todo el
control es por cámara/voz, puede que la primera canción arranque muda hasta que
alguien haga click o toque la pantalla una vez. Para que ande siempre sin
ningún click, abrí Chrome con:

```bash
chrome --autoplay-policy=no-user-gesture-required --kiosk http://localhost:3000/
```

(en Windows probá `start chrome --autoplay-policy=no-user-gesture-required --kiosk http://localhost:3000/`
con `npm start` corriendo). Con ese flag el audio se desbloquea solo apenas
carga la página.

## Deploy online (Vercel + Render)

El evento en sí (pantalla + cámara del kiosco) corre local como arriba. Pero
para poder mostrar/probar la sala desde cualquier lado (no solo la wifi del
lugar), el frontend y el backend se despliegan por separado porque el
"cerebro" necesita quedar siempre prendido (Socket.IO + estado en memoria +
`ffmpeg`), algo que Vercel no soporta (solo corre funciones cortas).

- **Backend (`server/`) → Render** (o cualquier host de Node persistente):
  - Build command: `npm install`
  - Start command: `npm -w server run start` (usa el `PORT` que da Render solo)
  - Variables de entorno:
    - `PUBLIC_BACKEND_URL` = la URL pública que te da Render (para el QR de descarga del video)
    - `PUBLIC_FRONTEND_URL` = la URL de Vercel (para el QR de la sala, ver abajo)
- **Frontend (`web/`) → Vercel**:
  - Ya incluido un `vercel.json` en la raíz que compila solo `web/` (`buildCommand`
    + `outputDirectory: web/dist`) — no hace falta tocar nada en el dashboard.
  - Variable de entorno: `PUBLIC_SOCKET_URL` = la URL pública de Render.

Sin esas variables, todo sigue funcionando en modo local (kiosco) exactamente
igual que antes: usa la IP de la red wifi para armar los QR.

⚠️ En el plan gratis de Render el servicio "se duerme" tras ~15 min sin uso
(la primera visita después tarda en despertar) y el disco no es persistente
entre reinicios — los videos grabados pueden perderse si el server se
reinicia. Para el evento real conviene seguir usando el modo local de arriba.

## Máquina de estados

`ESPERANDO → MODO → SELECCIONANDO → CONFIRMADA → COUNTDOWN → PLAYING → RESULTADO → ESPERANDO`

La autoridad es el servidor ([server/stateMachine.js](server/stateMachine.js)). La
pantalla solo manda **acciones** y renderiza el `estado`.

- **MODO**: elegís **solo** (1 mano sostenida / decir "solo") o **dúo**
  (2 manos / decir "dúo"). En dúo la letra se reparte automáticamente en
  **VOZ 1 / VOZ 2 / LOS DOS**, cada una de un color — karaoke competencia.
- **PLAYING**: además de la letra hay **retos** ([web/src/lib/retos.js](web/src/lib/retos.js)):
  cada tanto aparece un cartel ("manos arriba", "corazón", "puño", "paz"…);
  si lo cumplís sumás puntos. El puntaje final = base por completar la canción +
  bonus de retos.
- **RESULTADO**: la pantalla graba un **video compuesto** (cámara + la letra que
  se canta) con **audio de la canción + la voz mezclados**, lo sube al server,
  que lo pasa a **.mp4** con ffmpeg. El **QR** lleva a `http://IP:3000/video/<sesión>`
  (reproductor + descarga). El primer toque en la pantalla desbloquea el audio.

## Control por cámara

### Manos + presencia + recorte — MediaPipe Tasks Vision

[web/src/lib/vision.js](web/src/lib/vision.js) corre 3 modelos sobre el video:
- `HandLandmarker` (gestos) — con **filtro One Euro** ([oneEuro.js](web/src/lib/oneEuro.js)) para que el esqueleto no tiemble.
- `FaceDetector` (¿hay una persona?) — si **no ve a nadie por 10 s** en un estado activo, vuelve solo a ESPERANDO.
- `ImageSegmenter` (selfie) — recorta a la persona y la dibuja **por encima de la UI** ([personaCanvas.js](web/src/lib/personaCanvas.js)), así la letra / la estrella nunca la tapan. Si el modelo no está, cae a la cámara a pantalla completa.

[web/src/lib/manos.js](web/src/lib/manos.js) traduce los gestos:

| Gesto | Acción |
|---|---|
| mano visible (ESPERANDO) | `presencia` |
| mano arriba / abajo (SELECCIONANDO) | `scroll` |
| pellizco (pulgar + índice) sostenido ~1s | `confirmar` |
| **gesto de corazón** (dos manos) | efecto: stamp ♥ + la estrella se pone hot pink |

El esqueleto de la mano se dibuja como **tinta** (líneas negras + nodos magenta,
sin glow) en un canvas 2D — [web/src/lib/manosCanvas.js](web/src/lib/manosCanvas.js).
La cantidad de manos aplica un tinte de papel muy sutil.

### Voz — Web Speech API (es-ES, solo Chrome/Edge)

[web/src/lib/voz.js](web/src/lib/voz.js):

| Decís | Acción |
|---|---|
| "cantar" / "empezar" / "listo" | `presencia` |
| el **nombre de una canción** de la lista | `seleccionar` |
| "siguiente" / "anterior" | `scroll` |
| "confirmar" / "dale" / "esa" | `confirmar` |
| "salir" / "cancelar" / "basta" | `reset` (o cortar la canción) |

## Estética / archivos del look

| Archivo | Qué hace |
|---|---|
| [styles/global.css](web/src/styles/global.css) | todo el look: crema + negro + magenta, tipografía Archivo Black / Parisienne, halftone, grano, layout por estado, versión apaisada |
| [lib/escenario.js](web/src/lib/escenario.js) | arma la estrella SVG, la hace latir con la música, cambia de tono según las manos |
| [lib/audioAnalisis.js](web/src/lib/audioAnalisis.js) | `energia()` 0..1 del audio para el latido de la estrella |
| [lib/manosCanvas.js](web/src/lib/manosCanvas.js) | esqueleto de la mano estilo tinta |

## Assets offline

`npm install` corre [web/scripts/preparar-mediapipe.mjs](web/scripts/preparar-mediapipe.mjs):
copia los `.wasm` a `web/public/mediapipe/wasm`, baja los modelos
(`hand_landmarker.task`, `blaze_face_short_range.tflite`) a `web/public/models/`
y las fuentes (`ArchivoBlack.ttf`, `Archivo.ttf`, `Parisienne.ttf`) a
`web/public/fonts/`. Todo gitignored. Para forzarlo: `npm -w web run prep:mediapipe`.

## Agregar canciones

Requiere `yt-dlp` (`pip install yt-dlp`). `ffmpeg` es opcional — si no está, baja
`.m4a` directo (lo reproducen Chrome/Edge igual).

```bash
node server/scripts/agregar-cancion.mjs "corre" "https://www.youtube.com/watch?v=-RZZrPVk-Ac" "Corre" "Jesse & Joy" "¿Con quién se queda el perro?"
```

Baja el audio a `server/canciones/corre/`, la letra sincronizada de
[lrclib.net](https://lrclib.net), y actualiza `canciones.json`. Reiniciá el server.

Si la letra va adelantada o atrasada respecto a la pista (pasa con las versiones
karaoke, que tienen otra intro), ajustala **en vivo con `[` y `]`** durante
PLAYING y guardá ese número en `"offsetLetra"` de la canción.

Ya viene con **"Corre" (Jesse & Joy)** de ejemplo (probada, en sync).

## Roadmap

1. ✅ Cámara + audio local + letra sincronizada.
2. ✅ Máquina de estados por WebSocket.
3. ✅ Frontend Astro + Vite.
4. ✅ Control **solo por cámara**: manos (MediaPipe) + voz + corazón.
5. ✅ Vuelve al inicio si no hay nadie 10 s.
6. ✅ Estética editorial / poster (sin luces), letra que entra en pantalla.
7. ⬜ Biblioteca de 5–10 canciones descargadas y procesadas.
8. ⬜ `ImageSegmenter` de MediaPipe: recortar a la persona sobre la estrella.
9. ⬜ `PoseLandmarker`: cuerpo en tinta + puntaje real de performance.
10. ⬜ Sensor ultrasónico (Arduino → serial/HTTP → `accion`).
11. ⬜ Grabación del video + descarga por QR con id único de sesión.
12. ⬜ Efectos de audio (Pedalboard) y mezcla de voz.
