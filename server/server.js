// El cerebro del karaoke interactivo: UNA sala, UN QR, UNA fila.
//
// - server/escenario.js lleva toda la logica (escenario + participantes + fila).
//   Este archivo solo la conecta con el mundo: Socket.IO, HTTP, video, Supabase.
// - Cada celu se identifica con un token (lo guarda en localStorage), asi puede
//   recargar o perder conexion y retomar. Los intents de los celus se autorizan
//   siempre por ese token; la pantalla grande es "primaria" (la ultima que se
//   conecta) y es la unica que puede reportar fin de cancion, letra y salud.
// - En produccion (npm start) tambien sirve el frontend Astro compilado.
//
// En dev el frontend corre aparte con `astro dev` (:4321) y se conecta a este
// socket por su URL absoluta; por eso habilitamos CORS.

import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFile, mkdir, writeFile, rm, rename, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import ffmpegPath from 'ffmpeg-static';

import { crearEscenario } from './escenario.js';
import { guardarPuntaje, obtenerLeaderboard } from './supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const WEB_PORT = process.env.WEB_PORT || 4321; // astro dev
const DIST = join(__dirname, '..', 'web', 'dist');
// Servir el frontend compilado solo cuando se pide explicitamente (npm start).
const SERVIR_BUILD = process.env.SERVE_BUILD === '1' && existsSync(DIST);

// URLs publicas cuando esta deployado (frontend en Vercel, backend en Render):
// si estan seteadas las usamos tal cual; si no, asumimos el modo kiosco local
// (todo en la misma red wifi, direccionado por IP).
const FRONTEND_PUBLICO = process.env.PUBLIC_FRONTEND_URL?.replace(/\/$/, '');
const BACKEND_PUBLICO = process.env.PUBLIC_BACKEND_URL?.replace(/\/$/, '');

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Un error suelto nunca debe dejar la instalacion fisica muerta.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// --- Catalogo de canciones ---------------------------------------------
// Si el audio esta en disco (modo kiosco, sin depender de Internet) se sirve
// local; si no (Render), cae a la URL de Supabase Storage de canciones.json.
async function cargarCanciones() {
  try {
    const raw = await readFile(join(__dirname, 'canciones', 'canciones.json'), 'utf8');
    const lista = JSON.parse(raw);
    for (const c of lista) {
      const remoto = /^https?:\/\//.test(c.audio || '') ? c.audio : null;
      const local = remoto ? `/canciones/${c.id}/${c.id}.m4a` : c.audio;
      if (local && existsSync(join(__dirname, local))) {
        c.audioRemoto = remoto;
        c.audio = local;
      }
    }
    return lista;
  } catch (err) {
    console.warn('[canciones] no pude leer canciones.json:', err.message);
    return [];
  }
}

const canciones = await cargarCanciones();

// --- Sockets y sesiones --------------------------------------------------
let pantallaPrimaria = null; // socket.id de la pantalla grande "de verdad"
let pantallaPid = ''; // id de carga de pagina de esa pantalla (distingue reconexion de recarga)
const tokenPorSocket = new Map(); // socket.id -> token del participante
const socketsPorToken = new Map(); // token -> Set(socket.id) (puede tener 2 pestañas)
let ultimaLetra = null; // para que un celu que entra a mitad de cancion vea la linea actual
const videoTokens = new Map(); // videoToken -> cuando se creo (habilita la subida)

function emitirTodo() {
  const snap = escenario.snapshot();
  if (snap.etapa !== 'PLAYING') ultimaLetra = null;
  for (const [id, socket] of io.sockets.sockets) {
    if (id === pantallaPrimaria) socket.emit('estado', { ...snap, privado: escenario.privadoPantalla() });
    else socket.emit('estado', snap);
    const token = tokenPorSocket.get(id);
    if (token) socket.emit('yo', escenario.yo(token));
  }
}

const reaccionesAEmoji = (r = {}) => ({
  '❤️': r.corazon || 0,
  '🔥': r.fuego || 0,
  '👏': r.aplauso || 0,
});

