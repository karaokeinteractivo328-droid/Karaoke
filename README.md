# Karaoke interactivo

Proyecto de **Redes y Tecnología** — Iara Churba, Yazmin Kussi, Rocío Prieto Valdez.

> Sentite un cantante profesional, viví tu era popstar.

Instalación de karaoke con estética **editorial / poster** (fondo crema, tipografía
negra bien grande, halftone, estrella magenta, grano de impresión — nada de luces
ni glow).

**Una sala, un QR, muchos participantes, una fila, una experiencia continua.**
Cualquiera puede llegar en cualquier momento, escanear el mismo QR, entender qué
hacer y participar sin interrumpir a nadie:

- La **pantalla grande es un escenario**: muestra a quien canta, la letra, los
  retos con manos y quién sigue. Nada más.
- Cada **celular es una segunda pantalla** con la vista que le toca (público,
  en fila, su turno, cantando, resultado, copiloto).
- La **canción se confirma con la mano**, frente a la cámara de la pantalla
  (el celu solo la *prepara*).

## Arquitectura

```
web/     -> frontend Astro + Vite (HTML + canvas 2D) + MediaPipe
server/  -> "el cerebro": Express + Socket.IO + escenario.js (estado y fila) + catalogo
```

Dos procesos. En dev el frontend corre con `astro dev` (:4321) y habla con el
cerebro (:3000) por WebSocket. `npm start` compila el frontend y lo sirve todo
desde el :3000.

```
                       [ celus /sala ]  (intents con token: fila, cancion, reaccion...)
                             │  ▲
                             ▼  │ estado publico + "yo" privado
[ camara/mic de la pantalla ] ─► [ server :3000 · escenario.js ] ◄─ salud, presencia, fin, retos
        (pantalla grande /)            (unica fuente de verdad)
```

Toda la lógica vive en [server/escenario.js](server/escenario.js): módulo
determinístico con reloj inyectable (se testea sin esperar tiempos reales). El
frontend solo muestra lo que dice el server y manda *intents*.

## Arranque

```bash
npm install       # baja tambien modelos de MediaPipe + fuentes (postinstall)
npm run dev
```

- **Pantalla grande**: http://localhost:4321/ (Chrome o Edge). La primera vez pide
  permiso de **cámara** y **micrófono**.
- **Celular**: el QR de la pantalla (o `http://IP-DE-TU-PC:4321/sala`, en la misma wifi).

`npm start` = build + todo en el :3000 (lo que usarías en el evento).

Tests: `npm -w server test` (24 casos con reloj falso). Hay además un script de
integración con sockets reales: `node server/test/integracion.mjs`.

### Modo kiosco (para que el audio suene solo, sin ningún click)

Los navegadores bloquean el audio hasta que hay una interacción real. Si la
primera canción arranca muda, aparece el chip **🔇 tocá la pantalla para activar el
sonido**. Para que ande siempre sin ningún click, abrí Chrome con:

```bash
chrome --autoplay-policy=no-user-gesture-required --kiosk http://localhost:3000/
```

Con `npm start` corriendo. Atajo útil en la pantalla: **`Ctrl+Alt+R`** = estado
seguro (cierra la performance actual y pasa al siguiente o a STANDBY).

## Cómo funciona

### El escenario (máquina global, 5 estados)

| Estado | Qué pasa | Sale a |
|---|---|---|
| `STANDBY` | Nadie cantando ni esperando: bienvenida + **QR único** + top de la noche | `CALLING` apenas alguien entra a la fila |
| `CALLING` | "TURNO DE X": elige/confirma la canción **con la mano** en la pantalla | `COUNTDOWN` (confirmó) · siguiente (timeout) |
| `COUNTDOWN` | 3-2-1 | `PLAYING` |
| `PLAYING` | Prioridad total al cantante: cámara, letra, retos, reacciones | `RESULT` |
| `RESULT` | Puntaje + desglose + reacciones + QR del video (15 s). Ya se avisó al siguiente | `CALLING` si hay fila, si no `STANDBY` |

Nunca se vuelve a `STANDBY` con gente en la fila, y todas las fases tienen timeout:
no existe "esperar para siempre".

### El participante (uno por persona, identificado por token)

`PUBLIC` (recién escaneó, mira y reacciona) → `QUEUED` (en fila, prepara su canción)
→ `CALLED` (le toca) → `SINGING` → `DONE` (ve su puntaje y su video) → de nuevo `PUBLIC`.
El **copiloto** es un rol, no un estado.

### Elegir la canción con la mano

En `CALLING` la pantalla muestra la lista y la persona se para frente a la cámara:

| Gesto | Acción |
|---|---|
| mano arriba / abajo | mover la selección |
| pellizco (pulgar + índice) ~1 s | confirmar |

