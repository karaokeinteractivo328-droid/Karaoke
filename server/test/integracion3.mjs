// LRCLIB manda, YouTube se adapta: de punta a punta y SIN Internet.
//   - LRCLIB simulado (catalogo con letra) y la YouTube Data API v3 simulada (YOUTUBE_API_BASE)
//   - el server REAL, sockets REALES, y una "pantalla" falsa que reporta lo que cargo
// Cubre: busqueda (todo con letra, no gasta cuota), eleccion ORIGINAL (video de duracion igual a la letra,
// letra a tiempo sin tocar nada) y KARAOKE (aviso para alinear), que NO se descargue audio, LISTO
// bloqueado hasta que la pantalla confirme el reproductor, sin version / video que falla (reintento con el
// siguiente), fallo en plena performance, sincronia en vivo, REINICIO del server (sin volver a gastar cuota)
// y cuota agotada.
//
//   node server/test/integracion3.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PORT = 3096;
const LRC_PORT = 3097;
const YT_PORT = 3098;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), 'karaoke-int3-'));
const CACHE = join(tmp, 'cache');

// ---------------------------------------------------------------- LRCLIB falso
const LRC = '[00:05.00] linea de prueba uno\n[00:10.00] linea de prueba dos\n';
const pistas = Array.from({ length: 30 }, (_, i) => ({ id: 9001 + i, trackName: `Tema ${i + 1}`, artistName: `Artista ${i + 1}`, duration: 211, syncedLyrics: LRC, instrumental: false }));
const pedidosLrclib = { search: 0, get: 0 };
const palabrasDe = (t) => String(t).toLowerCase().split(/\s+/).filter(Boolean);
const lrclib = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/search') {
    pedidosLrclib.search++;
    const q = palabrasDe(u.searchParams.get('q') || '');
    return res.end(JSON.stringify(pistas.filter((p) => q.every((w) => palabrasDe(`${p.artistName} ${p.trackName}`).includes(w)))));
  }
  const m = /\/api\/get\/(\d+)/.exec(u.pathname);
  if (m) {
    pedidosLrclib.get++;
    const p = pistas.find((x) => x.id === Number(m[1]));
    if (p) return res.end(JSON.stringify(p));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => lrclib.listen(LRC_PORT, r));

