// Retos: plan atado a la cancion, validacion sostenida, una sola recompensa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armarPlan, crearRetos, PUNTOS_RETO, RETOS_POR_CANCION } from '../src/lib/retos.js';

// azar determinista
function lcg(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const INICIOS = Array.from({ length: 60 }, (_, i) => 10 + i * 4); // una linea cada 4 s desde el s 10
const DATOS_VACIOS = { manos: [], unaArriba: false, dosArriba: false, saludo: false, corazon: false };
const DOS = { ...DATOS_VACIOS, unaArriba: true, dosArriba: true };

function montar({ conPalabra = true, seed = 3, palabra = null } = {}) {
  const log = { cartel: [], cumplidos: [], resultados: [], palabraFin: [] };
  const r = crearRetos({
    azar: lcg(seed),
    onCartel: (c) => log.cartel.push(c),
    onCumplido: (c) => log.cumplidos.push(c),
    onResultado: (x) => log.resultados.push(x),
    onPalabra: palabra,
    onPalabraFin: (x) => log.palabraFin.push(x),
  });
  r.planificar({ duracion: 200, inicios: INICIOS, conPalabra });
  return { r, log };
}

// avanza el tiempo de la cancion de a 60 ms (como tickLetra) hasta `hasta`
function correr(r, desde, hasta, datos, opts) {
  for (let t = desde; t <= hasta + 1e-9; t += 0.06) r.tick(t, typeof datos === 'function' ? datos(t) : datos, opts);
}

// ------------------------------------------------------------------- plan
test('plan: 3 retos de 10 puntos (tope 30), dentro de la cancion y ordenados', () => {
  assert.equal(RETOS_POR_CANCION * PUNTOS_RETO, 30);
  for (let seed = 1; seed <= 30; seed++) {
    const plan = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(seed) });
    assert.equal(plan.length, 3);
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at > plan[i - 1].at + 20, 'separados');
    assert.ok(plan[0].at >= 14, 'no arrancan encima del comienzo');
    assert.ok(plan.at(-1).at < 200 - 15, 'ni pegados al final');
  }
});

test('plan: cada reto arranca justo en el comienzo de una linea de letra', () => {
  const plan = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(5) });
  for (const p of plan) assert.ok(INICIOS.includes(p.at), `${p.at} es inicio de linea`);
});

test('plan: incluye el reto de la palabra (si se pide) y gestos distintos', () => {
  const plan = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(2) });
  assert.equal(plan.filter((p) => p.tipo === 'palabra').length, 1);
  const sin = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(2), conPalabra: false });
  assert.equal(sin.filter((p) => p.tipo === 'palabra').length, 0);
  assert.equal(new Set(plan.map((p) => p.tipo)).size, 3, 'no se repiten');
});

test('plan: sin letra igual hay plan (reparto parejo)', () => {
  const plan = armarPlan({ duracion: 180, inicios: [], azar: lcg(1) });
  assert.equal(plan.length, 3);
});

// -------------------------------------------------------------- aparicion
test('el reto NO aparece antes de su momento y SI en el momento correcto', () => {
  const { r, log } = montar({ conPalabra: false });
  const primero = r.plan[0];
  correr(r, 0, primero.at - 0.2, DATOS_VACIOS);
  assert.equal(log.cartel.filter(Boolean).length, 0, 'antes de su momento no hay cartel');
  correr(r, primero.at - 0.2, primero.at + 0.5, DATOS_VACIOS);
  const c = log.cartel.filter(Boolean)[0];
  assert.ok(c, 'aparece');
  assert.ok(c.icono && c.texto, 'se entiende que hay que hacer');
  assert.equal(c.puntos, 10, 'dice cuanto vale');
  assert.equal(c.resto > 0.9, true);
});

test('retos con camara: sin tracking de manos los gestos se saltean (la cancion sigue)', () => {
  const { r, log } = montar({ conPalabra: false });
  correr(r, 0, 195, DATOS_VACIOS, { hayManos: false });
  assert.equal(log.cartel.filter(Boolean).length, 0);
  assert.ok(r.plan.every((p) => p.estado === 'salteado'));
});

