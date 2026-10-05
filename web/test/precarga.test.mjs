// Precarga: "lista" solo si se descargo, se decodifica y play() funciona.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearPrecarga } from '../src/lib/precarga.js';

const GRANDE = new Uint8Array(200_000); // un "audio" de tamano creible

function metaDe(id, extra = {}) {
  return { id, titulo: id, artista: 'x', duracion: 211, audio: `/cache-audio/${id}.m4a`, lrc: `/cache-audio/${id}.lrc`, audioEstado: 'lista', ...extra };
}

function respuesta(cuerpo, { ok = true, status = 200, tipo = 'audio/mp4' } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? tipo : null) },
    json: async () => cuerpo,
    text: async () => cuerpo,
    blob: async () => new Blob([cuerpo]),
  };
}

// red simulada: rutas = { '/api/cancion/a': () => respuesta(...) }
function red(rutas, llamadas = []) {
  return async (url, { signal } = {}) => {
    llamadas.push(url);
    if (signal?.aborted) throw new Error('abortado');
    const k = Object.keys(rutas).find((r) => url.endsWith(r));
    if (!k) return respuesta('nada', { ok: false, status: 404 });
    const r = await rutas[k](signal);
    return r;
  };
}

function audioFalso({ duracion = 211, error = false, playFalla = false } = {}) {
  return () => {
    let _src = '';
    const a = {
      preload: '', muted: false, duration: duracion, error: error ? { code: 4 } : null,
      get src() { return _src; },
      set src(v) { _src = v; setTimeout(() => (error ? a.onerror?.() : a.oncanplaythrough?.()), 0); },
      load() {},
      play: async () => { if (playFalla) throw Object.assign(new Error('el usuario no interactuo'), { name: 'NotAllowedError' }); },
      pause() {},
      removeAttribute() {},
    };
    return a;
  };
}

async function hasta(fn, ms = 1500) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function armar(rutas, audio = {}, extra = {}) {
  const eventos = [];
  const llamadas = [];
  const p = crearPrecarga({
    base: 'http://srv',
    fetchFn: red(rutas, llamadas),
    crearAudio: audioFalso(audio),
    esperar: () => Promise.resolve(),
    onEstado: (id, estado, motivo, etapa) => eventos.push({ id, estado, motivo, etapa }),
    ...extra,
  });
  return { p, eventos, llamadas };
}

const rutasOk = (id = 'a', meta = metaDe(id)) => ({
  [`/api/cancion/${id}`]: () => respuesta(meta),
  [`/cache-audio/${id}.m4a`]: () => respuesta(GRANDE),
  [`/cache-audio/${id}.lrc`]: () => respuesta('[00:10.00] una linea', { tipo: 'text/plain' }),
});

test('camino feliz: baja, decodifica, prueba play() y recien ahi esta lista (con letra y blob en memoria)', async () => {
  const { p, eventos } = armar(rutasOk());
  p.apuntar(['a']);
  assert.equal(p.obtener('a'), null, 'al principio NO esta lista');
  assert.ok(await hasta(() => p.obtener('a')));
  const listo = p.obtener('a');
  assert.match(listo.blobUrl, /^blob:/);
  assert.equal(listo.meta.id, 'a');
  assert.match(listo.lrc, /una linea/);
  assert.deepEqual([...new Set(eventos.map((e) => e.estado))], ['preparando', 'lista']);
  assert.ok(eventos.some((e) => e.etapa === 'descarga'), 'pasa por la descarga');
  assert.ok(eventos.some((e) => e.etapa === 'decodificando'), 'y por la decodificacion');
  assert.equal(eventos.at(-1).estado, 'lista');
});

test('si el server todavia prepara el audio, espera (no da por lista una URL)', async () => {
  let consultas = 0;
  const rutas = rutasOk();
  rutas['/api/cancion/a'] = () => respuesta(metaDe('a', { audioEstado: ++consultas < 3 ? 'preparando' : 'lista' }));
  const { p, eventos } = armar(rutas);
  p.apuntar(['a']);
  assert.ok(await hasta(() => p.obtener('a')));
  assert.ok(consultas >= 3);
  assert.ok(eventos.some((e) => e.estado === 'preparando' && e.etapa === 'servidor'));
});

