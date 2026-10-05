// Audio + catalogo + busqueda, de punta a punta y SIN Internet:
//   - lrclib simulado (servidor HTTP local) y yt-dlp simulado (test/fake-ytdlp.mjs)
//   - el server REAL, sockets REALES, y una "pantalla" falsa que reporta lo que cargo
// Cubre: busqueda (cache, paginacion, limite), preparar audio antes del turno, LISTO bloqueado
// hasta que el audio este de verdad listo, fuentes rotas / silencio / descarga caida,
// reintento, cambio de cancion, audio que falla en plena performance, Range/CORS y REINICIO
// del server con una cancion online en la fila.
//
//   node server/test/integracion3.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PORT = 3096;
const LRC_PORT = 3097;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), 'karaoke-int3-'));
const MODO = join(tmp, 'modo.txt');
const setModo = (m) => writeFile(MODO, m);
await setModo('ok');

// ---------------------------------------------------------------- lrclib falso
const LRC = '[00:05.00] linea de prueba uno\n[00:10.00] linea de prueba dos\n';
const temas = Array.from({ length: 23 }, (_, i) => ({
  id: 9000 + i, trackName: `Tema de prueba ${i}`, artistName: `Artista ${i}`, duration: 60 + (i % 3), syncedLyrics: LRC, instrumental: false,
}));
const pedidosLrclib = [];
const lrclib = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  pedidosLrclib.push(u.pathname + u.search);
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').toLowerCase();
    return res.end(JSON.stringify(temas.filter((t) => `${t.artistName} ${t.trackName}`.toLowerCase().includes(q.split(' ')[0] || ''))));
  }
  const m = /\/api\/get\/(\d+)/.exec(u.pathname);
  const t = m && temas.find((x) => x.id === Number(m[1]));
  if (t) return res.end(JSON.stringify(t));
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
  YTDLP: `node ${join(dir, 'fake-ytdlp.mjs')}`,
  FAKE_MODO_ARCHIVO: MODO, FAKE_DURACION: '60',
  CACHE_AUDIO_DIR: join(tmp, 'cache'),
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
let panRef = null; // para imprimir el estado cuando algo no llega
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
// la pantalla falsa: dice "ya cargue ese audio" para lo que se le pide precargar (como pantalla.js)
function pantalla({ autoLista = true } = {}) {
  const s = io(BASE, { query: { rol: 'pantalla', pid: 'p-' + Math.random() }, transports: ['websocket'], forceNew: true, reconnectionDelay: 200, reconnectionDelayMax: 500 });
  s.estado = null; s.listas = new Set();
  s.on('estado', (e) => {
    s.estado = e;
    if (!autoLista) return;
    for (const id of [e.actual?.cancion?.id, e.siguiente?.cancionId].filter(Boolean)) {
      if (e.actual && id === e.actual.cancion?.id && e.actual.audio?.estado === 'preparando' && e.actual.audio.etapa === 'servidor') continue;
      const srvLista = (id === e.actual?.cancion?.id ? e.actual.audio : e.siguiente?.audio)?.etapa !== 'servidor';
      if (srvLista && !s.listas.has(id)) { s.listas.add(id); s.emit('pantalla:audio', { cancionId: id, estado: 'lista' }); }
    }
  });
  // como pantalla.js: si el server pide reintentar un audio, se vuelve a cargar y a informar
  s.on('audio:reintentar', ({ cancionId } = {}) => { s.listas.delete(cancionId); });
  s.on('connect', () => { s.emit('pantalla:salud', { camara: true, mic: true, audio: true }); for (const id of s.listas) s.emit('pantalla:audio', { cancionId: id, estado: 'lista' }); });
  return s;
}