Desde el celu, mientras espera, ya puede **preparar** su canción (queda resaltada
y es la que arranca por defecto). El botón **EMPEZAR** del celu es solo un
**respaldo**: aparece si la cámara no está sana o pasados 20 s de `CALLING`, para
que el escenario nunca se trabe.

### El celular (`/sala`, una página, una vista por rol)

| Rol | Ve |
|---|---|
| Público | quién canta (con barra de progreso), quién sigue, ❤️🔥👏 grandes, **🎤 Quiero cantar** |
| En fila | posición y tiempo estimado, buscador de canciones, solo/dúo, cancelar, **código de copiloto** |
| Su turno | "¡PASÁ AL FRENTE!" (vibra), canción preparada, respaldo "empezar desde el celu" |
| Cantando | su canción, reacciones en vivo, teleprompter, "Terminar" |
| Resultado | puntaje con desglose, **link privado a su video**, "Cantar de nuevo" |
| Copiloto | teleprompter de la letra; no puede controlar nada |

Se pide **Wake Lock** mientras espera (para que el celu no se bloquee) y, si se
corta la conexión, vuelve solo: la identidad es un token en `localStorage`, así
que cerrar el navegador o perder señal no hace perder el lugar.

### Puntaje (100 puntos, entendible)

`Canción (0–40)` = 40 × lo que se cantó · `Retos (0–30)` = retos con manos (tope 30) ·
`Público (0–30)` = ❤️×1 + 🔥×1,5 + 👏×1 (20 ponderadas = 30 puntos).

Las reacciones las cuenta el **server** y solo valen durante `PLAYING`; cada persona
cuenta hasta 15 y hay un límite de 4 por segundo, para que una sola no llene el
puntaje. Las performances interrumpidas muestran puntaje parcial y **no** se
guardan en el leaderboard.

### Casos que resuelve

| Caso | Qué hace el sistema |
|---|---|
| Llego y nadie canta | `fila:entrar` me deja primero: STANDBY → CALLING con mi nombre |
| Llego mientras alguien canta | entro como `PUBLIC`; "Quiero cantar" me suma a la fila |
| Quiero ser el próximo | me anoto y preparo la canción; se puede cambiar hasta el COUNTDOWN |
| El primero de la fila pierde conexión | gracia: 10 min en fila, 30 s si ya fue llamado; si vuelve con su token retoma donde estaba |
| El cantante abandona | celu desconectado >25 s, botón "Terminar", o cámara sana y nadie en cuadro >45 s: cierra con puntaje parcial y pasa al siguiente |
| Dos personas quieren el turno | el server procesa de a uno; el orden de llegada manda; `fila:entrar` es idempotente |
| Nadie interactúa | todo tiene timeout; si no queda nadie vuelve a STANDBY |
| Hay fila pero nadie canta | el watchdog (tick de 1 s) llama al siguiente |

### Recuperación (siempre a un estado seguro)

| Falla | Qué pasa |
|---|---|
| Se desconecta un celu | gracia por rol; reconexión automática por token; recibe el estado actual |
| Se cierra / recarga la pantalla | la fila vive en el server y no se reinicia; si pasaba en COUNTDOWN/PLAYING esa performance se cierra como interrumpida |
| Se reinicia el server | la pantalla vuelve a STANDBY; cada celu se vuelve a anotar solo con su canción (se pierde el orden exacto) |
| Falla la cámara | chip "sin cámara"; sin retos con manos; el celu puede arrancar el turno |
| Falla el micrófono | video sin voz; chip "sin micrófono" |
| Audio bloqueado | chip 🔇; un toque lo destraba (o modo kiosco) |
| Sin Internet | se sirve el audio **local** si existe (`server/canciones/<id>/<id>.m4a`); lo remoto falla en silencio y los puntajes se reintentan |
| La pantalla se cuelga en PLAYING | duración + 25 s sin `fin` → resultado forzado |
| Dos pantallas abiertas | la última que se conecta manda; las otras son **espejo** (chip 🪞) y no pueden mandar nada |

### Video privado

Al terminar, la pantalla graba un **video compuesto** (cámara + letra) con **audio de la
canción + la voz**, lo sube al server y se convierte a **.mp4** con ffmpeg. El link
lleva un token de 32 caracteres que solo recibe la persona (en su celu y en el QR del
resultado). Solo se acepta una subida por performance, hasta 150 MB, y los videos se
**borran a las 6 horas**.

## Deploy online (Vercel + Render)

El frontend y el backend se despliegan por separado porque el "cerebro" necesita
quedar siempre prendido (Socket.IO + estado en memoria + `ffmpeg`).

