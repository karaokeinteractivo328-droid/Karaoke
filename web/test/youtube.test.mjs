// Reproductor embebido de YouTube (con un YT simulado): reproduccion, autoplay bloqueado,
// errores, precalentado durante la cuenta regresiva y carga de la API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cargarApiYouTube, crearReproductorYouTube, ESTADO, ERRORES } from '../src/lib/youtube.js';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// YT.Player falso: se controla desde afuera que pasa cuando se pide cargar / reproducir
function crearYTFalso({ comportamiento = 'ok' } = {}) {
  const log = { cargas: [], seeks: [], silenciado: null, volumen: null };
  class Player {
    constructor(id, opts) {
      this.opts = opts;
      this.estado = ESTADO.SIN_EMPEZAR;
      this.silenciado = false;
      this.t = 0;
      this.id = id;
      Player.ultimo = this;
      setTimeout(() => opts.events.onReady({}), 2);
    }
    cambiar(e) { this.estado = e; this.opts.events.onStateChange({ data: e }); }
    mute() { this.silenciado = true; log.silenciado = true; }
    unMute() { this.silenciado = false; log.silenciado = false; }
    isMuted() { return this.silenciado; }
    setVolume(v) { this.vol = v; log.volumen = v; }
    getVolume() { return this.vol ?? 100; }
    loadVideoById({ videoId }) {
      log.cargas.push(videoId);
      if (comportamiento === 'error150') return setTimeout(() => this.opts.events.onError({ data: 150 }), 3);
      if (comportamiento === 'bloqueado') return setTimeout(() => this.cambiar(ESTADO.LISTO), 3); // cargo pero NO arranca (autoplay)
      setTimeout(() => this.cambiar(ESTADO.CARGANDO), 1);
      setTimeout(() => this.cambiar(ESTADO.REPRODUCIENDO), 4);
    }
    playVideo() { if (comportamiento === 'ok') setTimeout(() => this.cambiar(ESTADO.REPRODUCIENDO), 2); }
    pauseVideo() { this.cambiar(ESTADO.PAUSADO); }
    stopVideo() { this.cambiar(ESTADO.SIN_EMPEZAR); }
    seekTo(s) { this.t = s; log.seeks.push(s); }
    getCurrentTime() { return this.t; }
    getDuration() { return 211.5; }
    destroy() {}
  }
  return { YT: { Player }, log, Player };
}

function armar(opts = {}, extra = {}) {
  const f = crearYTFalso(opts);
  const eventos = [];
  const errores = [];
  const r = crearReproductorYouTube({ YT: f.YT, elementoId: 'ytPlayer', origen: 'http://x', onEstado: (e) => eventos.push(e), onError: (e) => errores.push(e), ...extra });
  return { ...f, r, eventos, errores };
}

test('reproducir: carga, sube el volumen, sin silencio, y resuelve cuando REALMENTE esta reproduciendo', async () => {
  const x = armar();
  await x.r.reproducir('abcdefghijk');
  assert.equal(x.r.estado, ESTADO.REPRODUCIENDO);
  assert.deepEqual(x.log.cargas, ['abcdefghijk']);
  assert.equal(x.log.silenciado, false, 'con sonido');
  assert.equal(x.log.volumen, 100);
  assert.ok(x.eventos.includes(ESTADO.REPRODUCIENDO));
});

test('el adaptador tiene la forma de un <audio> para reloj.js: currentTime, paused, ended, readyState, duration', async () => {
  const x = armar();
  const a = x.r.adaptador;
  assert.equal(a.paused, true, 'antes de empezar esta pausado');
  await x.r.reproducir('abcdefghijk');
  Player_t(x, 12.5);
  assert.equal(a.paused, false);
  assert.equal(a.currentTime, 12.5, 'el tiempo sale de getCurrentTime del reproductor');
  assert.equal(a.duration, 211.5);
  assert.equal(a.readyState, 4);
  assert.equal(a.muted, false);
  assert.equal(a.ended, false);
  x.Player.ultimo.cambiar(ESTADO.TERMINADO);
  assert.equal(a.ended, true);
  assert.equal(a.paused, true);
  x.Player.ultimo.cambiar(ESTADO.CARGANDO);
  assert.equal(a.readyState, 2);
  assert.equal(a.paused, false, 'cargando datos cuenta como "en curso" (como un <audio> en buffering)');
});
function Player_t(x, t) { x.Player.ultimo.t = t; }