const escenario = crearEscenario({
  canciones,
  // ESCENARIO_CONFIG='{"RESULT_MS":3000}' permite achicar tiempos (tests, demos)
  config: JSON.parse(process.env.ESCENARIO_CONFIG || '{}'),
  log: (m) => console.log(m),
  onCambio: emitirTodo,
  onRonda: ({ videoToken }) => videoTokens.set(videoToken, Date.now()),
  onRetoResultado: (r) => io.emit('reto:resultado', r),
  onResultado: ({ rondaId, nombre, cancion, resultado }) => {
    guardarPuntaje({
      sesionId: rondaId,
      nombre,
      puntaje: resultado.total,
      cancion,
      reacciones: reaccionesAEmoji(resultado.reacciones),
    });
  },
});

// El watchdog: una vez por segundo hace avanzar timeouts, gracias de
// reconexion, countdown y abandonos. Es lo que hace que nunca se trabe.
setInterval(() => {
  try {
    escenario.tick();
  } catch (e) {
    console.error('[watchdog] error en tick:', e);
  }
}, 1000);

// --- API -----------------------------------------------------------------
app.get('/api/canciones', (_req, res) => res.json(canciones));
app.use('/canciones', express.static(join(__dirname, 'canciones')));

app.get('/api/leaderboard', async (_req, res) => {
  res.json(await obtenerLeaderboard(10));
});

// Para un monitor de uptime (Render free se duerme sin trafico) y para ver
// de un vistazo si el escenario esta vivo.
app.get('/healthz', (_req, res) => {
  const s = escenario.snapshot();
  res.json({ ok: true, etapa: s.etapa, fila: s.filaTotal, pantalla: s.pantalla, uptime: Math.round(process.uptime()) });
});

// --- Grabaciones: la pantalla sube el .webm, el server lo pasa a .mp4 con
//     ffmpeg, y el celular lo baja con un link privado (token imposible de
//     adivinar, asociado a esa performance) ---
const GRAB = join(__dirname, 'grabaciones');
await mkdir(GRAB, { recursive: true });
const idOk = (s) => /^[A-Za-z0-9]{4,40}$/.test(s || '');
const enProceso = new Set();
const videoErrores = new Map(); // token -> motivo (conversion o subida fallida)
const ESPERA_SUBIDA_MS = 4 * 60 * 1000; // si la pantalla no sube nada en este tiempo, se da por perdido
const RETENCION_VIDEO_MS = 6 * 60 * 60 * 1000; // el video se borra a las 6 h

// Si el server se reinicia (o se cuelga) a mitad de una conversion, puede
// quedar un *.tmp.mp4 huerfano de una vez anterior: nunca es valido, lo
// limpiamos al arrancar para que no confunda el estado de "listo".
for (const f of await readdir(GRAB).catch(() => [])) {
  if (f.endsWith('.tmp.mp4')) await rm(join(GRAB, f), { force: true }).catch(() => {});
}

// Privacidad + disco: los videos viejos se borran solos (una instalacion
// fisica que corre horas no puede llenarse de grabaciones).
setInterval(async () => {
  const limite = Date.now() - RETENCION_VIDEO_MS;
  for (const [t, creado] of videoTokens) if (creado < limite) { videoTokens.delete(t); videoErrores.delete(t); }
  for (const f of await readdir(GRAB).catch(() => [])) {
    try {
      const st = await stat(join(GRAB, f));
      if (st.mtimeMs < limite) await rm(join(GRAB, f), { force: true });
    } catch {}
  }
}, 10 * 60 * 1000).unref();

