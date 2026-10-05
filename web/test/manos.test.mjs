// Tracking (seguimiento.js) + gestos (manos.js) con landmarks sinteticos a 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearSeguimiento } from '../src/lib/seguimiento.js';
import { crearGestos, esSaludo } from '../src/lib/manos.js';

// Una mano de 21 puntos centrada en (cx, cy): muneca abajo, dedos arriba.
// `pinza` = pulgar pegado al indice.
function mano(cx, cy, { pinza = false } = {}) {
  const p = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  const set = (i, x, y) => { p[i] = { x: cx + x, y: cy + y, z: 0 }; };
  set(0, 0, 0.09); // muneca
  set(5, -0.03, 0.01); set(9, 0, 0); set(13, 0.03, 0.01); set(17, 0.055, 0.03); // base de los dedos
  set(8, -0.03, -0.08); set(12, 0, -0.09); set(16, 0.03, -0.08); set(20, 0.055, -0.06); // puntas
  set(4, pinza ? -0.03 : 0.07, pinza ? -0.075 : -0.02); // pulgar
  return { puntos: p, puntaje: 0.9 };
}

const CARA = { cx: 0.5, cy: 0.3, w: 0.12, h: 0.2 }; // menton ~ y=0.41

function escena({ opciones = 0 } = {}) {
  const seg = crearSeguimiento();
  const eventos = { opcion: [] };
  let ultimo = null;
  const g = crearGestos({
    getOpciones: () => opciones,
    onOpcion: (i) => eventos.opcion.push(i),
    onManos: (d) => { ultimo = d; },
  });
  let ts = 10_000;
  // avanza `ms` milisegundos a 30 fps; f(t) devuelve las detecciones del instante t (ms desde el inicio)
  function correr(ms, f, cara = CARA) {
    const t0 = ts;
    for (let t = 0; t < ms; t += 33) {
      ts = t0 + t;
      g({ manos: seg.actualizar(f(t), ts), cara, ts });
    }
    ts = t0 + ms;
    return ultimo;
  }
  return { correr, eventos, seg, get d() { return ultimo; } };
}

// ---------------------------------------------------------------- TRACKING
test('tracking: una mano conserva su id mientras se la ve, aunque se mueva rapido', () => {
  const seg = crearSeguimiento();
  let id = null;
  for (let i = 0; i < 40; i++) {
    const x = 0.2 + i * 0.012; // ~0.4 de ancho por segundo
    const [tr] = seg.actualizar([mano(x, 0.5)], 1000 + i * 33);
    id ??= tr.id;
    assert.equal(tr.id, id);
  }
});

test('tracking: dos manos con la misma etiqueta NO se mezclan (cada una su filtro e id)', () => {
  const seg = crearSeguimiento();
  let a = null;
  let b = null;
  for (let i = 0; i < 30; i++) {
    const ts = 1000 + i * 33;
    // se entregan en orden cambiante: la identidad no depende del orden ni de la etiqueta
    const dets = i % 2 ? [mano(0.25, 0.4), mano(0.75, 0.4)] : [mano(0.75, 0.4), mano(0.25, 0.4)];
    const trs = seg.actualizar(dets, ts);
    assert.equal(trs.length, 2);
    const izq = trs.find((t) => t.centro.x < 0.5);
    const der = trs.find((t) => t.centro.x >= 0.5);
    a ??= izq.id;
    b ??= der.id;
    assert.equal(izq.id, a);
    assert.equal(der.id, b);
    assert.ok(Math.abs(izq.centro.x - 0.25) < 0.03 && Math.abs(der.centro.x - 0.75) < 0.03, 'posiciones no mezcladas');
  }
});

test('tracking: la misma mano detectada dos veces cuenta una sola vez', () => {
  const seg = crearSeguimiento();
  const trs = seg.actualizar([mano(0.5, 0.5), mano(0.51, 0.5)], 1000);
  assert.equal(trs.length, 1);
});