test('autoplay bloqueado: carga pero no arranca -> rechaza con codigo "autoplay" (no se queda esperando)', async () => {
  const x = armar({ comportamiento: 'bloqueado' });
  await assert.rejects(() => x.r.reproducir('abcdefghijk', { ms: 60 }), (e) => e.codigo === 'autoplay' && /bloque/.test(e.message));
});

test('error de YouTube (150: no se permite incrustar) -> mensaje claro y la reproduccion falla', async () => {
  const x = armar({ comportamiento: 'error150' });
  await assert.rejects(() => x.r.reproducir('abcdefghijk', { ms: 500 }), (e) => e.codigo === 'error' && /no permite reproducirlo fuera de YouTube/.test(e.message));
  assert.equal(x.errores[0].codigo, 150);
  assert.match(x.errores[0].mensaje, /fuera de YouTube/);
  for (const c of [2, 5, 100, 101, 150]) assert.ok(ERRORES[c], `hay mensaje para el codigo ${c}`);
});

test('precalentar: durante el 3-2-1 se carga EN SILENCIO y queda en pausa al inicio', async () => {
  const x = armar();
  await x.r.precalentar('abcdefghijk');
  assert.equal(x.r.calentado, 'abcdefghijk');
  assert.equal(x.r.estado, ESTADO.PAUSADO, 'queda en pausa');
  assert.deepEqual(x.log.seeks, [0], 'vuelve al segundo 0');
  assert.equal(x.Player.ultimo.silenciado, true, 'mientras tanto no suena nada');
});

test('si estaba precalentado, reproducir NO vuelve a cargar: solo va al inicio, activa el sonido y arranca', async () => {
  const x = armar();
  await x.r.precalentar('abcdefghijk');
  await x.r.reproducir('abcdefghijk');
  assert.deepEqual(x.log.cargas, ['abcdefghijk'], 'una sola carga en total');
  assert.equal(x.log.silenciado, false);
  assert.equal(x.r.estado, ESTADO.REPRODUCIENDO);
  assert.equal(x.r.calentado, null);
});

test('si el precalentado falla no rompe: despues se carga al empezar', async () => {
  const x = armar({ comportamiento: 'bloqueado' });
  await x.r.precalentar('abcdefghijk', { ms: 40 }); // no lanza
  assert.equal(x.r.calentado, null);
  await assert.rejects(() => x.r.reproducir('abcdefghijk', { ms: 40 }), (e) => e.codigo === 'autoplay');
  assert.equal(x.log.cargas.length, 2, 'volvio a cargar al empezar');
});

test('detener: vuelve al estado inicial y se olvida lo precalentado', async () => {
  const x = armar();
  await x.r.precalentar('abcdefghijk');
  x.r.detener();
  assert.equal(x.r.estado, ESTADO.SIN_EMPEZAR);
  assert.equal(x.r.calentado, null);
});

// -------------------------------------------------------------- cargar la API
function entornoFalso() {
  const scripts = [];
  const win = {};
  const doc = { createElement: () => ({}), head: { append: (s) => scripts.push(s) } };
  return { win, doc, scripts };
}

test('cargarApiYouTube: inyecta el script oficial y resuelve cuando YouTube avisa que esta lista', async () => {
  const e = entornoFalso();
  const p = cargarApiYouTube({ win: e.win, doc: e.doc, timeoutMs: 500 });
  assert.equal(e.scripts[0].src, 'https://www.youtube.com/iframe_api');
  e.win.YT = { Player: class {} };
  e.win.onYouTubeIframeAPIReady();
  assert.equal(await p, e.win.YT);
});

test('cargarApiYouTube: sin Internet / bloqueado -> error claro (no se cuelga)', async () => {
  const e = entornoFalso();
  const p = cargarApiYouTube({ win: e.win, doc: e.doc, timeoutMs: 500 });
  e.scripts[0].onerror();
  await assert.rejects(() => p, /sin Internet/);
  const e2 = entornoFalso();
  await assert.rejects(() => cargarApiYouTube({ win: e2.win, doc: e2.doc, timeoutMs: 30 }), /tardó demasiado/);
});

test('cargarApiYouTube: si la API ya esta cargada resuelve al instante', async () => {
  const e = entornoFalso();
  e.win.YT = { Player: class {} };
  assert.equal(await cargarApiYouTube({ win: e.win, doc: e.doc }), e.win.YT);
  assert.equal(e.scripts.length, 0);
});
