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
- La **canción se elige SOLO desde el celu** (buscador + preparación del audio). La
  pantalla nunca se usa para navegar canciones y los gestos son solo para los retos.
- Una canción **no se marca "lista" por tener una URL**: tiene que estar descargada,
  validada y probada en el navegador de la pantalla. Nunca se empieza sin audio.

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

### Tests

```bash
npm -w server test                  # 100 casos con reloj falso: fila, audio, catálogo, retos, palabra
npm -w web test                     # 89 casos: tracking, gestos, retos, reloj, precarga, buscador y reproductor de YouTube
npm -w server run test:integracion  # sockets REALES (3 suites, ver abajo)
```

Las integraciones levantan el server en otro puerto, simulan pantalla + celus y **lo
reinician de verdad**: convierten un video real a mp4 con ffmpeg (`integracion2`) y prueban
la búsqueda y la elección de canciones **sin Internet** con una YouTube Data API y un lrclib
simulados (`integracion3`: filtro karaoke, no embebibles, paginación, cuota, clave inválida,
reinicio con una canción de YouTube en la fila).

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
| `CALLING` | "TURNO DE X": se ve qué va a cantar y si su **audio está listo**; el celu toca **LISTO** | `COUNTDOWN` (LISTO) · siguiente (timeout o audio roto) |
| `COUNTDOWN` | 3-2-1 | `PLAYING` |
| `PLAYING` | Prioridad total al cantante: cámara, letra, retos, reacciones | `RESULT` |
| `RESULT` | Puntaje + desglose + reacciones + QR del video (15 s). Ya se avisó al siguiente | `CALLING` si hay fila, si no `STANDBY` |

Nunca se vuelve a `STANDBY` con gente en la fila, y todas las fases tienen timeout:
no existe "esperar para siempre".

### El participante (uno por persona, identificado por token)

`PUBLIC` (recién escaneó, mira y reacciona) → `QUEUED` (en fila, prepara su canción)
→ `CALLED` (le toca) → `SINGING` → `DONE` (ve su puntaje y su video) → de nuevo `PUBLIC`.
El **copiloto** es un rol, no un estado.

### Canciones: YouTube (búsqueda + reproductor embebido)

**Se elige solo desde el celu** (🎵 ¿qué querés cantar?): buscador con *debounce* de 350 ms,
resultados que se cancelan si seguís escribiendo, tarjetas con **miniatura, título, canal,
duración, insignia KARAOKE y botón ELEGIR**, estados de carga / vacío / error con
**Reintentar**, y paginación con el `nextPageToken` de YouTube (scroll infinito).

**La única fuente de canciones es la YouTube Data API v3** — [server/youtube.js](server/youtube.js):

| Pieza | Qué hace |
|---|---|
| `search.list` | `type=video`, `videoEmbeddable=true`, `videoSyndicated=true`, `regionCode=AR` (100 unidades de cuota por búsqueda) |
| `videos.list` | duración real y verificación: se descartan los videos **no embebibles, privados, en vivo, con restricción de edad o de región** (1 unidad) |
| Reproducción | **solo el reproductor oficial embebido** (IFrame API) en la pantalla grande. **No se descarga ni se extrae audio ni video de YouTube.** La canción es un `videoId` |
| Letra | si el video de karaoke ya trae la letra (lo normal) se ve grande; si además lrclib tiene letra sincronizada compatible (opcional) se dibuja la nuestra y el video queda chico en una esquina |
| Biblioteca local | las canciones de `server/canciones` siguen sonando **sin Internet ni clave** |

**Filtro karaoke** — [server/karaoke.js](server/karaoke.js): no es una sola consulta. Se arma un
plan (`"<texto> karaoke"`, `"<texto> instrumental"`, `"<texto> sing along / backing track"`…),
se corre lo mínimo para tener suficientes aptos, se junta, se deduplica y se **puntúa** cada
video con tablas de reglas fáciles de editar (`A_FAVOR`, `EN_CONTRA`, `CANALES_KARAOKE`,
`UMBRAL`): suman karaoke / instrumental / sing along / backing track / vocal removal / minus
one / karaoke version / lyrics; restan official music video / live / concert / reaction / cover /
remix / full album **salvo que el título ya diga karaoke**. También cuentan la relevancia
contra lo que escribiste y que la duración sea plausible. No es estricto: solo se excluye lo
claramente inservible y **nunca se devuelve una lista vacía si YouTube devolvió algo** (se
muestran los mejores candidatos, los karaoke primero).

**Qué se guarda al elegir**: `videoId`, título, canal, miniatura, duración, `searchQuery`
(con qué se lo encontró) y `karaokeScore` (+ `origen`, `esKaraoke`).