test('tracking: una mano que se pierde 1-2 frames se conserva (perdida) y despues se descarta', () => {
  const seg = crearSeguimiento();
  const [t0] = seg.actualizar([mano(0.5, 0.5)], 1000);
  let trs = seg.actualizar([], 1066); // 66 ms sin deteccion
  assert.equal(trs.length, 1);
  assert.equal(trs[0].id, t0.id);
  assert.equal(trs[0].perdida, true);
  trs = seg.actualizar([mano(0.5, 0.5)], 1100); // vuelve: misma mano
  assert.equal(trs[0].id, t0.id);
  assert.equal(trs[0].perdida, false);
  trs = seg.actualizar([], 1500); // mucho tiempo: se va
  assert.equal(trs.length, 0);
});

// ------------------------------------------------------------------ GESTOS
test('0 manos -> nada', () => {
  const e = escena();
  const d = e.correr(1000, () => []);
  assert.equal(d.cantidadManos, 0);
  assert.equal(d.arriba, 0);
  assert.equal(d.saludo, false);
  assert.equal(d.corazon, false);
});

test('1 mano arriba -> arriba=1 (despues de ser estable, no por un frame)', () => {
  const e = escena();
  const d1 = e.correr(66, () => [mano(0.5, 0.3)]); // 2 frames
  assert.equal(d1.arriba, 0, 'un par de frames no alcanza');
  const d = e.correr(500, () => [mano(0.5, 0.3)]);
  assert.equal(d.arriba, 1);
  assert.equal(d.unaArriba, true);
  assert.equal(d.dosArriba, false);
});

test('mano abajo (por debajo del menton) no cuenta como arriba', () => {
  const e = escena();
  const d = e.correr(800, () => [mano(0.5, 0.7)]);
  assert.equal(d.arriba, 0);
});

test('2 manos arriba -> arriba=2 y dosArriba; un solo frame no dispara', () => {
  const e = escena();
  e.correr(800, () => [mano(0.5, 0.7)]);
  const apenas = e.correr(33, () => [mano(0.3, 0.3), mano(0.7, 0.3)]);
  assert.equal(apenas.dosArriba, false, 'un frame no alcanza');
  const d = e.correr(500, () => [mano(0.3, 0.3), mano(0.7, 0.3)]);
  assert.equal(d.arriba, 2);
  assert.equal(d.dosArriba, true);
});

test('2 manos arriba sobrevive a perder una mano un instante (sin parpadeo)', () => {
  const e = escena();
  e.correr(600, () => [mano(0.3, 0.3), mano(0.7, 0.3)]);
  const d = e.correr(100, () => [mano(0.3, 0.3)]); // 100 ms sin la mano derecha
  assert.equal(d.dosArriba, true);
  const final = e.correr(400, () => [mano(0.3, 0.3), mano(0.7, 0.3)]);
  assert.equal(final.dosArriba, true);
});

test('una mano detectada dos veces NO es "dos manos arriba"', () => {
  const e = escena();
  const d = e.correr(800, () => [mano(0.5, 0.3), mano(0.52, 0.3)]);
  assert.equal(d.dosArriba, false);
  assert.equal(d.arriba, 1);
});

test('si se baja una de las dos manos deja de ser "dos"', () => {
  const e = escena();
  e.correr(600, () => [mano(0.3, 0.3), mano(0.7, 0.3)]);
  const d = e.correr(800, () => [mano(0.3, 0.3), mano(0.7, 0.75)]);
  assert.equal(d.dosArriba, false);
  assert.equal(d.arriba, 1);
});

test('con copiloto (3+ manos) "dos manos arriba" pide una por lado', () => {
  const e = escena();
  let d = e.correr(800, () => [mano(0.1, 0.3), mano(0.3, 0.3), mano(0.8, 0.75)]);
  assert.equal(d.dosArriba, false, 'las dos arriba del mismo lado no valen');
  d = e.correr(800, () => [mano(0.2, 0.3), mano(0.8, 0.3), mano(0.5, 0.75)]);
  assert.equal(d.dosArriba, true);
});