// Convierte a un archivo TEMPORAL y recien al final lo renombra al .mp4
// definitivo. Asi, si ffmpeg se cuelga, lo matamos, o el server se reinicia
// a mitad de camino, JAMAS queda un .mp4 a medio escribir sirviendose como
// si estuviera listo (eso es lo que rompia la descarga).
function aMp4(sesion) {
  const webm = join(GRAB, `${sesion}.webm`);
  const tmp = join(GRAB, `${sesion}.tmp.mp4`);
  const mp4 = join(GRAB, `${sesion}.mp4`);
  enProceso.add(sesion);
  const args = [
    '-y',
    '-fflags', '+genpts+igndts', // el webm de MediaRecorder no trae timestamps prolijos
    '-i', webm,
    // 'ultrafast': en Render free la CPU es compartida/lenta y un evento en vivo
    // no puede esperar 3 minutos por cada video; se pierde algo de compresion
    // (archivos un poco mas grandes) a cambio de convertir bastante mas rapido.
    // MediaRecorder entrega cuadros a ritmo variable: se fija a 30 fps constantes y
    // rango de color estandar (tv), que es lo que esperan todos los reproductores (iOS incluido)
    '-vf', 'scale=out_range=tv,format=yuv420p', '-r', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-max_muxing_queue_size', '4096',
    '-movflags', '+faststart',
    tmp,
  ];
  const proc = execFile(
    ffmpegPath || 'ffmpeg',
    args,
    { maxBuffer: 1 << 26, timeout: 15 * 60 * 1000 },
    async (err, _stdout, stderr) => {
      enProceso.delete(sesion);
      if (err) {
        videoErrores.set(sesion, 'conversion');
        console.warn(`[video] ffmpeg fallo (${sesion}):`, err.message.split('\n')[0]);
        console.warn((stderr || '').split('\n').slice(-15).join('\n'));
        await rm(tmp, { force: true }).catch(() => {});
        return;
      }
      // sanity check: que el resultado exista, pese algo, y sea decodificable
      try {
        const st = await stat(tmp);
        if (st.size < 10_000) throw new Error(`mp4 sospechosamente chico (${st.size}B)`);
        await validarMp4(tmp);
      } catch (e) {
        videoErrores.set(sesion, 'conversion');
        console.warn(`[video] mp4 invalido para ${sesion}:`, e.message);
        await rm(tmp, { force: true }).catch(() => {});
        return;
      }
      await rename(tmp, mp4);
      console.log(`[video] ${sesion}.mp4 listo`);
      await rm(webm, { force: true }).catch(() => {});
    }
  );
  return proc;
}

// Re-decodifica el archivo (sin generar salida) para confirmar que el mp4
// que armamos realmente abre. Barato comparado con el encode en si.
function validarMp4(path) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath || 'ffmpeg',
      ['-v', 'error', '-i', path, '-t', '1', '-f', 'null', '-'],
      { timeout: 30_000 },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    );
  });
}

// Solo se acepta la subida del token de una performance real (lo emite el
// escenario al empezar el countdown), una sola vez, con tope de tamaño.
app.post(
  '/api/video/:token',
  express.raw({ type: ['video/webm', 'application/octet-stream'], limit: '150mb' }),
  async (req, res) => {
    const token = req.params.token;
    if (!idOk(token) || !videoTokens.has(token)) return res.sendStatus(403);
    if (!req.body?.length) return res.sendStatus(400);
    if (enProceso.has(token) || existsSync(join(GRAB, `${token}.webm`)) || existsSync(join(GRAB, `${token}.mp4`))) {
      return res.sendStatus(409);
    }
    await writeFile(join(GRAB, `${token}.webm`), req.body);
    console.log(`[video] recibido ${token}.webm (${(req.body.length / 1e6).toFixed(1)} MB) -> convirtiendo`);
    res.json({ ok: true });
    aMp4(token);
  }
);

// Estado del video de UNA performance (cada una tiene su propio token):
//   desconocido  el token no existe (o ya se borro)
//   esperando    la performance existe pero la pantalla todavia no subio el video
//   procesando   llego el archivo y se esta convirtiendo a mp4
//   listo        el mp4 se puede ver / descargar
//   error        la subida o la conversion fallaron (si hay webm, igual se puede ver)
function estadoVideo(token) {
  const mp4 = existsSync(join(GRAB, `${token}.mp4`));
  const webm = existsSync(join(GRAB, `${token}.webm`));
  if (mp4) return { estado: 'listo', mp4: true, webm: false };
  if (enProceso.has(token)) return { estado: 'procesando', mp4: false, webm };
  if (videoErrores.has(token)) return { estado: 'error', mp4: false, webm, motivo: videoErrores.get(token) };
  if (webm) return { estado: 'procesando', mp4: false, webm };
  const creado = videoTokens.get(token);
  if (creado == null) return { estado: 'desconocido', mp4: false, webm: false };
  if (Date.now() - creado > ESPERA_SUBIDA_MS) return { estado: 'error', mp4: false, webm: false, motivo: 'subida' };
  return { estado: 'esperando', mp4: false, webm: false };
}

app.get('/api/video/:token/estado', (req, res) => {
  const t = req.params.token;
  if (!idOk(t)) return res.status(404).json({ estado: 'desconocido' });
  const e = estadoVideo(t);
  res.json({ estado: e.estado, url: e.estado === 'listo' ? `/video/${t}` : null, motivo: e.motivo || null });
});