**Cuota y clave.** Hace falta `YOUTUBE_API_KEY` (variable de entorno del server, **nunca en el
repo ni en un chat**). Cuota gratuita: 10.000 unidades/día ≈ 100 búsquedas nuevas; el server corta en
9.500, cachea 6 h, junta pedidos iguales y limita por IP. Si se agota o la clave es inválida, el
celu muestra un mensaje claro y **la biblioteca local sigue disponible**.

**Preparación ANTES del turno.** Apenas elegís una canción el server la **verifica con la API**
y la pantalla —que es la que suena— carga el reproductor de YouTube. "Lista" = verificada por
el server + reproductor cargado en esa pantalla. Durante la **cuenta regresiva 3-2-1** el
video se carga **en silencio** y queda en pausa en 0:00, así que al empezar solo se da play.

| Estado que ve el celu | Significa |
|---|---|
| ⏳ Preparando el audio… | se está verificando / cargando el reproductor en la pantalla |
| ✅ Audio listo | verificada + reproductor cargado + sonido habilitado |
| 🔇 Falta activar el sonido | el navegador de la pantalla tiene el audio bloqueado |
| ⚠️ No se pudo preparar el audio | con el motivo (p. ej. *"el dueño no permite reproducirlo fuera de YouTube"*); **Reintentar** / **Elegir otra canción** |

`LISTO` está **deshabilitado** hasta que todo esté listo y el server lo rechaza igual. Si el
reproductor falla en plena canción (códigos 2/5/100/101/150, autoplay bloqueado) la
performance se cierra con el motivo en vez de cantar en silencio.

**Sonido en la instalación física.** El navegador exige un toque para habilitar el audio (o
Chrome en modo kiosco, ver abajo): hasta entonces la pantalla muestra **"🔊 Tocá la pantalla
para activar el sonido"**. Con YouTube el sonido sale del iframe y **no pasa por el Web Audio
API**: no se puede medir la señal (sí que esté reproduciendo, con volumen y sin silencio).
⚠️ Por lo mismo, **el video grabado (mp4) lleva cámara + letra + tu voz, pero no la música de YouTube**.

**Diagnóstico.** `[SONG]` / `[AUDIO]` / `[AUDIO ERROR]` en la consola de la pantalla
(`window.__karaoke.diagnostico()`).

Variables del server: `YOUTUBE_API_KEY`, `YOUTUBE_API_BASE` (solo para pruebas), `LRCLIB_URL`,
`CACHE_AUDIO_DIR` (solo guarda letras `.lrc`).

### El celular (`/sala`, una página, una vista por rol)

| Rol | Ve |
|---|---|
| Público | quién canta (con barra de progreso), quién sigue, ❤️🔥👏 grandes, **🎤 Quiero cantar** |
| En fila | posición y tiempo estimado, **buscador de canciones** con estado del audio, solo/dúo, cancelar, **código de copiloto** |
| Su turno | "¡PASÁ AL FRENTE!" (vibra), estado del audio y **¡LISTO!** (solo se habilita con el audio listo) |
| Cantando | su canción, reacciones en vivo, teleprompter, "Terminar" |
| Resultado | puntaje con desglose, **link privado a su video**, "Cantar de nuevo" |
| Copiloto | teleprompter de la letra; no puede controlar nada |

Se pide **Wake Lock** mientras espera (para que el celu no se bloquee) y, si se
corta la conexión, vuelve solo: la identidad es un token en `localStorage`, así
que cerrar el navegador o perder señal no hace perder el lugar.

**La identidad viaja en el handshake de Socket.IO** (`auth`: token + nombre + lo que
estaba haciendo), que se evalúa en *cada* reconexión. Así la conexión ya nace
registrada: después de reiniciar el server, el primer toque en "Quiero cantar" o
"Empezar" funciona (antes podía llegar antes que el `hola` y el server contestaba
"Sin sesión").

### Solo o dúo (cualquier canción)

**Todas las canciones se pueden cantar solo o a dúo** y lo elige la persona con el selector
**🎤 Solo / 👥 Dúo** del celu (mientras espera o cuando le toca). La pantalla grande muestra
"solo" o "a dúo · voz 1 y voz 2" en el turno.

- En dúo la letra se reparte sola entre **VOZ 1** (quien canta) y **VOZ 2** (su compañero/a,
  que entra con el código de copiloto) y **LOS DOS** en los estribillos, cada voz de un color
  ([duo.js](web/src/lib/duo.js)). Arriba de cada línea dice "VOZ 1 · IARA" / "VOZ 2 · ROCÍO".