test('sin cara visible usa la mitad del cuadro como referencia', () => {
  const e = escena();
  const d = e.correr(800, () => [mano(0.5, 0.35)], null);
  assert.equal(d.arriba, 1);
  const d2 = e.correr(800, () => [mano(0.5, 0.65)], null);
  assert.equal(d2.arriba, 0);
});

// ----------------------------------------------------------------- SALUDO
const ola = (t, amp = 0.06, hz = 2.5) => 0.5 + amp * Math.sin(2 * Math.PI * hz * (t / 1000));

test('saludo: la mano va y viene de lado a lado -> se detecta, aunque no sea exagerado', () => {
  const e = escena();
  const d = e.correr(1200, (t) => [mano(ola(t, 0.05), 0.35)]); // amplitud chica
  assert.equal(d.saludo, true);
});

test('saludo: una mano quieta (con temblor) NO saluda', () => {
  const e = escena();
  const d = e.correr(2500, (t) => [mano(0.5 + 0.004 * Math.sin(t / 37), 0.35 + 0.003 * Math.cos(t / 23))]);
  assert.equal(d.saludo, false);
});

test('saludo: mover la mano de un lugar a otro sin volver NO es un saludo', () => {
  const e = escena();
  const d = e.correr(1500, (t) => [mano(0.3 + Math.min(0.4, (t / 1500) * 0.4), 0.35)]);
  assert.equal(d.saludo, false);
});

test('saludo: cooldown, un saludo largo no dispara muchas veces', () => {
  const seg = crearSeguimiento();
  let activo = false;
  let subidas = 0;
  let ts = 5000;
  const gestos = crearGestos({ onManos: (d) => { if (d.saludo && !activo) subidas++; activo = d.saludo; } });
  for (let t = 0; t < 2300; t += 33) { // 2.3 s saludando sin parar (menos que el cooldown de 2.5 s)
    ts += 33;
    gestos({ manos: seg.actualizar([mano(ola(t, 0.06), 0.35)], ts), cara: CARA, ts });
  }
  assert.equal(subidas, 1);
});

test('esSaludo es puro: quieta = false, oscilando = true', () => {
  const quieta = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, x: 0.5, y: 0.4 }));
  const ondas = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, x: 0.5 + 0.06 * Math.sin(i * 0.5), y: 0.4 }));
  assert.equal(esSaludo(quieta, 29 * 33), false);
  assert.equal(esSaludo(ondas, 29 * 33), true);
});

// ------------------------------------------------- PELLIZCO y OPCIONES
test('opciones del reto: la mano elige por posicion y solo el pellizco SOSTENIDO responde', () => {
  const e = escena({ opciones: 3 });
  let d = e.correr(1500, () => [mano(0.85, 0.5)]); // mano a la derecha, sin pellizcar
  assert.equal(d.opcionSel, 2);
  assert.deepEqual(e.eventos.opcion, [], 'abrir o cerrar la mano no responde');
  d = e.correr(1200, () => [mano(0.85, 0.5, { pinza: true })]); // pellizco sostenido
  assert.deepEqual(e.eventos.opcion, [2]);
  e.correr(1500, () => [mano(0.85, 0.5, { pinza: true })]); // seguir pellizcando no vuelve a responder
  assert.deepEqual(e.eventos.opcion, [2]);
});

test('opciones: un pellizco rapido no responde', () => {
  const e = escena({ opciones: 3 });
  e.correr(600, () => [mano(0.5, 0.5)]);
  e.correr(300, () => [mano(0.5, 0.5, { pinza: true })]);
  e.correr(600, () => [mano(0.5, 0.5)]);
  assert.deepEqual(e.eventos.opcion, []);
});

test('las canciones NO se eligen con la mano: mano arriba/abajo y pellizco no hacen nada fuera de un reto', () => {
  const e = escena();
  e.correr(600, () => [mano(0.5, 0.2)]);
  const d = e.correr(1500, () => [mano(0.5, 0.5, { pinza: true })]);
  assert.deepEqual(e.eventos.opcion, [], 'sin reto de palabra no hay nada que confirmar');
  assert.equal(d.opcionSel, -1);
  assert.equal('zonaScroll' in d, false, 'ya no existe la zona de scroll');
});
