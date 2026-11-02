// Vigilante de rendimiento: pasa al modo liviano cuando la pantalla va trabada y vuelve cuando se recupera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearVigilante } from '../src/lib/rendimiento.js';

// simula cuadros cada `ms` durante `dur` ms desde `desde`
function cuadros(v, desde, dur, ms, visible = true) {
  let t = desde;
  for (; t < desde + dur; t += ms) v.cuadro(t, visible);
  return t;
}

test('una pantalla fluida (16 ms por cuadro) se queda en modo normal', () => {
  const v = crearVigilante();
  cuadros(v, 0, 30_000, 16);
  assert.equal(v.liviano, false);
});

test('una pantalla trabada (80 ms por cuadro, ~12 fps) pasa SOLA al modo liviano despues de dos ventanas', () => {
  const cambios = [];
  const v = crearVigilante({ alCambiar: (l, ms) => cambios.push([l, Math.round(ms)]) });
  cuadros(v, 0, 3_500, 80);
  assert.equal(v.liviano, false, 'con una sola ventana lenta todavia no (puede ser un tiron)');
  cuadros(v, 3_500, 4_000, 80);
  assert.equal(v.liviano, true);
  assert.equal(cambios.length, 1);
  assert.equal(cambios[0][0], true);
  assert.ok(Math.abs(cambios[0][1] - 80) <= 2);
});

test('un tiron aislado (una ventana lenta entre ventanas buenas) NO activa el modo liviano', () => {
  const v = crearVigilante();
  let t = cuadros(v, 0, 3_100, 16);
  t = cuadros(v, t, 3_100, 90); // una ventana mala
  t = cuadros(v, t, 9_000, 16);
  assert.equal(v.liviano, false);
});

test('una tele a 30 Hz (33 ms por cuadro) NO se considera trabada', () => {
  const v = crearVigilante();
  cuadros(v, 0, 30_000, 33);
  assert.equal(v.liviano, false);
});

test('en modo liviano se queda un rato aunque mejore y vuelve al normal cuando se recupera de verdad', () => {
  const cambios = [];
  const v = crearVigilante({ alCambiar: (l) => cambios.push(l) });
  let t = cuadros(v, 0, 8_000, 80);
  assert.equal(v.liviano, true);
  t = cuadros(v, t, 20_000, 16); // mejora pero todavia no pasaron 45 s
  assert.equal(v.liviano, true, 'no va y viene');
  t = cuadros(v, t, 40_000, 16);
  assert.equal(v.liviano, false);
  assert.deepEqual(cambios, [true, false]);
});

test('con la pestaña oculta no se evalua nada (el navegador frena los cuadros y eso no es culpa de la compu)', () => {
  const v = crearVigilante();
  let t = cuadros(v, 0, 20_000, 500, false);
  assert.equal(v.liviano, false);
  cuadros(v, t, 3_000, 16);
  assert.equal(v.liviano, false);
});

test('las pausas largas (cambio de pestaña) no cuentan como cuadros lentos', () => {
  const v = crearVigilante();
  let t = cuadros(v, 0, 3_000, 16);
  t += 20_000; // la pestaña estuvo en segundo plano
  cuadros(v, t, 6_500, 16);
  assert.equal(v.liviano, false);
});