- Los celus también lo dicen: **🎤 Te toca a vos** / **⏳ Le toca a Rocío** / **🎶 Los dos**.
- Cambiar de canción no cambia la elección. El modo se puede cambiar hasta que arranca el turno.

### Puntaje (100 puntos, entendible)

`Canción (0–40)` = 40 × lo que se cantó · `Retos (0–30)` = 3 retos de 10 puntos ·
`Público (0–30)` = ❤️×1 + 🔥×1,5 + 👏×1 (20 ponderadas = 30 puntos).

Los puntos de retos **los lleva el server** (cada reto se registra por id, una sola vez,
con tope de 30): si la pantalla se recarga a mitad de la canción no se pierden.

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
| Falla la cámara | chip "sin cámara"; sin retos con manos; todo lo demás sigue (el turno es del celu) |
| Falla el micrófono | video sin voz; chip "sin micrófono" |
| Audio bloqueado / roto | cartel "tocá la pantalla para activar el sonido"; el escenario no arranca sin sonido; audio que falla en plena canción = performance cerrada con el motivo |
| Sin Internet | se sirve el audio **local** si existe (`server/canciones/<id>/<id>.m4a`); lo remoto falla en silencio y los puntajes se reintentan |
| La pantalla se cuelga en PLAYING | duración + 25 s sin `fin` → resultado forzado |
| Dos pantallas abiertas | la última que se conecta manda; las otras son **espejo** (chip 🪞) y no pueden mandar nada |

### Video privado

Al terminar, la pantalla graba un **video compuesto** (cámara + letra) con **audio de la
canción + la voz**, lo sube al server y se convierte a **.mp4** con ffmpeg. El link
lleva un token de 32 caracteres que solo recibe la persona (en su celu y en el QR del
resultado). Solo se acepta una subida por performance, hasta 150 MB, y los videos se
**borran a las 6 horas**.

Cada video tiene su **estado** (`GET /api/video/<token>/estado`) y el celu lo consulta solo:

| Estado | Qué ve la persona |
|---|---|
| `esperando` | 🎥 Procesando tu video… (la pantalla todavía lo está enviando) |
| `procesando` | 🎥 Procesando tu video… (se está convirtiendo a mp4) |
| `listo` | 🎥 Tu video está listo → **Ver / descargar** (y el celu vibra) |
| `error` | no pudimos prepararlo (si la conversión falló pero el archivo llegó, se ve igual en webm) |
| `desconocido` | el video ya no está (token inexistente o borrado) |

La pantalla reintenta la subida y, si no hay caso, avisa al server (`pantalla:videoError`)
para que el celu muestre un error claro en vez de esperar para siempre.

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

## Control por cámara: tracking y gestos separados

```
vision.js  ──detecciones crudas──►  seguimiento.js  ──tracks estables──►  manos.js  ──gestos──►  retos.js / pantalla.js
(MediaPipe)                         (TRACKING)                            (GESTOS)
```

- [vision.js](web/src/lib/vision.js) **solo detecta**: `HandLandmarker` (hasta **4 manos**:
  cantante + copiloto) y `FaceDetector` (hay una persona + dónde está la cara).
- [seguimiento.js](web/src/lib/seguimiento.js) **solo sabe dónde están las manos**: les da un
  `id` que persiste entre frames (por cercanía, no por la etiqueta Left/Right de
  MediaPipe), un filtro One Euro **por mano**, descarta detecciones duplicadas, conserva
  250 ms una mano que se pierde un frame y calcula izquierda/derecha con histéresis.
- [manos.js](web/src/lib/manos.js) **solo interpreta**: mano arriba, saludo, corazón y
  pellizco. Nunca decide con un frame suelto.

Qué corregía esto: antes el filtro se guardaba por *etiqueta* de mano y con dos manos
MediaPipe suele repetir la etiqueta, así que las dos compartían filtro y se mezclaban.

| Gesto | Cómo se reconoce |
|---|---|
| **0 / 1 / 2 manos arriba** | el centro de la palma está **por encima del mentón** (o de la mitad del cuadro si no se ve la cara), con histéresis y 200 ms de estabilidad. Dos "manos" muy juntas son una sola mal detectada. Con copiloto (3+ manos) "dos" = una por lado |
| **Saludo** | la mano **va y viene de lado a lado** (≥2 inversiones de dirección en ~1 s, aunque el movimiento sea chico). Una mano quieta o que solo se mueve de un lugar a otro no cuenta. Cooldown de 2,5 s |
| **Corazón** | pulgares e índices de las dos manos juntos |
| **Pellizco** | pulgar + índice; **sostenido** para confirmar (lista de canciones u opciones del reto) |