// ---------------------------------------------------- validacion y puntos
test('gesto sostenido: cuenta UNA vez aunque se mantenga 3 segundos, y el reto desaparece', () => {
  const { r, log } = montar({ conPalabra: false });
  const it = r.plan[0];
  it.tipo = 'dos';
  correr(r, it.at, it.at + 3, DOS); // 3 s con las dos manos arriba
  assert.equal(log.cumplidos.length, 1, 'una sola recompensa');
  assert.equal(log.cumplidos[0].puntos, 10);
  assert.equal(log.cumplidos[0].tipo, 'dos');
  assert.equal(log.resultados.filter((x) => x.ok).length, 1);
  assert.equal(r.activo, null, 'el reto termino');
  assert.equal(log.cartel.at(-1), null, 'el cartel desaparece');
  assert.equal(r.puntaje, 10);
});

test('un frame suelto (menos del tiempo de validacion) NO cuenta', () => {
  const { r, log } = montar({ conPalabra: false });
  const it = r.plan[0];
  it.tipo = 'dos';
  correr(r, it.at, it.at + 0.12, DOS); // ~2 ticks
  correr(r, it.at + 0.12, it.at + 1, DATOS_VACIOS);
  assert.equal(log.cumplidos.length, 0);
});

test('un parpadeo corto del tracker no reinicia, uno largo si', () => {
  const { r, log } = montar({ conPalabra: false });
  const it = r.plan[0];
  it.tipo = 'dos';
  const t0 = it.at;
  // 0.3 s con las manos, 0.1 s sin deteccion, 0.3 s mas: acumula -> valida
  correr(r, t0, t0 + 0.3, DOS);
  correr(r, t0 + 0.3, t0 + 0.4, DATOS_VACIOS);
  correr(r, t0 + 0.4, t0 + 0.8, DOS);
  assert.equal(log.cumplidos.length, 1);

  const b = montar({ conPalabra: false });
  const it2 = b.r.plan[0];
  it2.tipo = 'dos';
  correr(b.r, it2.at, it2.at + 0.3, DOS);
  correr(b.r, it2.at + 0.3, it2.at + 0.7, DATOS_VACIOS); // 0.4 s sin gesto: reinicia
  correr(b.r, it2.at + 0.7, it2.at + 1.0, DOS); // otra vez 0.3 s: todavia no alcanza
  assert.equal(b.log.cumplidos.length, 0);
});

test('el saludo (ya es un movimiento sostenido) valida apenas se detecta', () => {
  const { r, log } = montar({ conPalabra: false });
  const it = r.plan[0];
  it.tipo = 'saludo';
  correr(r, it.at, it.at + 0.5, { ...DATOS_VACIOS, saludo: true });
  assert.equal(log.cumplidos.length, 1);
  assert.equal(log.cumplidos[0].tipo, 'saludo');
});

test('si no se hace el gesto, el reto termina por tiempo, sin puntos y avisa', () => {
  const { r, log } = montar({ conPalabra: false });
  const it = r.plan[0];
  correr(r, it.at, it.at + 12, DATOS_VACIOS);
  assert.equal(log.cumplidos.length, 0);
  const fin = log.resultados.find((x) => !x.ok);
  assert.ok(fin);
  assert.equal(fin.puntos, 0);
  assert.equal(r.activo, null);
});

test('pasa al siguiente reto y 3 aciertos suman 30', () => {
  const { r, log } = montar({ conPalabra: false });
  r.plan.forEach((p, i) => { p.tipo = ['una', 'dos', 'saludo'][i]; });
  const datos = { ...DATOS_VACIOS, unaArriba: true, dosArriba: true, saludo: true };
  correr(r, 0, 195, datos);
  assert.equal(log.cumplidos.length, 3);
  assert.deepEqual(log.cumplidos.map((c) => c.tipo), ['una', 'dos', 'saludo']);
  assert.equal(new Set(log.cumplidos.map((c) => c.id)).size, 3, 'ids distintos: el server cuenta cada uno una vez');
  assert.equal(log.cumplidos.reduce((s, c) => s + c.puntos, 0), 30);
});

test('si falla uno (20/30) los otros siguen sumando', () => {
  const { r, log } = montar({ conPalabra: false });
  r.plan.forEach((p, i) => { p.tipo = ['una', 'dos', 'saludo'][i]; });
  const datos = (t) => (t > r.plan[1].at && t < r.plan[1].at + 8 ? DATOS_VACIOS : { ...DATOS_VACIOS, unaArriba: true, dosArriba: true, saludo: true });
  correr(r, 0, 195, datos);
  assert.equal(log.cumplidos.reduce((s, c) => s + c.puntos, 0), 20);
});