// ------------------------------------------------------ YouTube Data API v3 falsa
// ids de video: <letra><n de 10 digitos>:  O audio oficial (211 s) · Q otro audio oficial (212 s) ·
// V en vivo (230 s) · K karaoke (213 s) · N no embebible · L audio de duracion distinta (400 s)
const vid = (letra, n) => `${letra}${String(n).padStart(10, '0')}`;
const nTema = (q) => Number(/Tema (\d+)/.exec(q || '')?.[1] || 0);
let modoApi = 'ok'; // 'ok' | 'clave' | 'cuota'
const pedidosApi = { search: 0, videos: 0 };
const titulo = (id) => {
  const n = Number(id.slice(1));
  return { O: `Artista ${n} - Tema ${n} (Official Audio)`, Q: `Artista ${n} - Tema ${n} (Audio Oficial)`, V: `Artista ${n} - Tema ${n} (Live)`, K: `Artista ${n} - Tema ${n} (Karaoke Version)`, N: `Artista ${n} - Tema ${n} (Official Audio)`, L: `Artista ${n} - Tema ${n} (Official Audio)` }[id[0]];
};
const durDe = (id) => ({ O: 211, Q: 212, V: 230, K: 213, N: 211, L: 400 }[id[0]]);
const snippet = (id) => ({ title: titulo(id), channelTitle: id[0] === 'K' ? 'Karaoke Latino' : 'Canal Oficial', description: 'prueba', thumbnails: { medium: { url: `https://img.example/${id}.jpg` } } });
const ytApi = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (modoApi === 'clave') { res.statusCode = 400; return res.end(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', errors: [{ reason: 'keyInvalid' }] } })); }
  if (modoApi === 'cuota') { res.statusCode = 403; return res.end(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } })); }
  if (u.pathname === '/search') {
    pedidosApi.search++;
    const q = u.searchParams.get('q') || '';
    const n = nTema(q);
    const karaoke = /karaoke/i.test(q);
    let ids;
    if (karaoke) ids = [vid('K', n)];
    else if (n === 7) ids = [vid('L', n)]; // solo existe un audio de otra duracion
    else if (n === 8) ids = [vid('N', n)]; // el unico audio no se puede incrustar
    else if (n === 3) ids = [vid('V', n), vid('O', n), vid('Q', n)]; // dos buenos: sirve para el reintento
    else ids = [vid('V', n), vid('O', n)];
    return res.end(JSON.stringify({ items: ids.map((id) => ({ id: { videoId: id }, snippet: snippet(id) })) }));
  }
  if (u.pathname === '/videos') {
    pedidosApi.videos++;
    const ids = (u.searchParams.get('id') || '').split(',').filter(Boolean);
    return res.end(JSON.stringify({
      items: ids.map((id) => ({
        id,
        snippet: { ...snippet(id), liveBroadcastContent: 'none' },
        contentDetails: { duration: `PT${Math.floor(durDe(id) / 60)}M${durDe(id) % 60}S` },
        status: { embeddable: id[0] !== 'N', privacyStatus: 'public', uploadStatus: 'processed' },
      })),
    }));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => ytApi.listen(YT_PORT, r));

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
  ESCENARIO_CONFIG: JSON.stringify({ AUDIO_REQUERIDO: true, COUNTDOWN_S: 1, RESULT_MS: 1500, RESULT_INTERRUMPIDO_MS: 1500, LLAMADO_MS: 30000, AUDIO_ESPERA_MS: 25000 }),
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
  s.estado = null; s.listas = new Set(); s.errores = new Map(); s.syncs = [];
  s.on('letra:sincronizar', (d) => s.syncs.push(d));
  s.on('estado', (e) => {
    s.estado = e;
    if (!autoLista) return;
    const quienes = [{ id: e.actual?.cancion?.id, videoId: e.actual?.cancion?.videoId }, { id: e.siguiente?.cancionId, videoId: e.siguiente?.cancion?.videoId }];
    for (const c of quienes) {
      const id = c.id;
      if (!id) continue;
      const aud = id === e.actual?.cancion?.id ? e.actual.audio : e.siguiente?.audio;
      if (aud?.etapa === 'servidor') continue; // el server todavia no la tiene
      const clave = `${id}|${c.videoId || ''}`;
      if (s.errores.has(c.videoId)) { if (!s.listas.has(clave)) { s.listas.add(clave); s.emit('pantalla:audio', { cancionId: id, estado: 'error', motivo: s.errores.get(c.videoId) }); } continue; }
      if (!s.listas.has(clave)) { s.listas.add(clave); s.emit('pantalla:audio', { cancionId: id, estado: 'lista' }); }
    }
  });
  s.on('audio:reintentar', () => { s.listas.clear(); });
  s.on('connect', () => { s.emit('pantalla:salud', { camara: true, mic: true, audio: true }); });
  return s;
}