Si la cámara anda pero MediaPipe no carga (antes era **silencioso** y los retos con manos
simplemente no aparecían), ahora sale un chip 🖐️ y el escenario lo trata como cámara
caída: los retos con gestos se saltean y el reto de la palabra sigue funcionando.

### Retos durante la canción

[retos.js](web/src/lib/retos.js) arma, para cada performance, un **plan de 3 retos de 10
puntos** (tope 30), atado a la canción:

- Cada reto arranca en el **comienzo de una línea de letra**, en segundos de **audio** (el
  mismo reloj que la letra: nada de temporizadores propios que se desfasen).
- El cartel dice qué hacer, cuánto vale y cuánto tiempo queda. Mientras se sostiene el
  gesto se llena una línea verde: la persona ve que la detecta.
- Un gesto cuenta recién cuando se **sostiene** (≈0,4 s, con tolerancia al parpadeo). Una
  vez cumplido, el reto termina: aunque mantengas las manos arriba 3 s, suma **una** vez.
- Al cumplirse: **✓ ¡LO HICISTE! +10 PUNTOS**. Si se acaba el tiempo, termina sin puntos.
- Sin cámara o sin tracking, los retos de gestos se saltean y la canción sigue.

Gestos disponibles: ✋ una mano · 🙌 dos manos · 👋 saludo · 💖 corazón · ✊ puño alto ·
✌️ paz · 👆 señalar al cielo.

### Reto de la palabra

Una palabra de la letra se tapa (▧▧▧) y aparecen **3 opciones** en pantalla (la correcta
y dos palabras de la misma canción). Se contesta:

- con la **mano**: moverla hasta la opción (izquierda / centro / derecha) y **pellizcar
  sostenido** (la barra verde de la opción se llena), o
- desde el **celu** del cantante o del copiloto, tocando la palabra (mientras dura el reto
  el teleprompter se oculta para no regalar la respuesta).

El server **guarda la respuesta correcta** (nunca viaja en el estado público), compara,
suma los 10 puntos si acierta y avisa a todos (`reto:resultado`): la pantalla muestra
*✓ ¡Era «noche»! +10* o *✗ Era «noche»* y revela la palabra en la letra. Cerrar el puño
**no** responde nada.

### Letra sincronizada con el audio

[reloj.js](web/src/lib/reloj.js) es la única fuente de verdad para la letra, los retos, la
barra de progreso y el fin. Antes la letra usaba un reloj propio desde que arrancaba
PLAYING y *saltaba* al audio cuando este empezaba a sonar (si tardaba en cargar, salía
adelantada y daba un salto; lo mismo en cada pausa o buffering).

- Mientras el audio no suena, el tiempo **no avanza**; cuando suena, el tiempo **es**
  `audio.currentTime` (interpolado entre actualizaciones).
- El audio y la letra se **precargan durante el 3-2-1**.
- `tiempo de letra = audio − offsetLetra − latencia de salida + 0,1 s` (la letra se lee un
  instante antes de cantarse).
- Los tiempos de cada palabra tienen tope: un instrumental largo no estira las últimas
  palabras de una línea.
- Ajuste en vivo con **`[` y `]`** (0,2 s por toque): queda **guardado por canción** en esa
  pantalla y se escribe en la consola para pegarlo en `"offsetLetra"` de `canciones.json`.

## El QR de la sala

El **QR general** (entrar a la sala) está **siempre en la pantalla**: grande en STANDBY y
chico y discreto (abajo a la derecha, "UNITE") durante el resto, incluso mientras alguien
canta. Es estable (`<front>/sala`, sin código, no cambia al reiniciar). **No** es el QR del
video: ese solo aparece en el resultado y lleva el token privado de esa performance.

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

## Agregar canciones a la biblioteca local

(Esto es solo para la **biblioteca** que suena sin Internet: cualquier otra canción se busca desde el celu.)

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

**MVP (hecho):** una sala con QR estable, fila dinámica, celu por rol, **búsqueda de
canciones desde el celu con audio precargado y validado**, retos, puntaje en 3 partes,
copiloto, video privado, recuperación de fallas y leaderboard en Supabase.

**Futuro:** fondos/escenarios elegibles y segmentación de persona, votación del
público y desafíos grupales, dúo con segundo participante en su propio celu, medir la
voz por micrófono para el puntaje, notificaciones push reales (hoy: vibración + wake
lock), panel de operador (`/admin`), fila persistida en Supabase para sobrevivir
reinicios, sensor ultrasónico/Arduino, moderación de nombres.

Más ideas en [docs/investigacion-features.md](docs/investigacion-features.md).
