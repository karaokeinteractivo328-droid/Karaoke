// El cerebro del karaoke interactivo.
// - Coordina la maquina de estados y la reparte por Socket.IO
// - Expone el catalogo de canciones y los archivos de audio/letra
// - En produccion (npm start) tambien sirve el frontend Astro compilado
//
// Arquitectura:
//   [Pantalla principal]  --acciones (manos + voz)-->  [este servidor]
//   [Sensor ultrasonico Arduino] --WebSocket/Serial-->      (maquina de estados)
//
// Ya NO hay control por celular: todo se maneja desde la camara de la pantalla
// principal (MediaPipe Hands + reconocimiento de voz).
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

import { crearMaquina, ESTADOS } from './stateMachine.js';
import { crearSala } from './sala.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const WEB_PORT = process.env.WEB_PORT || 4321; // astro dev
const DIST = join(__dirname, '..', 'web', 'dist');
// Servir el frontend compilado solo cuando se pide explicitamente (npm start).
const SERVIR_BUILD = process.env.SERVE_BUILD === '1' && existsSync(DIST);

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// --- Catalogo de canciones ---------------------------------------------
async function cargarCanciones() {
  try {
    const raw = await readFile(join(__dirname, 'canciones', 'canciones.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[canciones] no pude leer canciones.json:', err.message);
    return [];
  }
}

let canciones = await cargarCanciones();

// --- Maquina de estados + sala (fila de espera y reacciones) -----------
// Se emiten juntas: todo cliente (pantalla o celu) recibe {..maquina, sala}.
function emitirTodo() {
  io.emit('estado', { ...maquina.snapshot(), sala: sala.snapshot() });
}

let nombrePrevio = ESTADOS.ESPERANDO;
const maquina = crearMaquina({
  canciones,
  onCambio: (snap) => {
    // al terminar una cancion (o resetear a mitad de camino) se libera el
    // lugar del cantante y se llama automaticamente al siguiente de la fila.
    if (snap.nombre !== nombrePrevio) {
      if (snap.nombre === ESTADOS.RESULTADO || snap.nombre === ESTADOS.ESPERANDO) sala.liberar();
      nombrePrevio = snap.nombre;
    }
    emitirTodo();
  },
});
const sala = crearSala({ onCambio: emitirTodo });

// --- API -----------------------------------------------------------
app.get('/api/canciones', (_req, res) => res.json(canciones));
app.use('/canciones', express.static(join(__dirname, 'canciones')));

// --- Grabaciones: la pantalla sube el .webm, el server lo pasa a .mp4 con
//     ffmpeg, y el celular lo baja por QR ---
const GRAB = join(__dirname, 'grabaciones');
await mkdir(GRAB, { recursive: true });
const idOk = (s) => /^[A-Za-z0-9]{4,40}$/.test(s || '');
const enProceso = new Set();

// Si el server se reinicia (o se cuelga) a mitad de una conversion, puede
// quedar un *.tmp.mp4 huerfano de una vez anterior: nunca es valido, lo
// limpiamos al arrancar para que no confunda el estado de "listo".
for (const f of await readdir(GRAB).catch(() => [])) {
  if (f.endsWith('.tmp.mp4')) await rm(join(GRAB, f), { force: true }).catch(() => {});
}

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
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
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

app.post(
  '/api/video/:sesion',
  express.raw({ type: ['video/webm', 'application/octet-stream'], limit: '400mb' }),
  async (req, res) => {
    if (!idOk(req.params.sesion) || !req.body?.length) return res.sendStatus(400);
    await writeFile(join(GRAB, `${req.params.sesion}.webm`), req.body);
    console.log(`[video] recibido ${req.params.sesion}.webm (${(req.body.length / 1e6).toFixed(1)} MB) -> convirtiendo`);
    res.json({ ok: true });
    aMp4(req.params.sesion);
  }
);

// `/video/<id>.mp4` / `.webm` = archivo ; `/video/<id>` = pagina.
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
  const listo = existsSync(join(GRAB, `${a}.mp4`));
  const subiendo = !listo && !existsSync(join(GRAB, `${a}.webm`)) && !enProceso.has(a);
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tu video · Karaoke</title>
<style>body{margin:0;background:#0a0716;color:#f2eee5;font-family:system-ui,sans-serif;text-align:center;padding:24px}
h1{font-weight:800}video{width:100%;max-width:520px;border-radius:14px;background:#000}
a.btn{display:inline-block;margin-top:16px;background:#ec2f80;color:#fff;font-weight:700;text-decoration:none;padding:14px 22px;border-radius:999px}
p{opacity:.75}</style></head><body>
<h1>¡Sos una estrella! ⭐</h1>
${listo
  ? `<video src="/video/${a}.mp4" controls playsinline></video><br>
     <a class="btn" href="/video/${a}.mp4" download="karaoke-${a}.mp4">↓ Descargar (mp4)</a>`
  : subiendo
    ? `<p>Todavía no llegó tu video. Recargá en unos segundos.</p><script>setTimeout(()=>location.reload(),4000)</script>`
    : `<p>Procesando tu video… puede tardar unos minutos, no cierres esta página.</p><script>setTimeout(()=>location.reload(),6000)</script>`}
</body></html>`);
});

// QR de la pantalla de RESULTADO -> pagina de descarga del video.
app.get('/api/qr-resultado', async (req, res) => {
  const sesion = req.query.sesion || '';
  const url = `http://${ipLocal()}:${PORT}/video/${sesion}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    res.json({ url, dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QR para anotarse a la sala desde el celu -> /sala?codigo=XXXX (pagina del
// frontend: en dev vive en el puerto de astro, en produccion es el mismo :3000).
app.get('/api/qr-sala', async (_req, res) => {
  const frontPort = SERVIR_BUILD ? PORT : WEB_PORT;
  const url = `http://${ipLocal()}:${frontPort}/sala?codigo=${sala.codigo}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    res.json({ url, dataUrl, codigo: sala.codigo });
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
  const rol = socket.handshake.query.rol || 'desconocido';
  console.log(`[socket] conexion (${rol}) ${socket.id}`);

  // La pantalla es EL show: si (re)carga, siempre volvemos al inicio.
  // Nunca debe abrir en el medio de una cancion.
  if (rol === 'pantalla' && maquina.nombre !== ESTADOS.ESPERANDO) {
    maquina.enviar('reset');
  }

  socket.emit('estado', { ...maquina.snapshot(), sala: sala.snapshot() });

  // La pantalla (gestos + voz) y el sensor mandan acciones aca.
  socket.on('accion', ({ evento, ...payload } = {}) => {
    if (!evento) return;
    console.log(`[accion] ${rol} -> ${evento}`, payload);
    // si estaba llamado alguien de la fila, levantar la mano lo confirma
    // como el cantante de esta ronda (queda "cantando" para mostrar su nombre).
    if (evento === 'presencia' && maquina.nombre === ESTADOS.ESPERANDO) sala.confirmarTurno();
    const ok = maquina.enviar(evento, payload);
    if (!ok) socket.emit('accion-rechazada', { evento, estado: maquina.nombre });
  });

  // La pantalla avisa cuando la cancion termino.
  socket.on('cancion-fin', () => maquina.enviar('fin'));

  // Puntaje calculado por la pantalla (performance) al terminar.
  socket.on('puntaje', ({ valor } = {}) => maquina.enviar('fin', { puntaje: valor }));

  // --- Sala: se anota alguien desde el celu / manda una reaccion ------
  socket.on('sala:unirse', ({ codigo, nombre } = {}, cb) => {
    if (String(codigo || '').trim().toUpperCase() !== sala.codigo) {
      return cb?.({ ok: false, error: 'Ese código no existe. Fijate en la pantalla.' });
    }
    const r = sala.anotarse(nombre);
    console.log(`[sala] ${rol} se anota:`, nombre, r.ok ? `-> #${r.posicion}` : `RECHAZADO (${r.error})`);
    cb?.(r);
  });

  socket.on('sala:reaccion', ({ emoji } = {}) => {
    if (typeof emoji !== 'string' || !emoji || emoji.length > 8) return;
    io.emit('reaccion', { emoji });
  });

  socket.on('sala:salir', ({ id } = {}) => id && sala.salir(id));

  socket.on('disconnect', () =>
    console.log(`[socket] desconexion (${rol}) ${socket.id}`)
  );
});

// --- Arranque ---------------------------------------------------
httpServer.listen(PORT, () => {
  const front = SERVIR_BUILD ? PORT : WEB_PORT;
  console.log('\n  Karaoke interactivo - el cerebro');
  console.log('  ---------------------------------');
  console.log(`  Socket.IO / API   : http://localhost:${PORT}`);
  console.log(`  Pantalla principal : http://localhost:${front}/  ${SERVIR_BUILD ? '(build)' : '(astro dev)'}`);
  console.log(`  Estado inicial     : ${ESTADOS.ESPERANDO}`);
  console.log(`  Canciones cargadas : ${canciones.length}`);
  console.log('  Control: manos (MediaPipe) + voz, desde la camara de la pantalla\n');
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