test('error del server -> error con el motivo (no se queda "preparando" para siempre)', async () => {
  const rutas = rutasOk();
  rutas['/api/cancion/a'] = () => respuesta(metaDe('a', { audioEstado: 'error', audioMotivo: 'no hay una version que coincida' }));
  const { p, eventos } = armar(rutas);
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /no hay una version/);
  assert.equal(p.obtener('a'), null);
});

test('el server tarda demasiado -> error (watchdog)', async () => {
  const rutas = rutasOk();
  rutas['/api/cancion/a'] = () => respuesta(metaDe('a', { audioEstado: 'preparando' }));
  const { p, eventos } = armar(rutas, {}, { esperaServidorMs: 20, esperar: () => new Promise((r) => setTimeout(r, 15)) });
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /tardó demasiado/);
});

test('archivo vacio / no es audio / fuente caida -> error', async () => {
  for (const [cambio, patron] of [
    [{ '/cache-audio/a.m4a': () => respuesta(new Uint8Array(100)) }, /vacío|incompleto/],
    [{ '/cache-audio/a.m4a': () => respuesta('<html>', { tipo: 'text/html' }) }, /no es audio/],
    [{ '/cache-audio/a.m4a': () => respuesta('x', { ok: false, status: 404 }) }, /404/],
  ]) {
    const { p, eventos } = armar({ ...rutasOk(), ...cambio });
    p.apuntar(['a']);
    assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')), String(patron));
    assert.match(eventos.at(-1).motivo, patron);
  }
});

test('el navegador no puede decodificarlo -> error', async () => {
  const { p, eventos } = armar(rutasOk(), { error: true });
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /decodificar/);
});

test('duracion real distinta de la esperada -> error (la letra saldria corrida)', async () => {
  const { p, eventos } = armar(rutasOk(), { duracion: 400 });
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /dura 400 s/);
});

test('play() rechazado (autoplay) -> error con el motivo', async () => {
  const { p, eventos } = armar(rutasOk(), { playFalla: true });
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /play\(\) rechazado.*NotAllowedError/);
});

test('sin letra no esta lista (la letra es parte de la cancion)', async () => {
  const { p, eventos } = armar({ ...rutasOk(), '/cache-audio/a.lrc': () => respuesta('x', { ok: false, status: 404 }) });
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /letra/);
});

test('cambiar de cancion: se cancela la descarga vieja y se prepara la nueva', async () => {
  let destrabar;
  const rutas = { ...rutasOk('a'), ...rutasOk('b') };
  rutas['/cache-audio/a.m4a'] = (signal) =>
    new Promise((res, rej) => {
      destrabar = () => res(respuesta(GRANDE));
      signal?.addEventListener('abort', () => rej(new Error('abortado')));
    });
  const { p, eventos } = armar(rutas);
  p.apuntar(['a']);
  await hasta(() => p.estado('a')?.etapa === 'descarga');
  p.apuntar(['b']); // la persona cambio de cancion mientras esperaba
  assert.ok(await hasta(() => p.obtener('b')));
  assert.deepEqual(p.ids, ['b'], 'la vieja ya no esta');
  assert.equal(eventos.filter((e) => e.id === 'a' && (e.estado === 'lista' || e.estado === 'error')).length, 0, 'la cancelada no reporta ni lista ni error');
  destrabar?.();
});

test('se precargan la actual y la que sigue; lo demas se suelta; lo que suena esta protegido', async () => {
  const rutas = { ...rutasOk('a'), ...rutasOk('b'), ...rutasOk('c') };
  const { p } = armar(rutas);
  p.apuntar(['a', 'b']);
  assert.ok(await hasta(() => p.obtener('a') && p.obtener('b')));
  p.proteger(['a']); // 'a' esta sonando
  p.apuntar(['b', 'c']); // la fila avanzo
  assert.ok(await hasta(() => p.obtener('c')));
  assert.ok(p.obtener('a'), 'lo que suena no se suelta');
  p.proteger([]);
  p.apuntar(['b', 'c']);
  assert.equal(p.obtener('a'), null, 'cuando deja de sonar se libera la memoria');
});

