// YouTube + catalogo + busqueda, de punta a punta y SIN Internet:
//   - la YouTube Data API v3 simulada (servidor HTTP local, via YOUTUBE_API_BASE) y lrclib simulado
//   - el server REAL, sockets REALES, y una "pantalla" falsa que reporta lo que cargo
// Cubre: busqueda con filtro karaoke (orden, videos no reproducibles descartados, cache,
// paginacion con nextPageToken, limite de pedidos), eleccion con los datos guardados (videoId,
// canal, miniatura, searchQuery, karaokeScore), que NO se descargue audio, LISTO bloqueado hasta
// que la pantalla confirme el reproductor, video no reproducible, fallo en plena performance,
// clave invalida, REINICIO del server con una cancion de YouTube en la fila y cuota agotada.
//
//   node server/test/integracion3.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PORT = 3096;
const LRC_PORT = 3097;
const YT_PORT = 3098;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), 'karaoke-int3-'));
const CACHE = join(tmp, 'cache');

// ------------------------------------------------------ YouTube Data API v3 falsa
const vid = (letra, n) => `${letra}${String(n).padStart(10, '0')}`; // 11 caracteres
const NO_EMBEBIBLE = vid('N', 7);
const nombreDe = (id) => {
  const n = Number(id.slice(1));
  return id[0] === 'M' ? `Artista ${n} - Tema ${n} (Official Music Video)` : `Artista ${n} - Tema ${n} (Karaoke Version)`;
};
const canalDe = (id) => (id[0] === 'M' ? 'VEVO' : 'Karaoke Latino');
let modoApi = 'ok'; // 'ok' | 'clave' | 'cuota'
const pedidosApi = { search: 0, videos: 0 };
const itemSnippet = (id) => ({ title: nombreDe(id), channelTitle: canalDe(id), description: 'karaoke de prueba', thumbnails: { medium: { url: `https://img.example/${id}.jpg` } } });
const ytApi = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (modoApi === 'clave') { res.statusCode = 400; return res.end(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', errors: [{ reason: 'keyInvalid' }] } })); }
  if (modoApi === 'cuota') { res.statusCode = 403; return res.end(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } })); }
  if (u.pathname === '/search') {
    pedidosApi.search++;
    const q = u.searchParams.get('q') || '';
    const pagina = Number((u.searchParams.get('pageToken') || 'T0').slice(1));
    const letra = /karaoke|instrumental|sing along|backing/i.test(q) ? 'K' : 'M';
    const ids = Array.from({ length: 25 }, (_, i) => (letra === 'K' && pagina === 0 && i === 7 ? NO_EMBEBIBLE : vid(letra, pagina * 25 + i + 1)));
    return res.end(JSON.stringify({
      nextPageToken: pagina < 1 ? `T${pagina + 1}` : undefined,
      items: ids.map((id) => ({ id: { videoId: id }, snippet: itemSnippet(id) })),
    }));
  }
  if (u.pathname === '/videos') {
    pedidosApi.videos++;
    const ids = (u.searchParams.get('id') || '').split(',').filter(Boolean);
    return res.end(JSON.stringify({
      items: ids.filter((id) => id[0] !== 'X').map((id) => ({
        id,
        snippet: { ...itemSnippet(id), liveBroadcastContent: 'none' },
        contentDetails: { duration: 'PT3M31S' },
        status: { embeddable: id !== NO_EMBEBIBLE, privacyStatus: 'public', uploadStatus: 'processed' },
      })),
    }));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => ytApi.listen(YT_PORT, r));

// ---------------------------------------------------------------- lrclib falso
const LRC = '[00:05.00] linea de prueba uno\n[00:10.00] linea de prueba dos\n';
const lrclib = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/search') {
    return res.end(JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: 9000 + i, trackName: `Tema ${i}`, artistName: `Artista ${i}`, duration: 211, syncedLyrics: LRC, instrumental: false }))));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => lrclib.listen(LRC_PORT, r));

