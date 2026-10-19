// Retos: plan atado a la cancion, validacion sostenida, una sola recompensa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armarPlan, crearRetos, cantidadDeRetos, puntosPorReto, PUNTOS_RETO, PUNTOS_TOTAL_RETOS, MIN_RETOS, MAX_RETOS } from '../src/lib/retos.js';

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
test('plan: un reto cada ~30 s (entre 3 y 7), cada uno vale menos si hay mas, y el total sigue topeado en 30', () => {
  assert.equal(cantidadDeRetos(120), MIN_RETOS, 'una cancion corta tiene al menos 3');
  assert.equal(cantidadDeRetos(200), 5);
  assert.equal(cantidadDeRetos(600), MAX_RETOS, 'y nunca mas de 7');
  assert.equal(puntosPorReto(3), PUNTOS_RETO);
  assert.equal(puntosPorReto(5), 6);
  for (const n of [3, 4, 5, 6, 7]) assert.ok(puntosPorReto(n) * n <= PUNTOS_TOTAL_RETOS + n, `con ${n} retos el total ronda los 30`);
  for (let seed = 1; seed <= 30; seed++) {
    const plan = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(seed) });
    assert.equal(plan.length, 5, 'antes era UNO cada minuto: ahora uno cada ~30 s');
    assert.equal(plan.valor, 6);
    for (let i = 1; i < plan.length; i++) {
      assert.ok(plan[i].at > plan[i - 1].at + 20, 'separados: no cada 3 segundos');
      assert.ok(plan[i].at < plan[i - 1].at + 50, 'pero seguidos: no una vez cada tanto');
    }
    assert.ok(plan[0].at >= 12, 'no arrancan encima del comienzo');
    assert.ok(plan.at(-1).at < 200 - 15, 'ni pegados al final');
  }
});

test('plan: cada reto arranca justo en el comienzo de una linea de letra', () => {
  const plan = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(5) });
  for (const p of plan) assert.ok(INICIOS.includes(p.at), `${p.at} es inicio de linea`);
});

test('plan: en TODA cancion con letra hay exactamente 3 retos de la palabra, repartidos, y los gestos varian sin repetirse seguidos', () => {
  for (const duracion of [60, 90, 120, 180, 200, 237, 306, 480]) {
    for (let seed = 1; seed <= 10; seed++) {
      const plan = armarPlan({ duracion, inicios: INICIOS, azar: lcg(seed) });
      assert.equal(plan.filter((p) => p.tipo === 'palabra').length, 3, `${duracion} s: 3 de la palabra`);
      assert.ok(plan.length >= 3);
      for (let i = 1; i < plan.length; i++) if (plan[i].tipo !== 'palabra') assert.notEqual(plan[i].tipo, plan[i - 1].tipo, 'un gesto nunca se repite seguido');
      assert.equal(plan.conPalabra, true);
    }
  }
  // repartidas: una en cada tercio de la cancion
  const p = armarPlan({ duracion: 300, inicios: INICIOS, azar: lcg(4) });
  const w = p.filter((x) => x.tipo === 'palabra').map((x) => x.at);
  assert.ok(w[0] < 130 && w[1] > 100 && w[1] < 200 && w[2] > 170, `repartidas: ${w.map((x) => Math.round(x)).join(', ')} s`);
  const sin = armarPlan({ duracion: 200, inicios: INICIOS, azar: lcg(2), conPalabra: false });
  assert.equal(sin.filter((p) => p.tipo === 'palabra').length, 0, 'sin letra no hay palabra');
  assert.equal(sin.length, 5);
  assert.equal(sin.conPalabra, false);
});