test('reintentar vuelve a bajar y puede salir bien', async () => {
  let intento = 0;
  const rutas = rutasOk();
  rutas['/cache-audio/a.m4a'] = () => (++intento === 1 ? respuesta('x', { ok: false, status: 503 }) : respuesta(GRANDE));
  const { p, eventos } = armar(rutas);
  p.apuntar(['a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  p.reintentar('a');
  assert.ok(await hasta(() => p.obtener('a')));
  assert.deepEqual(p.estados().map((e) => e.estado), ['lista']);
});

// ------------------------------------------------------------ canciones de YouTube
const metaYT = (id, extra = {}) => ({ id, origen: 'youtube', videoId: 'abcdefghijk', titulo: 'T (Karaoke)', duracion: 211, audioEstado: 'lista', lrc: null, ...extra });

test('YouTube: no descarga nada; "lista" cuando el reproductor embebido esta listo en esta pantalla', async () => {
  const preparados = [];
  const rutas = { '/api/cancion/yt-a': () => respuesta(metaYT('yt-a')) };
  const { p, eventos, llamadas } = armar(rutas, {}, { prepararYouTube: async (meta) => { preparados.push(meta.videoId); } });
  p.apuntar(['yt-a']);
  assert.ok(await hasta(() => p.obtener('yt-a')));
  assert.equal(p.obtener('yt-a').blobUrl, null, 'sin blob: no hay archivo');
  assert.deepEqual(preparados, ['abcdefghijk']);
  assert.ok(!llamadas.some((u) => /\.m4a|cache-audio/.test(u)), 'no se pide ningun archivo de audio');
  assert.ok(eventos.some((e) => e.etapa === 'reproductor'));
  assert.equal(eventos.at(-1).estado, 'lista');
});

test('YouTube: si el reproductor no se puede preparar (sin Internet / bloqueado) -> error con el motivo', async () => {
  const rutas = { '/api/cancion/yt-a': () => respuesta(metaYT('yt-a')) };
  const { p, eventos } = armar(rutas, {}, { prepararYouTube: async () => { throw new Error('no se pudo cargar el reproductor de YouTube (¿sin Internet?)'); } });
  p.apuntar(['yt-a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /sin Internet/);
});

test('YouTube: la letra es opcional (si falla igual esta lista) y si llega se entrega', async () => {
  const rutasA = { '/api/cancion/yt-a': () => respuesta(metaYT('yt-a', { lrc: '/cache-audio/yt-a.lrc' })), '/cache-audio/yt-a.lrc': () => respuesta('x', { ok: false, status: 404 }) };
  const a = armar(rutasA, {}, { prepararYouTube: async () => {} });
  a.p.apuntar(['yt-a']);
  assert.ok(await hasta(() => a.p.obtener('yt-a')));
  assert.equal(a.p.obtener('yt-a').lrc, null);
  const rutasB = { '/api/cancion/yt-b': () => respuesta(metaYT('yt-b', { lrc: '/cache-audio/yt-b.lrc' })), '/cache-audio/yt-b.lrc': () => respuesta('[00:05.00] hola', { tipo: 'text/plain' }) };
  const b = armar(rutasB, {}, { prepararYouTube: async () => {} });
  b.p.apuntar(['yt-b']);
  assert.ok(await hasta(() => b.p.obtener('yt-b')));
  assert.match(b.p.obtener('yt-b').lrc, /hola/);
});

test('YouTube: el server dice que no se puede reproducir -> error y no se intenta cargar el reproductor', async () => {
  const rutas = { '/api/cancion/yt-a': () => respuesta(metaYT('yt-a', { audioEstado: 'error', audioMotivo: 'el dueño no permite reproducirlo fuera de YouTube' })) };
  let preparo = false;
  const { p, eventos } = armar(rutas, {}, { prepararYouTube: async () => { preparo = true; } });
  p.apuntar(['yt-a']);
  assert.ok(await hasta(() => eventos.some((e) => e.estado === 'error')));
  assert.match(eventos.at(-1).motivo, /fuera de YouTube/);
  assert.equal(preparo, false);
});