try {
  await arrancar();
  const pan = pantalla();
  await hasta(() => pan.estado, 5000, 'estado pantalla');

  console.log('\n== 1. Busqueda: biblioteca, catalogo online, cache, paginacion y limite');
  const salud = await (await api('/healthz')).json();
  ok(salud.audio.resolvedorRemoto === true, `el server sabe que puede preparar audio online (${salud.audio.detalle})`);
  const vacia = await (await api('/api/buscar?q=')).json();
  ok(vacia.items.length >= 6 && vacia.items.every((i) => i.fuente === 'local' && i.lista), 'consulta vacia = biblioteca local, lista para cantar ya');
  const antes = pedidosLrclib.length;
  const b0 = await (await api('/api/buscar?q=tema')).json();
  ok(b0.items.length === 10 && b0.hayMas && b0.total === 23, `"tema": 10 por pagina, hay mas, total ${b0.total}`);
  ok(b0.items.every((i) => i.fuente === 'lrclib' && i.id.startsWith('lrclib-')), 'son canciones online');
  const b1 = await (await api('/api/buscar?q=tema&pagina=1')).json();
  const b2 = await (await api('/api/buscar?q=tema&pagina=2')).json();
  ok(b1.items.length === 10 && b2.items.length === 3 && !b2.hayMas, 'paginacion 10 + 10 + 3');
  ok(new Set([...b0.items, ...b1.items, ...b2.items].map((i) => i.id)).size === 23, 'sin repetidos entre paginas');
  ok(pedidosLrclib.length - antes === 1, 'tres paginas = UNA sola consulta a lrclib (cache)');
  let limitado = 0;
  for (let i = 0; i < 25; i++) if ((await api(`/api/buscar?q=ar${i}`)).status === 429) limitado++;
  ok(limitado > 0, `el limite de pedidos frena el abuso (${limitado} respuestas 429)`);
  await dormir(5200); // se vacia la ventana del limite

  console.log('\n== 2. Elegir una cancion online: el audio se prepara ANTES del turno');
  const A = celu('i3-celu-a-000000000001', 'Ana');
  const B = celu('i3-celu-b-000000000002', 'Beto');
  await conectado(A); await conectado(B);
  await B.pedir('fila:entrar', { nombre: 'Beto' }); // Beto va primero (queda llamado)
  await B.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => B.yo?.audio?.estado === 'lista', 20000, 'Beto lista');
  const rb = await B.pedir('turno:listo');
  ok(rb.ok, 'Beto (biblioteca) empieza y canta');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Beto');
  await A.pedir('fila:entrar', { nombre: 'Ana' });
  const t0 = Date.now();
  const r1 = await A.pedir('cancion:elegir', { cancionId: 'lrclib-9001' });
  ok(r1.ok, 'Ana elige una cancion online mientras Beto canta');
  ok(A.yo.audio.estado === 'preparando', `su audio figura "preparando" (no "lista"): ${JSON.stringify(A.yo.audio)}`);
  await hasta(() => A.yo?.audio?.estado === 'lista', 30000, 'Ana lista');
  ok(A.yo.audio.estado === 'lista', `queda lista tras ${((Date.now() - t0) / 1000).toFixed(1)} s, todavia durante la cancion de Beto (${pan.estado.etapa})`);
  ok(pan.estado.siguiente?.cancionId === 'lrclib-9001' && pan.estado.siguiente.audio.estado === 'lista', 'la pantalla sabe que cancion precargar (siguiente.cancionId)');
  ok(A.yo.cancion?.titulo === 'Tema de prueba 1', 'el celu recibe titulo/artista de la cancion elegida');
  ok((await A.pedir('turno:listo')).ok === false, 'Ana no puede arrancar hasta que le toque');
  const m = await (await api('/api/cancion/lrclib-9001')).json();
  ok(m.audioEstado === 'lista' && m.audio === '/cache-audio/lrclib-9001.m4a' && m.lrc === '/cache-audio/lrclib-9001.lrc', 'GET /api/cancion/:id da la fuente y el estado real');
  const rango = await fetch(`${BASE}/cache-audio/lrclib-9001.m4a`, { headers: { Range: 'bytes=0-99', Origin: 'http://localhost:4321' } });
  ok(rango.status === 206 && rango.headers.get('access-control-allow-origin') === '*', `el audio se sirve con Range (206) y CORS (${rango.status})`);
  const lrcTxt = await (await api('/cache-audio/lrclib-9001.lrc')).text();
  ok(lrcTxt.includes('linea de prueba'), 'y la letra sincronizada tambien');

  console.log('\n== 3. Cola continua: Beto termina -> resultado -> Ana arranca (sin STANDBY, audio ya listo)');
  await B.pedir('cantante:terminar');
  let visteStandby = false;
  await hasta(async () => { if (pan.estado?.etapa === 'STANDBY') visteStandby = true; return pan.estado?.etapa === 'CALLING' && A.yo?.estado === 'CALLED'; }, 15000, 'Ana llamada');
  ok(!visteStandby && A.yo?.audio?.estado === 'lista', 'Ana llamada con el audio listo');
  ok((await A.pedir('turno:listo')).ok, 'Ana toca LISTO');
  await hasta(() => pan.estado?.etapa === 'PLAYING', 10000, 'PLAYING Ana');

  console.log('\n== 4. El audio falla en plena performance: se cierra, no se canta en silencio');
  pan.emit('pantalla:audioFallo', { motivo: 'play() rechazado' });
  await hasta(() => pan.estado?.etapa === 'RESULT', 5000, 'RESULT por fallo');
  const res = pan.estado.actual?.resultado;
  ok(res?.interrumpida && /audio/i.test(res.motivo), `resultado interrumpido: "${res?.motivo}"`);
  await hasta(() => pan.estado?.etapa === 'STANDBY', 8000, 'STANDBY');

  console.log('\n== 5. Fuentes rotas: error visible con motivo, reintento y cambio de cancion');
  const C = celu('i3-celu-c-000000000003', 'Cami');
  await conectado(C);
  await setModo('ninguno');
  await C.pedir('fila:entrar', { nombre: 'Cami' });
  await C.pedir('cancion:elegir', { cancionId: 'lrclib-9002' });
  await hasta(() => C.yo?.audio?.estado === 'error', 20000, 'error ninguno');
  ok(C.yo.audio.estado === 'error' && /duracion|version/.test(C.yo.audio.motivo), `sin version que coincida -> "${C.yo.audio.motivo}"`);
  const rl = await C.pedir('turno:listo');
  ok(rl.ok === false && /No se pudo preparar/.test(rl.error), 'LISTO rechazado con el motivo');
  await setModo('silencio');
  await C.pedir('audio:reintentar');
  await hasta(() => C.yo?.audio?.estado === 'error' && /silencio/.test(C.yo.audio.motivo || ''), 20000, 'error silencio');
  ok(/silencio/.test(C.yo.audio.motivo || ''), `un archivo que es silencio se descarta: "${C.yo.audio.motivo}"`);
  await setModo('cae');
  await C.pedir('audio:reintentar');
  await hasta(() => C.yo?.audio?.estado === 'error' && /403/.test(C.yo.audio.motivo || ''), 20000, 'error 403');
  ok(/403/.test(C.yo.audio.motivo || ''), `descarga caida -> "${C.yo.audio.motivo}"`);
  await setModo('ok');
  await C.pedir('audio:reintentar');
  await hasta(() => C.yo?.audio?.estado === 'lista', 30000, 'reintento ok');
  ok(C.yo.audio.estado === 'lista', 'el reintento funciona cuando la fuente se recupera');
  await C.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => C.yo?.cancionId === 'corre' && C.yo?.audio?.estado === 'lista', 15000, 'cambio a corre');
  ok(C.yo.audio.estado === 'lista' && C.yo.cancion.titulo === 'Corre', 'cambiar de cancion mientras espera: se prepara la nueva');

  console.log('\n== 6. Sin pantalla conectada no hay audio "listo" (nada puede sonar)');
  const sinPantalla = pantalla({ autoLista: false });
  pan.close();
  await dormir(400);
  const sp = celu('i3-celu-d-000000000004', 'Dani');
  await conectado(sp);
  await C.pedir('fila:salir');
  sinPantalla.close();
  await hasta(async () => !(await (await api('/healthz')).json()).pantalla.conectada, 5000, 'sin pantalla');
  await sp.pedir('fila:entrar', { nombre: 'Dani' });
  await sp.pedir('cancion:elegir', { cancionId: 'baby' });
  await dormir(1500);
  ok(sp.yo.audio.estado === 'preparando', `sin pantalla: "${sp.yo.audio.estado}" (etapa ${sp.yo.audio.etapa})`);
  ok((await sp.pedir('turno:listo')).ok === false, 'y LISTO sigue bloqueado');

  console.log('\n== 7. REINICIO del server con una cancion online en la fila');
  const pan2 = pantalla();
  await hasta(() => pan2.estado, 5000, 'pantalla 2');
  await sp.pedir('fila:salir');
  const E = celu('i3-celu-e-000000000005', 'Eli');
  // Eli entra y elige (queda en la fila detras de nadie: la llaman) -> necesita alguien delante
  const F = celu('i3-celu-f-000000000006', 'Fede', undefined);
  await conectado(F);
  await F.pedir('fila:entrar', { nombre: 'Fede' });
  await F.pedir('cancion:elegir', { cancionId: 'corre' });
  await hasta(() => F.yo?.audio?.estado === 'lista', 15000, 'Fede lista');
  const rf = await F.pedir('turno:listo');
  ok(rf.ok, `Fede toca LISTO (${JSON.stringify(rf)})`);
  await hasta(() => pan2.estado?.etapa === 'PLAYING', 10000, 'Fede canta');
  if (pan2.estado?.etapa !== 'PLAYING') console.log('   estado:', pan2.estado?.etapa, JSON.stringify(pan2.estado?.actual?.nombre), JSON.stringify(F.yo));
  await conectado(E);
  await E.pedir('fila:entrar', { nombre: 'Eli' });
  await E.pedir('cancion:elegir', { cancionId: 'lrclib-9003' });
  await hasta(() => E.yo?.audio?.estado === 'lista', 30000, 'Eli lista');
  ok(E.yo.audio.estado === 'lista' && E.yo.estado === 'QUEUED', 'Eli espera con su cancion online ya lista');
  const antesDeReiniciar = E.yo.cancionId;
  E.memoria.intencion = { enFila: true, cancionId: E.yo.cancionId, modo: E.yo.modo }; // lo que guarda el celu en localStorage

  await parar();
  await dormir(500);
  await arrancar();
  ok(await hasta(() => E.connected && ['QUEUED', 'CALLED'].includes(E.yo?.estado) && E.yo?.cancionId === antesDeReiniciar, 20000, 'Eli reconecta'), 'tras reiniciar, Eli reconecta sola y sigue en la sala con su cancion online (se re-registra; como es la primera, la llaman)');
  ok(await hasta(() => pan2.connected && pan2.estado?.etapa, 20000, 'pantalla reconecta'), 'la pantalla reconecta');
  ok(await hasta(() => E.yo?.audio?.estado === 'lista', 40000, 'audio de Eli otra vez'), `y su audio vuelve a quedar listo (${JSON.stringify(E.yo?.audio)})`);
  const rr = await E.pedir('fila:entrar', { nombre: 'Eli' });
  ok(rr.ok, 'despues del reinicio "Quiero cantar" funciona');
  ok((await E.pedir('turno:listo')).ok === true, 'y LISTO funciona (es el primero: el escenario esta libre)');
  await hasta(() => pan2.estado?.etapa === 'PLAYING', 15000, 'PLAYING tras reinicio');
  ok(pan2.estado?.etapa === 'PLAYING', 'arranca la cancion online despues del reinicio');

  for (const c of [A, B, C, E, F, sp, pan2]) c.close();
} catch (e) {
  console.error('ERROR en la prueba:', e);
  fallos++;
} finally {
  await parar();
  lrclib.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
process.exit(fallos ? 1 : 0);