// ------------------------------------------------------------------- utilidades
let server = null;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (c, m) => { console.log(`${c ? '  OK  ' : ' FALLO'} ${m}`); if (!c) fallos++; };
const ENV = () => ({
  ...process.env,
  PORT: String(PORT),
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
  LRCLIB_URL: `http://localhost:${LRC_PORT}/api`,
  YOUTUBE_API_KEY: 'clave-de-prueba',
  YOUTUBE_API_BASE: `http://localhost:${YT_PORT}`,
  CACHE_AUDIO_DIR: CACHE,
  ESCENARIO_CONFIG: JSON.stringify({ AUDIO_REQUERIDO: true, COUNTDOWN_S: 1, RESULT_MS: 1500, RESULT_INTERRUMPIDO_MS: 1500, LLAMADO_MS: 30000, AUDIO_ESPERA_MS: 20000 }),
});
async function arrancar() {
  server = spawn(process.execPath, [join(dir, '..', 'server.js')], { env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {} await dormir(150); }
  throw new Error('el server no arranco');
}
async function parar() { const p = server; server = null; if (!p) return; const s = new Promise((r) => p.once('exit', r)); p.kill(); await s; }
async function hasta(fn, ms = 20000, msg = '') { const f = Date.now() + ms; while (Date.now() < f) { const v = await fn(); if (v) return v; await dormir(100); } console.log(`   (timeout esperando: ${msg})`); return null; }
const api = (ruta) => fetch(`${BASE}${ruta}`);
const conectado = (s) => (s.connected ? Promise.resolve() : new Promise((r) => s.once('connect', r)));

function celu(token, nombre) {
  // como el celu real: la "intencion" (lo que estaba haciendo) se evalua en CADA reconexion
  const memoria = { intencion: undefined };
  const s = io(BASE, { query: { rol: 'celu' }, auth: (cb) => cb({ token, nombre, intencion: memoria.intencion }), transports: ['websocket'], forceNew: true, reconnectionDelay: 200, reconnectionDelayMax: 500 });
  s.memoria = memoria;
  s.yo = null; s.on('yo', (y) => { s.yo = y; });
  s.pedir = (ev, d = {}) => new Promise((r) => s.emit(ev, d, r));
  return s;
}
// la pantalla falsa: dice "ya cargue ese video" para lo que se le pide precargar (como pantalla.js)
function pantalla({ autoLista = true } = {}) {
  const s = io(BASE, { query: { rol: 'pantalla', pid: 'p-' + Math.random() }, transports: ['websocket'], forceNew: true, reconnectionDelay: 200, reconnectionDelayMax: 500 });
  s.estado = null; s.listas = new Set(); s.errores = new Map();
  s.on('estado', (e) => {
    s.estado = e;
    if (!autoLista) return;
    for (const id of [e.actual?.cancion?.id, e.siguiente?.cancionId].filter(Boolean)) {
      const aud = id === e.actual?.cancion?.id ? e.actual.audio : e.siguiente?.audio;
      if (aud?.etapa === 'servidor') continue; // el server todavia no la tiene
      if (s.errores.has(id)) { if (!s.listas.has(id)) { s.listas.add(id); s.emit('pantalla:audio', { cancionId: id, estado: 'error', motivo: s.errores.get(id) }); } continue; }
      if (!s.listas.has(id)) { s.listas.add(id); s.emit('pantalla:audio', { cancionId: id, estado: 'lista' }); }
    }
  });
  s.on('audio:reintentar', ({ cancionId } = {}) => { s.listas.delete(cancionId); });
  s.on('connect', () => { s.emit('pantalla:salud', { camara: true, mic: true, audio: true }); for (const id of s.listas) s.emit('pantalla:audio', { cancionId: id, estado: 'lista' }); });
  return s;
}

try {
  await arrancar();
  const pan = pantalla();
  await hasta(() => pan.estado, 5000, 'estado pantalla');

  console.log('\n== 1. Busqueda en YouTube: filtro karaoke, no reproducibles fuera, cache, paginacion, limite');
  const salud = await (await api('/healthz')).json();
  ok(salud.youtube?.configurada === true, `el server tiene la API de YouTube configurada (${JSON.stringify(salud.youtube)})`);
  const vacia = await (await api('/api/buscar?q=')).json();
  ok(vacia.items.length >= 6 && vacia.items.every((i) => i.fuente === 'local' && i.lista), 'consulta vacia = biblioteca local, lista para cantar ya');
  const antes = { ...pedidosApi };
  const b0 = await (await api('/api/buscar?q=artista')).json();
  ok(b0.items.length >= 10, `"artista": ${b0.items.length} resultados`);
  ok(b0.items.every((i) => i.fuente === 'youtube' && i.id === `yt-${i.videoId}` && i.thumbnail && i.canal && i.duracion === 211), 'cada resultado trae videoId, miniatura, canal y duracion');
  ok(!b0.items.some((i) => i.videoId === NO_EMBEBIBLE), 'el video que no se puede incrustar se descarta (videos.list status.embeddable)');
  const primeros = b0.items.slice(0, 5);
  ok(primeros.every((i) => i.karaoke.esKaraoke), 'los karaoke salen primero');
  const idxKaraokeUltimo = b0.items.map((i) => i.karaoke.esKaraoke).lastIndexOf(true);
  const idxNoKaraokePrimero = b0.items.findIndex((i) => !i.karaoke.esKaraoke);
  ok(idxNoKaraokePrimero === -1 || idxKaraokeUltimo < idxNoKaraokePrimero, 'orden: todos los karaoke antes que los que no lo son');
  ok(typeof b0.nextPageToken === 'string' && b0.nextPageToken.length > 4, 'hay nextPageToken para pedir mas');
  const b1 = await (await api(`/api/buscar?q=artista&pageToken=${encodeURIComponent(b0.nextPageToken)}`)).json();
  ok(b1.items.length > 0, `pagina 2 con el token: ${b1.items.length} resultados`);
  ok(new Set([...b0.items, ...b1.items].map((i) => i.videoId)).size === b0.items.length + b1.items.length, 'sin repetidos entre paginas');
  const gastadas = pedidosApi.search - antes.search;
  await api('/api/buscar?q=artista');
  ok(pedidosApi.search - antes.search === gastadas, `la misma busqueda otra vez sale de la cache (no gasta cuota): ${gastadas} search.list en total`);
  ok(b0.cuota?.usadas > 0 && b0.cuota.limite > 0, `la respuesta informa la cuota (${b0.cuota?.usadas}/${b0.cuota?.limite})`);
  let limitado = 0;
  for (let i = 0; i < 25; i++) if ((await api(`/api/buscar?q=ar${i}`)).status === 429) limitado++;
  ok(limitado > 0, `el limite de pedidos frena el abuso (${limitado} respuestas 429)`);
  await dormir(5200); // se vacia la ventana del limite

  console.log('\n== 2. Elegir una cancion de YouTube: se guarda todo y NO se descarga audio');
  const A = celu('i3-celu-a-000000000001', 'Ana');
  const B = celu('i3-celu-b-000000000002', 'Beto');
  await conectado(A); await conectado(B);
  await B.pedir('fila:entrar', { nombre: 'Beto' }); // Beto va primero
  await B.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => B.yo?.audio?.estado === 'lista', 20000, 'Beto lista');
  ok((await B.pedir('turno:listo')).ok, 'Beto (biblioteca local) empieza y canta');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Beto');
  await A.pedir('fila:entrar', { nombre: 'Ana' });
  const elegida = b0.items[0];
  const r1 = await A.pedir('cancion:elegir', { cancionId: elegida.id, busqueda: 'artista' });
  ok(r1.ok, 'Ana elige un resultado de YouTube mientras Beto canta');
  await hasta(() => A.yo?.audio?.estado === 'lista', 20000, 'Ana lista');
  ok(A.yo.audio.estado === 'lista', `su audio queda listo (la pantalla confirmo el reproductor): ${JSON.stringify(A.yo.audio)}`);
  const c = A.yo.cancion;
  ok(c?.origen === 'youtube' && c.videoId === elegida.videoId, `guarda el videoId (${c?.videoId})`);
  ok(c?.titulo === elegida.titulo && c?.canal === elegida.canal && c?.thumbnail === elegida.thumbnail && c?.duracion === 211, 'guarda titulo, canal, miniatura y duracion');
  ok(c?.searchQuery === 'artista' && typeof c?.karaokeScore === 'number', `guarda la busqueda y el karaokeScore (${c?.searchQuery} / ${c?.karaokeScore})`);
  ok(pan.estado.siguiente?.cancionId === elegida.id, 'la pantalla sabe que video preparar (siguiente.cancionId)');
  ok((await A.pedir('turno:listo')).ok === false, 'Ana no puede arrancar hasta que le toque');
  const m = await (await api(`/api/cancion/${elegida.id}`)).json();
  ok(m.origen === 'youtube' && m.videoId === elegida.videoId && !m.audio, 'GET /api/cancion/:id da el videoId y NINGUNA url de audio (se reproduce embebido)');
  await dormir(1500); // la letra de lrclib es opcional y llega en segundo plano
  const m2 = await (await api(`/api/cancion/${elegida.id}`)).json();
  ok(m2.lrc === `/cache-audio/${elegida.id}.lrc` && (await (await api(m2.lrc)).text()).includes('linea de prueba'), 'la letra sincronizada de lrclib se suma sola (opcional)');
  const archivos = await readdir(CACHE).catch(() => []);
  ok(archivos.every((f) => f.endsWith('.lrc')), `en la cache solo hay letras, ningun audio/video descargado (${archivos.join(', ') || 'vacia'})`);

  console.log('\n== 3. Cola continua: Beto termina -> resultado -> Ana arranca (sin STANDBY, video ya listo)');
  await B.pedir('cantante:terminar');
  let visteStandby = false;
  await hasta(async () => { if (pan.estado?.etapa === 'STANDBY') visteStandby = true; return pan.estado?.etapa === 'CALLING' && A.yo?.estado === 'CALLED'; }, 15000, 'Ana llamada');
  ok(!visteStandby && A.yo?.audio?.estado === 'lista', 'Ana llamada con todo listo');
  ok((await A.pedir('turno:listo')).ok, 'Ana toca LISTO');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Ana');
  ok(pan.estado.actual?.cancion?.videoId === elegida.videoId, 'la pantalla recibe el videoId de lo que suena');

  console.log('\n== 4. El reproductor falla en plena performance: se cierra, no se canta en silencio');
  pan.emit('pantalla:audioFallo', { motivo: 'el navegador no deja sonar YouTube' });
  await hasta(() => pan.estado?.etapa === 'RESULT', 5000, 'RESULT por fallo');
  const res = pan.estado.actual?.resultado;
  ok(res?.interrumpida && /audio|YouTube/i.test(res.motivo), `resultado interrumpido: "${res?.motivo}"`);
  await hasta(() => pan.estado?.etapa === 'STANDBY', 8000, 'STANDBY');

  console.log('\n== 5. Videos que no se pueden reproducir y clave invalida: error visible con motivo');
  const C = celu('i3-celu-c-000000000003', 'Cami');
  await conectado(C);
  await C.pedir('fila:entrar', { nombre: 'Cami' });
  const rn = await C.pedir('cancion:elegir', { cancionId: `yt-${NO_EMBEBIBLE}`, busqueda: 'artista' });
  ok(rn.ok === false && /fuera de YouTube|No se pudo/.test(rn.error || ''), `video con incrustacion deshabilitada -> "${rn.error}"`);
  const rx = await C.pedir('cancion:elegir', { cancionId: `yt-${vid('X', 1)}` });
  ok(rx.ok === false, `video borrado/privado -> "${rx.error}"`);
  ok(C.yo.cancionId == null, 'no queda ninguna cancion elegida');
  // el navegador de la pantalla no puede cargar ESE video (p. ej. error 150 de YouTube): LISTO bloqueado + reintento
  const bueno = b0.items[1];
  pan.errores.set(bueno.id, 'el dueño del video no permite reproducirlo fuera de YouTube');
  await C.pedir('cancion:elegir', { cancionId: bueno.id, busqueda: 'artista' });
  await hasta(() => C.yo?.audio?.estado === 'error', 20000, 'error de la pantalla');
  ok(C.yo.audio.estado === 'error' && /fuera de YouTube/.test(C.yo.audio.motivo), `la pantalla no pudo cargarlo -> "${C.yo.audio.motivo}"`);
  const rl = await C.pedir('turno:listo');
  ok(rl.ok === false && /No se pudo preparar/.test(rl.error), `LISTO rechazado con el motivo (${rl.error})`);
  pan.errores.delete(bueno.id);
  await C.pedir('audio:reintentar');
  await hasta(() => C.yo?.audio?.estado === 'lista', 20000, 'reintento ok');
  ok(C.yo.audio.estado === 'lista', 'el reintento funciona cuando el video se puede cargar');
  await C.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => C.yo?.cancionId === 'corre' && C.yo?.audio?.estado === 'lista', 15000, 'cambio a corre');
  ok(C.yo.audio.estado === 'lista' && C.yo.cancion.titulo === 'Corre', 'cambiar de cancion mientras espera: se prepara la nueva');
  await C.pedir('fila:salir');
  modoApi = 'clave';
  const bc = await api('/api/buscar?q=clavemala');
  const jc = await bc.json();
  ok(bc.status === 200 && jc.error?.codigo === 'clave_invalida' && /clave/i.test(jc.error.mensaje), `clave invalida -> error claro para el celu ("${jc.error?.mensaje}")`);
  const jl = await (await api('/api/buscar?q=corre')).json();
  ok(jl.items.some((i) => i.fuente === 'local'), 'aun con la API caida se ven las canciones locales que coinciden');
  modoApi = 'ok';

  console.log('\n== 6. Sin pantalla conectada no hay video "listo" (nada puede sonar)');
  const sinPantalla = pantalla({ autoLista: false });
  pan.close();
  await dormir(400);
  const sp = celu('i3-celu-d-000000000004', 'Dani');
  await conectado(sp);
  sinPantalla.close();
  await hasta(async () => !(await (await api('/healthz')).json()).pantalla.conectada, 5000, 'sin pantalla');
  await sp.pedir('fila:entrar', { nombre: 'Dani' });
  await sp.pedir('cancion:elegir', { cancionId: b0.items[2].id, busqueda: 'artista' });
  await dormir(1500);
  ok(sp.yo.audio.estado === 'preparando', `sin pantalla: "${sp.yo.audio.estado}" (etapa ${sp.yo.audio.etapa})`);
  ok((await sp.pedir('turno:listo')).ok === false, 'y LISTO sigue bloqueado');

  console.log('\n== 7. REINICIO del server con una cancion de YouTube en la fila');
  const pan2 = pantalla();
  await hasta(() => pan2.estado, 5000, 'pantalla 2');
  await sp.pedir('fila:salir');
  const E = celu('i3-celu-e-000000000005', 'Eli');
  const F = celu('i3-celu-f-000000000006', 'Fede');
  await conectado(F);
  await F.pedir('fila:entrar', { nombre: 'Fede' });
  await F.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => F.yo?.audio?.estado === 'lista', 15000, 'Fede lista');
  ok((await F.pedir('turno:listo')).ok, 'Fede toca LISTO');
  await hasta(() => pan2.estado?.etapa === 'PLAYING', 10000, 'Fede canta');
  await conectado(E);
  await E.pedir('fila:entrar', { nombre: 'Eli' });
  const deEli = b0.items[3];
  await E.pedir('cancion:elegir', { cancionId: deEli.id, busqueda: 'artista' });
  await hasta(() => E.yo?.audio?.estado === 'lista', 30000, 'Eli lista');
  ok(E.yo.audio.estado === 'lista' && E.yo.estado === 'QUEUED', 'Eli espera con su cancion de YouTube ya lista');
  E.memoria.intencion = { enFila: true, cancionId: E.yo.cancionId, modo: E.yo.modo, busqueda: 'artista' }; // lo que guarda el celu en localStorage

  await parar();
  await dormir(500);
  await arrancar();
  ok(await hasta(() => E.connected && ['QUEUED', 'CALLED'].includes(E.yo?.estado) && E.yo?.cancionId === deEli.id, 20000, 'Eli reconecta'), 'tras reiniciar, Eli reconecta sola y sigue con su cancion de YouTube (se vuelve a verificar con la API)');
  ok(E.yo?.cancion?.videoId === deEli.videoId, 'con el mismo videoId');
  ok(await hasta(() => pan2.connected && pan2.estado?.etapa, 20000, 'pantalla reconecta'), 'la pantalla reconecta');
  ok(await hasta(() => E.yo?.audio?.estado === 'lista', 40000, 'audio de Eli otra vez'), `y vuelve a quedar lista (${JSON.stringify(E.yo?.audio)})`);
  ok((await E.pedir('turno:listo')).ok === true, 'LISTO funciona (es la primera: el escenario esta libre)');
  await hasta(() => pan2.estado?.etapa === 'PLAYING', 15000, 'PLAYING tras reinicio');
  ok(pan2.estado?.etapa === 'PLAYING' && pan2.estado.actual.cancion.videoId === deEli.videoId, 'arranca el video despues del reinicio');

  console.log('\n== 8. Cuota diaria agotada: mensaje claro, lo local sigue, no se cuelga');
  modoApi = 'cuota';
  const bq = await (await api('/api/buscar?q=cuotanueva')).json();
  ok(bq.error?.codigo === 'cuota_agotada' && /cuota/i.test(bq.error.mensaje) && bq.items.length === 0, `"${bq.error?.mensaje}"`);
  modoApi = 'ok';
  const bq2 = await (await api('/api/buscar?q=otranueva')).json();
  ok(bq2.error?.codigo === 'cuota_agotada' && bq2.items.length === 0, 'una vez agotada, el server ni insiste (no gasta pedidos inutiles)');
  const bl = await (await api('/api/buscar?q=corre')).json();
  ok(bl.items.some((i) => i.fuente === 'local' && i.lista), 'las canciones de la biblioteca local siguen disponibles');

  for (const x of [A, B, C, E, F, sp, pan2]) x.close();
} catch (e) {
  console.error('ERROR en la prueba:', e);
  fallos++;
} finally {
  await parar();
  lrclib.close();
  ytApi.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
process.exit(fallos ? 1 : 0);