test('plan: sin letra igual hay plan (reparto parejo)', () => {
  const plan = armarPlan({ duracion: 180, inicios: [], azar: lcg(1) });
  assert.equal(plan.length, cantidadDeRetos(180));
  assert.ok(plan.length >= 3);
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
  assert.equal(c.puntos, r.valor, 'dice cuanto vale (lo mismo que sumara)');
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
  assert.equal(log.cumplidos[0].puntos, r.valor);
  assert.equal(log.cumplidos[0].tipo, 'dos');
  assert.equal(log.resultados.filter((x) => x.ok).length, 1);
  assert.equal(r.activo, null, 'el reto termino');
  assert.equal(log.cartel.at(-1), null, 'el cartel desaparece');
  assert.equal(r.puntaje, r.valor);
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

test('pasa al siguiente reto: se cumplen todos los del plan, cada uno una vez, y el total ronda los 30', () => {
  const { r, log } = montar({ conPalabra: false });
  const tipos = ['una', 'dos', 'saludo', 'corazon', 'una', 'dos', 'saludo'];
  r.plan.forEach((p, i) => { p.tipo = tipos[i]; });
  const datos = { ...DATOS_VACIOS, unaArriba: true, dosArriba: true, saludo: true, corazon: true };
  correr(r, 0, 195, datos);
  assert.equal(log.cumplidos.length, r.plan.length);
  assert.deepEqual(log.cumplidos.map((c) => c.tipo), tipos.slice(0, r.plan.length));
  assert.equal(new Set(log.cumplidos.map((c) => c.id)).size, r.plan.length, 'ids distintos: el server cuenta cada uno una vez');
  const total = log.cumplidos.reduce((s, c) => s + c.puntos, 0);
  assert.ok(total >= 28 && total <= 32, `suman ~30 (${total})`);
});

test('si falla uno los otros siguen sumando', () => {
  const { r, log } = montar({ conPalabra: false });
  r.plan.forEach((p, i) => { p.tipo = ['una', 'dos', 'saludo', 'corazon', 'una'][i]; });
  const datos = (t) => (t > r.plan[1].at && t < r.plan[1].at + 8 ? DATOS_VACIOS : { ...DATOS_VACIOS, unaArriba: true, dosArriba: true, saludo: true, corazon: true });
  correr(r, 0, 195, datos);
  assert.equal(log.cumplidos.length, r.plan.length - 1);
  assert.equal(log.cumplidos.reduce((s, c) => s + c.puntos, 0), (r.plan.length - 1) * r.valor);
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

test('palabra: si no hay palabra para tapar el reto NO se pierde: se reprograma mas adelante hasta 3 veces (y despues se cambia por un gesto)', () => {
  let intentos = 0;
  const { r, log } = montar({ palabra: () => (++intentos >= 5 ? { id: 'w9', hasta: 9999, opciones: ['a1', 'b2', 'c3'] } : null) });
  const it = r.plan.find((p) => p.tipo === 'palabra');
  correr(r, it.at, it.at + 2, DATOS_VACIOS);
  assert.ok(intentos >= 5);
  assert.equal(log.cartel.filter(Boolean).length > 0, true);

  // no hay palabra durante 14 s: no se salta, se reprograma
  const a = montar({ palabra: () => null });
  const ia = a.r.plan.find((p) => p.tipo === 'palabra');
  const at0 = ia.at;
  correr(a.r, at0, at0 + 14, DATOS_VACIOS);
  assert.equal(ia.tipo, 'palabra');
  assert.equal(ia.estado, 'pendiente', 'sigue pendiente');
  assert.ok(ia.at > at0 + 10, 'reprogramado un poco mas adelante');
  assert.equal(ia.reintentos, 1);

  // y si finalmente aparece una palabra, el reto sale
  let hay = false;
  const b = montar({ palabra: () => (hay ? { id: 'wz', hasta: 9999, opciones: ['a1', 'b2', 'c3'] } : null) });
  const ib = b.r.plan.find((p) => p.tipo === 'palabra');
  correr(b.r, ib.at, ib.at + 14, DATOS_VACIOS);
  hay = true;
  correr(b.r, ib.at + 14, ib.at + 30, DATOS_VACIOS);
  assert.ok(b.log.cartel.filter(Boolean).some((c) => c.tipo === 'palabra'), 'aparece apenas se puede');

  // agotados los reintentos con camara: se cambia por un gesto para no perder el reto
  const c = montar({ palabra: () => null });
  const ic = c.r.plan.find((p) => p.tipo === 'palabra');
  correr(c.r, ic.at, ic.at + 70, DATOS_VACIOS);
  assert.notEqual(ic.tipo, 'palabra', 'se cambio por un gesto');

  // sin camara no hay gesto posible: despues de los reintentos se saltea
  const d = montar({ palabra: () => null });
  const id3 = d.r.plan.find((p) => p.tipo === 'palabra');
  correr(d.r, id3.at, id3.at + 80, DATOS_VACIOS, { hayManos: false });
  assert.equal(id3.estado, 'salteado');
});

test('sin camara los gestos se cambian por el reto de la palabra (asi no se pierden los retos)', () => {
  let n = 0;
  const { r, log } = montar({ palabra: () => ({ id: `w${++n}`, hasta: 9999, opciones: ['a1', 'b2', 'c3'] }) });
  const gesto = r.plan.find((p) => p.tipo !== 'palabra');
  if (!gesto) return; // (en canciones cortas todos los retos son de la palabra)
  correr(r, gesto.at, gesto.at + 1, DATOS_VACIOS, { hayManos: false });
  assert.equal(gesto.tipo, 'palabra', 'el gesto pasa a ser de palabra');
  assert.ok(log.cartel.filter(Boolean).some((c) => c.tipo === 'palabra'));
});

test('en una cancion de 3:30 hay retos seguidos durante TODA la cancion (no uno solo)', () => {
  const { r, log } = montar({ conPalabra: true, palabra: () => ({ id: `w${Math.random()}`, hasta: 9999, opciones: ['a1', 'b2', 'c3'] }) });
  r.plan.forEach((p) => { if (p.tipo !== 'palabra') p.tipo = 'saludo'; });
  const datos = (t) => ({ ...DATOS_VACIOS, saludo: true });
  // la persona resuelve todo: gestos con la mano y la palabra desde el celu
  for (let t = 0; t <= 195; t += 0.06) {
    r.tick(t, datos(t));
    if (r.activo?.reto.tipo === 'palabra') r.resolverPalabra({ id: r.activo.id, acierto: true, palabra: 'x', puntos: r.valor });
  }
  const hechos = log.resultados.filter((x) => x.ok).length;
  assert.ok(hechos >= 5, `se cumplieron ${hechos} retos en una sola cancion`);
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