test('un momento perdido (pausa, carga lenta) se saltea en vez de aparecer tarde', () => {
  const { r, log } = montar({ conPalabra: false });
  r.tick(r.plan[0].at + 30, DATOS_VACIOS); // se entero 30 s tarde
  assert.equal(log.cartel.filter(Boolean).length, 0);
  assert.equal(r.plan[0].estado, 'salteado');
});

// ---------------------------------------------------------------- palabra
function palabraOk(hasta = 9999) {
  return () => ({ id: 'w1', hasta, opciones: ['amor', 'noche', 'fuego'] });
}

test('palabra: el cartel trae las opciones y NINGUN gesto la resuelve solo', () => {
  const { r, log } = montar({ palabra: palabraOk() });
  const it = r.plan.find((p) => p.tipo === 'palabra');
  // puño, pellizco, dos manos... todo en el aire: no resuelve nada
  correr(r, it.at, it.at + 5, { ...DATOS_VACIOS, dosArriba: true, unaArriba: true, saludo: true, corazon: true, pellizco: true });
  const c = log.cartel.filter(Boolean).at(-1);
  assert.equal(c.tipo, 'palabra');
  assert.deepEqual(c.opciones, ['amor', 'noche', 'fuego']);
  assert.equal(log.cumplidos.length, 0);
  assert.equal(log.resultados.length, 0);
  assert.ok(r.activo, 'sigue esperando una respuesta real');
});

test('palabra: la resuelve el resultado del server (acierto y error), una vez', () => {
  const a = montar({ palabra: palabraOk() });
  const it = a.r.plan.find((p) => p.tipo === 'palabra');
  correr(a.r, it.at, it.at + 1, DATOS_VACIOS);
  assert.equal(a.r.resolverPalabra({ id: 'w1', acierto: true, palabra: 'noche', puntos: 10 }), true);
  assert.equal(a.log.resultados.at(-1).ok, true);
  assert.equal(a.log.resultados.at(-1).puntos, 10);
  assert.equal(a.r.resolverPalabra({ id: 'w1', acierto: true }), false, 'no se resuelve dos veces');
  assert.equal(a.r.activo, null);

  const b = montar({ palabra: palabraOk() });
  const it2 = b.r.plan.find((p) => p.tipo === 'palabra');
  correr(b.r, it2.at, it2.at + 1, DATOS_VACIOS);
  b.r.resolverPalabra({ id: 'w1', acierto: false, palabra: 'noche' });
  assert.equal(b.log.resultados.at(-1).ok, false);
  assert.equal(b.log.resultados.at(-1).palabra, 'noche');
});

test('palabra: si todavia no hay una palabra con tiempo se reintenta, y despues se saltea', () => {
  let intentos = 0;
  const { r, log } = montar({ palabra: () => (++intentos >= 5 ? { id: 'w9', hasta: 9999, opciones: ['a1', 'b2', 'c3'] } : null) });
  const it = r.plan.find((p) => p.tipo === 'palabra');
  correr(r, it.at, it.at + 2, DATOS_VACIOS);
  assert.ok(intentos >= 5);
  assert.equal(log.cartel.filter(Boolean).length > 0, true);

  const b = montar({ palabra: () => null });
  const it2 = b.r.plan.find((p) => p.tipo === 'palabra');
  correr(b.r, it2.at, it2.at + 14, DATOS_VACIOS);
  assert.equal(it2.estado, 'salteado');
});

test('palabra: sin respuesta, se cierra por tiempo y avisa al server', () => {
  const { r, log } = montar({ palabra: () => ({ id: 'w2', hasta: 0, opciones: ['a1', 'b2', 'c3'] }) });
  const it = r.plan.find((p) => p.tipo === 'palabra');
  const hasta = it.at + 5;
  // el limite del reto ya paso (hasta=0): cierra enseguida
  correr(r, it.at, hasta, DATOS_VACIOS);
  assert.ok(log.palabraFin.length >= 1);
  assert.equal(log.resultados.at(-1).ok, false);
});