// `/video/<token>.mp4` / `.webm` = archivo ; `/video/<token>` = pagina.
app.get('/video/:archivo', (req, res) => {
  const a = req.params.archivo;
  for (const ext of ['.mp4', '.webm']) {
    if (a.endsWith(ext)) {
      const s = a.slice(0, -ext.length);
      const f = join(GRAB, `${s}${ext}`);
      if (!idOk(s) || !existsSync(f)) return res.sendStatus(404);
      return res.sendFile(f);
    }
  }
  if (!idOk(a)) return res.sendStatus(404);
  const e = estadoVideo(a);
  const pagina = (cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tu video · Karaoke</title>
<style>body{margin:0;background:#0a0716;color:#f2eee5;font-family:system-ui,sans-serif;text-align:center;padding:24px}
h1{font-weight:800}video{width:100%;max-width:520px;border-radius:14px;background:#000}
a.btn{display:inline-block;margin-top:16px;background:#ec2f80;color:#fff;font-weight:700;text-decoration:none;padding:14px 22px;border-radius:999px}
p{opacity:.75}.spin{font-size:2rem;animation:g 1.2s linear infinite;display:inline-block}@keyframes g{to{transform:rotate(360deg)}}</style></head><body>${cuerpo}</body></html>`;
  const recarga = (ms) => `<script>setTimeout(()=>location.reload(),${ms})</script>`;
  if (e.estado === 'desconocido') {
    return res.status(404).type('html').send(pagina('<h1>Este video ya no está</h1><p>Los videos se borran a las 6 horas, o el link no es correcto.</p>'));
  }
  if (e.estado === 'listo') {
    return res.type('html').send(pagina(`<h1>🎥 Tu video está listo</h1>
<video src="/video/${a}.mp4" controls playsinline></video><br>
<a class="btn" href="/video/${a}.mp4" download="karaoke-${a}.mp4">↓ Descargar (mp4)</a>`));
  }
  if (e.estado === 'error' && e.webm) {
    // la conversion fallo pero el archivo original sirve: se ofrece tal cual
    return res.type('html').send(pagina(`<h1>🎥 Tu video</h1>
<video src="/video/${a}.webm" controls playsinline></video><br>
<a class="btn" href="/video/${a}.webm" download="karaoke-${a}.webm">↓ Descargar</a>
<p>No pudimos pasarlo a mp4, pero se ve igual (formato webm).</p>`));
  }
  if (e.estado === 'error') {
    return res.type('html').send(pagina('<h1>No pudimos generar tu video</h1><p>La pantalla no llegó a enviarlo. Probá cantar de nuevo, ¡y gracias por participar!</p>'));
  }
  if (e.estado === 'procesando') {
    return res.type('html').send(pagina(`<h1><span class="spin">⏳</span> Procesando tu video…</h1><p>Puede tardar un minuto. Esta página se actualiza sola.</p>${recarga(5000)}`));
  }
  res.type('html').send(pagina(`<h1><span class="spin">⏳</span> Preparando tu video…</h1><p>La pantalla lo está enviando. Esta página se actualiza sola.</p>${recarga(4000)}`));
});

// QR de descarga del video de una performance (link privado con su token).
app.get('/api/qr-resultado', async (req, res) => {
  const token = req.query.token || req.query.sesion || '';
  const base = BACKEND_PUBLICO || `http://${ipLocal()}:${PORT}`;
  const url = `${base}/video/${token}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    res.json({ url, dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EL QR de la instalacion: siempre el mismo (apunta a /sala, sin codigos), asi
// se puede imprimir y pegar en la pared sin que cambie entre reinicios.
let qrCache = null;
app.get('/api/qr', async (_req, res) => {
  const frontPort = SERVIR_BUILD ? PORT : WEB_PORT;
  const base = FRONTEND_PUBLICO || `http://${ipLocal()}:${frontPort}`;
  const url = `${base}/sala`;
  try {
    if (!qrCache || qrCache.url !== url) {
      qrCache = { url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 480 }) };
    }
    res.json(qrCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Frontend compilado (solo con npm start) ------------------------
if (SERVIR_BUILD) {
  app.use(express.static(DIST));
  app.get('/', (_req, res) => res.sendFile(join(DIST, 'index.html')));
}

// --- Socket.IO ----------------------------------------------------
io.on('connection', (socket) => {
  const rol = socket.handshake.query.rol || 'celu';
  console.log(`[socket] conexion (${rol}) ${socket.id}`);

  // Pantalla grande: la ultima que se conecta es la primaria; las anteriores
  // quedan como espejo (solo muestran, no pueden mandar fin/letra/salud).
  if (rol === 'pantalla') {
    const anterior = pantallaPrimaria && io.sockets.sockets.get(pantallaPrimaria);
    const pid = String(socket.handshake.query.pid || '');
    // misma pagina que volvio de un corte de red (socket nuevo, mismo pid)
    const reconexion = !!pid && pid === pantallaPid;
    pantallaPrimaria = socket.id;
    pantallaPid = pid;
    if (anterior && anterior.id !== socket.id) anterior.emit('pantalla:espejo');
    escenario.pantallaConectada({ reconexion });
  }
  socket.emit('estado', socket.id === pantallaPrimaria ? { ...escenario.snapshot(), privado: escenario.privadoPantalla() } : escenario.snapshot());

  // --- celus: identidad por token -----------------------------------
  // La identidad viaja en el handshake (`auth`): la conexion NACE registrada, asi
  // un intent que llegue primero (celu que reconecta tras un reinicio y toca
  // "Quiero cantar" enseguida) ya encuentra la sesion. `hola` sigue existiendo
  // y es idempotente (actualiza el nombre y confirma).
  const registrar = (datos = {}) => {
    const r = escenario.hola(datos);
    if (!r.ok) return r;
    const token = datos.token;
    tokenPorSocket.set(socket.id, token);
    if (!socketsPorToken.has(token)) socketsPorToken.set(token, new Set());
    socketsPorToken.get(token).add(socket.id);
    socket.emit('yo', escenario.yo(token));
    if (ultimaLetra) socket.emit('letra', ultimaLetra);
    return { ok: true, yo: escenario.yo(token) };
  };
  if (rol !== 'pantalla' && socket.handshake.auth?.token) registrar(socket.handshake.auth);
  // OJO: `cb?.(fn())` NO ejecuta fn() si no hay callback (cortocircuito): las
  // acciones sin acuse (ej. el boton de reacciones) no hacian nada. Siempre se
  // ejecuta primero y despues se responde, si hay a quien.
  socket.on('hola', (datos = {}, cb) => {
    const r = registrar(datos);
    cb?.(r);
  });

  // todo intent de celu pasa por aca: sin token no hay nada que hacer
  // (y un tope por socket: un celu roto o malicioso no puede inundar al server)
  let ventana = 0;
  let enVentana = 0;
  const intent = (cb, fn) => {
    const ahora = Date.now();
    if (ahora - ventana > 1000) { ventana = ahora; enVentana = 0; }
    if (++enVentana > 30) return cb?.({ ok: false, error: 'Muy rápido, esperá un segundo' });
    const token = tokenPorSocket.get(socket.id);
    if (!token) return cb?.({ ok: false, error: 'Sin sesión: recargá la página' });
    const r = fn(token);
    cb?.(r);
  };

  socket.on('fila:entrar', ({ nombre } = {}, cb) => intent(cb, (t) => escenario.entrarFila(t, nombre)));
  socket.on('fila:salir', (_d, cb) => intent(cb, (t) => escenario.salirFila(t)));
  socket.on('modo:elegir', ({ modo } = {}, cb) => intent(cb, (t) => escenario.elegirModo(t, modo)));
  socket.on('cancion:elegir', ({ cancionId, modo } = {}, cb) => intent(cb, (t) => escenario.elegirCancion(t, cancionId, modo)));
  socket.on('turno:listo', (_d, cb) => intent(cb, (t) => escenario.listo(t)));
  socket.on('cantante:terminar', (_d, cb) => intent(cb, (t) => escenario.terminar(t)));
  socket.on('reto:responder', (d = {}, cb) => intent(cb, (t) => escenario.responderReto(t, d)));
  socket.on('copiloto:unirse', ({ codigo } = {}, cb) => intent(cb, (t) => escenario.unirseCopiloto(t, codigo)));
  socket.on('copiloto:salir', (_d, cb) => intent(cb, (t) => escenario.salirCopiloto(t)));
  socket.on('reaccion', ({ tipo } = {}, cb) =>
    intent(cb, (t) => {
      const r = escenario.reaccionar(t, tipo);
      if (r.ok) io.emit('reaccion', { tipo: r.tipo, nombre: r.nombre, contada: r.contada, totales: r.totales });
      return { ok: r.ok, limitada: r.limitada };
    })
  );

  // --- pantalla primaria ---------------------------------------------
  const soloPantalla = (fn) => (...args) => {
    if (socket.id === pantallaPrimaria) fn(...args);
  };
  socket.on('pantalla:salud', soloPantalla((d = {}) => escenario.pantallaSalud(d)));
  socket.on('pantalla:presencia', soloPantalla(({ hay } = {}) => escenario.pantallaPresencia(!!hay)));
  socket.on('pantalla:retoCumplido', soloPantalla((d = {}) => escenario.pantallaRetoCumplido(d)));
  socket.on('pantalla:retoPalabra', soloPantalla((d = {}, cb) => {
    const r = escenario.pantallaRetoPalabra(d);
    cb?.(r);
  }));
  socket.on('pantalla:retoResponder', soloPantalla((d = {}) => escenario.pantallaRetoResponder(d)));
  socket.on('pantalla:retoFin', soloPantalla((d = {}) => escenario.pantallaRetoFin(d)));
  socket.on('pantalla:videoError', soloPantalla(({ token } = {}) => { if (idOk(token) && videoTokens.has(token)) videoErrores.set(token, 'subida'); }));
  socket.on('pantalla:fin', soloPantalla(({ progreso } = {}) => escenario.pantallaFin({ progreso: Number(progreso) })));
  // la cancion se confirma con la mano, en el escenario
  socket.on('pantalla:confirmar', soloPantalla(({ cancionId } = {}) => escenario.pantallaConfirmar({ cancionId })));
  socket.on('pantalla:reiniciar', soloPantalla(() => escenario.reinicioSeguro()));
  // la linea de letra actual, para el teleprompter del copiloto
  socket.on('pantalla:letra', soloPantalla(({ actual, siguiente, voz } = {}) => {
    ultimaLetra = {
      actual: String(actual || '').slice(0, 200),
      siguiente: String(siguiente || '').slice(0, 200),
      voz: ['p1', 'p2', 'both'].includes(voz) ? voz : null, // de quien es la linea (dueto)
    };
    io.emit('letra', ultimaLetra);
  }));

  socket.on('disconnect', () => {
    console.log(`[socket] desconexion (${rol}) ${socket.id}`);
    const token = tokenPorSocket.get(socket.id);
    tokenPorSocket.delete(socket.id);
    if (token) {
      const set = socketsPorToken.get(token);
      set?.delete(socket.id);
      if (!set || !set.size) {
        socketsPorToken.delete(token);
        escenario.desconectar(token);
      }
    }
    if (socket.id === pantallaPrimaria) {
      pantallaPrimaria = null;
      escenario.pantallaDesconectada();
    }
  });
});

// --- Arranque ---------------------------------------------------
httpServer.listen(PORT, () => {
  const front = SERVIR_BUILD ? PORT : WEB_PORT;
  console.log('\n  Karaoke interactivo - el cerebro (una sola sala)');
  console.log('  ------------------------------------------------');
  console.log(`  Socket.IO / API    : http://localhost:${PORT}`);
  console.log(`  Pantalla principal : http://localhost:${front}/  ${SERVIR_BUILD ? '(build)' : '(astro dev)'}`);
  console.log(`  Celulares (QR)     : ${FRONTEND_PUBLICO || `http://${ipLocal()}:${front}`}/sala`);
  console.log(`  Canciones cargadas : ${canciones.length}`);
  console.log('  Control: desde los celulares; la camara de la pantalla es opcional\n');

  // Chequeo de arranque: si ffmpeg-static no bajo bien su binario (build raro,
  // restriccion de red, etc.) la conversion de video falla en silencio y solo
  // se nota semanas despues cuando alguien se queja de que no le llega el mp4.
  execFile(ffmpegPath || 'ffmpeg', ['-version'], { timeout: 10_000 }, (err, stdout) => {
    if (err) {
      console.error(`  [ffmpeg] NO DISPONIBLE (${ffmpegPath}): ${err.message.split('\n')[0]}`);
      console.error('  [ffmpeg] la conversion de video a mp4 va a fallar hasta que se arregle esto.\n');
    } else {
      console.log(`  [ffmpeg] OK: ${stdout.split('\n')[0]}\n`);
    }
  });
});

function ipLocal() {
  const ifaces = os.networkInterfaces();
  for (const nombre of Object.keys(ifaces)) {
    for (const iface of ifaces[nombre] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