- **Backend (`server/`) → Render** (o cualquier host de Node persistente):
  - Build command: `npm install`
  - Start command: `npm -w server run start`
  - Variables: `PUBLIC_BACKEND_URL` (URL de Render), `PUBLIC_FRONTEND_URL` (URL de
    Vercel; el QR de la sala apunta a `<front>/sala`), `SUPABASE_URL` y
    `SUPABASE_SERVICE_ROLE_KEY` (opcionales, para el leaderboard).
- **Frontend (`web/`) → Vercel**: el `vercel.json` de la raíz ya compila solo `web/`.
  Variable: `PUBLIC_SOCKET_URL` = URL de Render.

`main` se despliega solo en las dos plataformas.

⚠️ En el plan gratis de Render el servicio **se duerme** tras ~15 min sin uso y el
disco no es persistente. Para un evento real: usar el modo local (kiosco), o un
monitor de uptime que pida `GET /healthz` cada pocos minutos (también sirve para
ver de un vistazo si el escenario está vivo).

> 🔑 Las claves de Supabase van **solo** en las variables de entorno de Render. Nunca
> en el repo ni en el chat.

### Tiempos configurables

`ESCENARIO_CONFIG='{"RESULT_MS":3000}'` (JSON) pisa cualquier valor de
`CONFIG_BASE` en [server/escenario.js](server/escenario.js): tiempos de llamado,
gracias por desconexión, duración del resultado, etc. Sirve para demos y tests.

## Control por cámara

[web/src/lib/vision.js](web/src/lib/vision.js) corre sobre el video:
- `HandLandmarker` (hasta **4 manos**: cantante + copiloto), con **filtro One Euro**
  ([oneEuro.js](web/src/lib/oneEuro.js)) para que el esqueleto no tiemble.
- `FaceDetector`: ¿hay una persona en cuadro? (alimenta el abandono).

[web/src/lib/manos.js](web/src/lib/manos.js) traduce los gestos: scroll y pellizco
para elegir canción, **corazón** (dos manos) como efecto, y los datos para los retos.
Con varias personas las manos se separan por mitad de cámara (izquierda/derecha):
es una heurística por posición, no reconocimiento de personas.

### Retos con manos

En `PLAYING` aparecen carteles ("manos arriba", "corazón", "puño", "paz"…) y si se
cumplen suman puntos ([web/src/lib/retos.js](web/src/lib/retos.js)). También hay
"palabra tapada" en la letra.

## Estética / archivos del look

| Archivo | Qué hace |
|---|---|
| [styles/global.css](web/src/styles/global.css) | todo el look: crema + negro + magenta, tipografía Archivo Black / Parisienne, halftone, grano, layout por estado |
| [lib/escenario.js](web/src/lib/escenario.js) | arma la estrella, la hace latir con la música, cambia de tono según las manos |
| [lib/camaraCanvas.js](web/src/lib/camaraCanvas.js) | cámara + esqueleto estilo tinta + guías de selección |

## Assets offline

`npm install` corre [web/scripts/preparar-mediapipe.mjs](web/scripts/preparar-mediapipe.mjs):
copia los `.wasm` a `web/public/mediapipe/wasm`, baja los modelos
(`hand_landmarker.task`, `blaze_face_short_range.tflite`) a `web/public/models/`
y las fuentes a `web/public/fonts/`. Todo gitignored. Para forzarlo: `npm -w web run prep:mediapipe`.

## Agregar canciones

Requiere `yt-dlp` (`pip install yt-dlp`). `ffmpeg` es opcional.

```bash
node server/scripts/agregar-cancion.mjs "corre" "https://www.youtube.com/watch?v=-RZZrPVk-Ac" "Corre" "Jesse & Joy" "¿Con quién se queda el perro?"
```

Baja el audio a `server/canciones/corre/`, la letra sincronizada de
[lrclib.net](https://lrclib.net), y actualiza `canciones.json`. Reiniciá el server.
Para que suene online, subí el audio al bucket `canciones` de Supabase Storage
(`server/subir-audio-supabase.mjs`) y dejá la URL en `canciones.json`.

Si la letra va adelantada o atrasada respecto a la pista, ajustala **en vivo con `[` y
`]`** durante PLAYING y guardá ese número en `"offsetLetra"` de la canción.

## MVP vs funciones futuras

**MVP (hecho):** una sala con QR estable, fila dinámica, celu por rol, canción elegida
con la mano, retos, puntaje en 3 partes, copiloto, video privado, recuperación de
fallas y leaderboard en Supabase.

**Futuro:** fondos/escenarios elegibles y segmentación de persona, votación del
público y desafíos grupales, dúo con segundo participante en su propio celu, medir la
voz por micrófono para el puntaje, notificaciones push reales (hoy: vibración + wake
lock), panel de operador (`/admin`), fila persistida en Supabase para sobrevivir
reinicios, sensor ultrasónico/Arduino, moderación de nombres.

Más ideas en [docs/investigacion-features.md](docs/investigacion-features.md).