try {
  await arrancar();
  const pan = pantalla();
  await hasta(() => pan.estado, 5000, 'estado pantalla');

  console.log('\n== 1. Busqueda: el catalogo sale de LRCLIB, todo con letra, sin gastar cuota de YouTube');
  const salud = await (await api('/healthz')).json();
  ok(salud.youtube?.configurada === true, `el server tiene la API de YouTube configurada (${JSON.stringify(salud.youtube)})`);
  const vacia = await (await api('/api/buscar?q=')).json();
  ok(vacia.items.length >= 6 && vacia.items.every((i) => i.fuente === 'local' && i.lista), 'consulta vacia = biblioteca local, lista para cantar ya');
  const b0 = await (await api('/api/buscar?q=tema')).json();
  ok(b0.items.length === 15 && b0.items.every((i) => i.fuente === 'lrclib' && /^lr-\d+$/.test(i.id) && i.letra === true && i.artista && i.duracion === 211), `"tema": ${b0.items.length} canciones, todas de LRCLIB y todas con letra`);
  ok(new Set(b0.items.map((i) => i.id)).size === 15, 'sin repetidos');
  ok(pedidosApi.search === 0 && pedidosApi.videos === 0, 'buscar NO toca YouTube (la cuota se gasta recien al elegir)');
  const lrAntes = pedidosLrclib.search;
  await api('/api/buscar?q=tema');
  ok(pedidosLrclib.search === lrAntes, 'la misma busqueda sale de la cache (no vuelve a pedir a LRCLIB)');
  let limitado = 0;
  for (let i = 0; i < 25; i++) if ((await api(`/api/buscar?q=ar${i}`)).status === 429) limitado++;
  ok(limitado > 0, `el limite de pedidos frena el abuso (${limitado} respuestas 429)`);
  await dormir(5200); // se vacia la ventana del limite

  console.log('\n== 2. Elegir la version ORIGINAL: el video que dura igual que la letra, a tiempo sin tocar nada');
  const A = celu('i3-celu-a-000000000001', 'Ana');
  const B = celu('i3-celu-b-000000000002', 'Beto');
  await conectado(A); await conectado(B);
  await B.pedir('fila:entrar', { nombre: 'Beto' }); // Beto va primero
  await B.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => B.yo?.audio?.estado === 'lista', 20000, 'Beto lista');
  ok((await B.pedir('turno:listo')).ok, 'Beto (biblioteca local) empieza y canta');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Beto');
  await A.pedir('fila:entrar', { nombre: 'Ana' });
  const r1 = await A.pedir('cancion:elegir', { cancionId: 'lr-9001-o', busqueda: 'tema' });
  ok(r1.ok, 'Ana elige "Tema 1" (version original) mientras Beto canta');
  await hasta(() => A.yo?.audio?.estado === 'lista', 20000, 'Ana lista');
  const c = A.yo.cancion;
  ok(A.yo.audio.estado === 'lista', `su audio queda listo (la pantalla confirmo el reproductor): ${JSON.stringify(A.yo.audio)}`);
  ok(c?.origen === 'youtube' && c.videoId === vid('O', 1), `eligio el AUDIO OFICIAL de 211 s (igual a la letra), no el "en vivo" de 230 s: ${c?.videoId}`);
  ok(c?.titulo === 'Tema 1' && c?.artista === 'Artista 1' && c?.canal === 'Canal Oficial' && c?.thumbnail && c?.duracion === 211, 'guarda titulo y artista de LRCLIB + canal, miniatura y duracion del video');
  ok(c?.searchQuery === 'tema' && c?.tipo === 'original', `guarda la busqueda y la version (${c?.searchQuery} / ${c?.tipo})`);
  ok(pedidosApi.search === 1, `una sola busqueda en YouTube (${pedidosApi.search}) porque la primera ya dio un audio exacto`);
  ok((await A.pedir('turno:listo')).ok === false, 'Ana no puede arrancar hasta que le toque');
  const m = await (await api('/api/cancion/lr-9001-o')).json();
  ok(m.origen === 'youtube' && m.videoId === vid('O', 1) && !m.audio, 'GET /api/cancion/:id da el videoId y NINGUNA url de audio (se reproduce embebido)');
  ok(m.letraConfiable === true && m.letraNivel === 'exacta' && m.offsetLetra === 0, `la letra es CONFIABLE (nivel ${m.letraNivel}): no hay que alinear nada`);
  const lrcTxt = await (await api(m.lrc)).text();
  ok(lrcTxt.includes('linea de prueba uno'), 'y la letra sincronizada de LRCLIB ya esta lista desde el principio');
  const archivos = await readdir(CACHE).catch(() => []);
  ok(!archivos.some((f) => /\.(m4a|mp3|mp4|webm|opus|ogg|wav)$/i.test(f)), `ningun audio/video descargado (${archivos.join(', ')})`);

  console.log('\n== 3. Cola continua: Beto termina -> resultado -> Ana arranca (sin STANDBY, video ya listo)');
  await B.pedir('cantante:terminar');
  let visteStandby = false;
  await hasta(async () => { if (pan.estado?.etapa === 'STANDBY') visteStandby = true; return pan.estado?.etapa === 'CALLING' && A.yo?.estado === 'CALLED'; }, 15000, 'Ana llamada');
  ok(!visteStandby && A.yo?.audio?.estado === 'lista', 'Ana llamada con todo listo');
  ok((await A.pedir('turno:listo')).ok, 'Ana toca LISTO');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Ana');
  ok(pan.estado.actual?.cancion?.videoId === vid('O', 1), 'la pantalla recibe el videoId de lo que suena');

  console.log('\n== 3b. Letra a tiempo en vivo (opcional): el que canta la alinea y el ajuste queda guardado');
  const rAl = await A.pedir('letra:sincronizar', { accion: 'alinear' });
  const rAj = await A.pedir('letra:sincronizar', { accion: 'ajustar', delta: 0.5 });
  const rPub = await B.pedir('letra:sincronizar', { accion: 'alinear' });
  await dormir(300);
  ok(rAl.ok && rAj.ok, 'quien canta puede alinear y ajustar');
  ok(pan.syncs.length === 2 && pan.syncs[0].accion === 'alinear' && pan.syncs[1].delta === 0.5, `la pantalla recibe las dos ordenes (${JSON.stringify(pan.syncs)})`);
  ok(rPub.ok === false && pan.syncs.length === 2, 'el publico NO puede mover la letra');
  pan.emit('pantalla:offset', { cancionId: 'lr-9001-o', offset: 1.04 });
  await dormir(600);
  const mOff = await (await api('/api/cancion/lr-9001-o')).json();
  ok(mOff.offsetLetra === 1, `el desfase queda guardado para esa cancion (offsetLetra ${mOff.offsetLetra})`);
  const guardado = JSON.parse(await readFile(join(CACHE, 'offsets.json'), 'utf8').catch(() => '{}'));
  ok(guardado['lr-9001-o'] === 1, 'y en disco, para que sobreviva a un reinicio');

  console.log('\n== 4. El reproductor falla en plena performance: se cierra, no se canta en silencio');
  pan.emit('pantalla:audioFallo', { motivo: 'el navegador no deja sonar YouTube' });
  await hasta(() => pan.estado?.etapa === 'RESULT', 5000, 'RESULT por fallo');
  const res = pan.estado.actual?.resultado;
  ok(res?.interrumpida && /audio|YouTube/i.test(res.motivo), `resultado interrumpido: "${res?.motivo}"`);
  await hasta(() => pan.estado?.etapa === 'STANDBY', 8000, 'STANDBY');

  console.log('\n== 5. Version KARAOKE: se elige el karaoke, pero NO se promete letra a tiempo');
  const C = celu('i3-celu-c-000000000003', 'Cami');
  await conectado(C);
  await C.pedir('fila:entrar', { nombre: 'Cami' });
  const antesK = pedidosApi.search;
  ok((await C.pedir('cancion:elegir', { cancionId: 'lr-9002-k', busqueda: 'tema 2' })).ok, 'Cami elige "Tema 2" en version karaoke');
  await hasta(() => C.yo?.audio?.estado === 'lista', 20000, 'karaoke lista');
  const mk = await (await api('/api/cancion/lr-9002-k')).json();
  ok(mk.videoId === vid('K', 2) && mk.tipo === 'karaoke', `el video es el karaoke (${mk.videoId})`);
  ok(mk.letraConfiable === false && mk.lrc, 'tiene letra de LRCLIB pero NO es confiable: la pantalla avisa y se puede alinear');
  ok(pedidosApi.search - antesK === 1, 'una busqueda en YouTube');
  await C.pedir('fila:salir');

  console.log('\n== 6. Sin version que sirva y videos que fallan: error claro, reintento con el siguiente');
  await C.pedir('fila:entrar', { nombre: 'Cami' });
  const sinOrig = await C.pedir('cancion:elegir', { cancionId: 'lr-9007-o' });
  ok(sinOrig.ok === false && /karaoke/i.test(sinOrig.error), `audio de otra duracion: "${sinOrig.error}"`);
  const noEmb = await C.pedir('cancion:elegir', { cancionId: 'lr-9008-o' });
  ok(noEmb.ok === false && /karaoke/i.test(noEmb.error), `el unico audio no se puede incrustar: "${noEmb.error}"`);
  await dormir(300);
  ok(C.yo.cancionId === 'lr-9002-k', `los intentos fallidos no pisan la eleccion anterior (${C.yo.cancionId})`);
  ok((await C.pedir('cancion:elegir', { cancionId: 'lr-9007-k' })).ok, 'pero la version karaoke de esa misma cancion si se puede');
  await C.pedir('cancion:elegir', { cancionId: 'corre' });
  // el navegador de la pantalla no puede cargar ESE video (p. ej. error 150 de YouTube): LISTO bloqueado + reintento con otro
  ok((await C.pedir('cancion:elegir', { cancionId: 'lr-9003-o', busqueda: 'tema 3' })).ok, 'Cami elige "Tema 3" (original)');
  await hasta(() => C.yo?.audio?.estado === 'lista' || C.yo?.audio?.estado === 'preparando', 20000, 'Tema 3 elegido');
  const primerVideo = (await (await api('/api/cancion/lr-9003-o')).json()).videoId;
  pan.errores.set(primerVideo, 'el dueño del video no permite reproducirlo fuera de YouTube');
  pan.listas.clear();
  await C.pedir('cancion:elegir', { cancionId: 'corre' });
  await C.pedir('cancion:elegir', { cancionId: 'lr-9003-o', busqueda: 'tema 3' });
  await hasta(() => C.yo?.audio?.estado === 'error', 20000, 'error de la pantalla');
  ok(C.yo.audio.estado === 'error' && /fuera de YouTube/.test(C.yo.audio.motivo), `la pantalla no pudo cargarlo -> "${C.yo.audio.motivo}"`);
  const rl = await C.pedir('turno:listo');
  ok(rl.ok === false && /No se pudo preparar/.test(rl.error), `LISTO rechazado con el motivo (${rl.error})`);
  await C.pedir('audio:reintentar');
  await hasta(() => C.yo?.audio?.estado === 'lista', 25000, 'reintento ok');
  const segundoVideo = (await (await api('/api/cancion/lr-9003-o')).json()).videoId;
  ok(C.yo.audio.estado === 'lista' && segundoVideo !== primerVideo, `el reintento descarta el video que fallo y elige otro (${primerVideo} -> ${segundoVideo})`);
  await C.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => C.yo?.cancionId === 'corre' && C.yo?.audio?.estado === 'lista', 15000, 'cambio a corre');
  ok(C.yo.audio.estado === 'lista' && C.yo.cancion.titulo === 'Corre', 'cambiar de cancion mientras espera: se prepara la nueva');
  await C.pedir('fila:salir');
  modoApi = 'clave';
  const bc = await (await api('/api/buscar?q=tema')).json();
  ok(bc.items.length > 0 && !bc.error, 'la busqueda sigue andando aunque YouTube tenga problemas (sale de LRCLIB)');
  await C.pedir('fila:entrar', { nombre: 'Cami' });
  const rc = await C.pedir('cancion:elegir', { cancionId: 'lr-9010-o' });
  ok(rc.ok === false && /clave/i.test(rc.error), `clave invalida al elegir -> mensaje claro: "${rc.error}"`);
  await C.pedir('fila:salir');
  modoApi = 'ok';

  console.log('\n== 7. Sin pantalla conectada no hay video "listo" (nada puede sonar)');
  const sinPantalla = pantalla({ autoLista: false });
  pan.close();
  await dormir(400);
  const sp = celu('i3-celu-d-000000000004', 'Dani');
  await conectado(sp);
  sinPantalla.close();
  await hasta(async () => !(await (await api('/healthz')).json()).pantalla.conectada, 5000, 'sin pantalla');
  await sp.pedir('fila:entrar', { nombre: 'Dani' });
  await sp.pedir('cancion:elegir', { cancionId: 'lr-9004-o', busqueda: 'tema 4' });
  await dormir(1500);
  ok(sp.yo.audio.estado === 'preparando', `sin pantalla: "${sp.yo.audio.estado}" (etapa ${sp.yo.audio.etapa})`);
  ok((await sp.pedir('turno:listo')).ok === false, 'y LISTO sigue bloqueado');

  console.log('\n== 8. REINICIO del server con una cancion en la fila: no vuelve a gastar cuota de YouTube');
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
  await E.pedir('cancion:elegir', { cancionId: 'lr-9005-o', busqueda: 'tema 5' });
  await hasta(() => E.yo?.audio?.estado === 'lista', 30000, 'Eli lista');
  ok(E.yo.audio.estado === 'lista' && E.yo.estado === 'QUEUED', 'Eli espera con su cancion ya lista');
  const videoEli = E.yo.cancion.videoId;
  E.memoria.intencion = { enFila: true, cancionId: E.yo.cancionId, modo: E.yo.modo, busqueda: 'tema 5' }; // lo que guarda el celu en localStorage
  await dormir(700); // que el server alcance a guardar la eleccion en disco
  const apiAntes = pedidosApi.search;

  await parar();
  await dormir(500);
  await arrancar();
  ok(await hasta(() => E.connected && ['QUEUED', 'CALLED'].includes(E.yo?.estado) && E.yo?.cancionId === 'lr-9005-o', 20000, 'Eli reconecta'), 'tras reiniciar, Eli reconecta sola y sigue con su cancion');
  ok(await hasta(() => E.yo?.cancion?.videoId === videoEli, 10000, 'mismo video'), 'con el MISMO video');
  ok(await hasta(() => pan2.connected && pan2.estado?.etapa, 20000, 'pantalla reconecta'), 'la pantalla reconecta');
  ok(await hasta(() => E.yo?.audio?.estado === 'lista', 40000, 'audio de Eli otra vez'), `y vuelve a quedar lista (${JSON.stringify(E.yo?.audio)})`);
  ok(pedidosApi.search === apiAntes, `sin gastar ni una busqueda mas de YouTube (la eleccion se recordaba en disco: ${pedidosApi.search} = ${apiAntes})`);
  const rE = await E.pedir('turno:listo');
  ok(rE.ok === true, `LISTO funciona (es la primera: el escenario esta libre) ${JSON.stringify(rE)} estado ${E.yo?.estado} etapa ${pan2.estado?.etapa}`);
  await hasta(() => pan2.estado?.etapa === 'PLAYING', 15000, 'PLAYING tras reinicio');
  ok(pan2.estado?.etapa === 'PLAYING' && pan2.estado.actual.cancion.videoId === videoEli, 'arranca el video despues del reinicio');

  console.log('\n== 9. Cuota diaria agotada: mensaje claro, la busqueda y lo local siguen, no se cuelga');
  modoApi = 'cuota';
  const G = celu('i3-celu-g-000000000007', 'Gus');
  await conectado(G);
  await G.pedir('fila:entrar', { nombre: 'Gus' });
  const rq = await G.pedir('cancion:elegir', { cancionId: 'lr-9011-o', busqueda: 'tema 11' });
  ok(rq.ok === false && /cuota/i.test(rq.error), `"${rq.error}"`);
  modoApi = 'ok';
  const bq = await (await api('/api/buscar?q=tema 12')).json();
  ok(bq.items.some((i) => i.fuente === 'lrclib') && !bq.error, 'la busqueda (LRCLIB) sigue funcionando');
  const bl = await (await api('/api/buscar?q=corre')).json();
  ok(bl.items.some((i) => i.fuente === 'local' && i.lista), 'las canciones de la biblioteca local siguen disponibles');

  for (const x of [A, B, C, E, F, G, sp, pan2]) x.close();
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
