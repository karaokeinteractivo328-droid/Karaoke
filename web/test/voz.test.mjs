// Reconocer si alguien canta (microfono) y alentarlo: logica pura, con reloj falso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearDetectorVoz, crearAliento, MENSAJES_ALIENTO } from '../src/lib/voz.js';

// alimenta el detector con un nivel constante durante `ms` (una muestra cada 50 ms)
function correr(d, desde, ms, nivel) {
  let t = desde;
  const fin = desde + ms;
  for (; t < fin; t += 50) d.muestra(typeof nivel === 'function' ? nivel(t) : nivel, t);
  return t;
}

// ------------------------------------------------------------ detector
test('silencio de la sala: no hay voz y el silencio se va acumulando', () => {
  const d = crearDetectorVoz();
  const t = correr(d, 0, 10_000, 0.002);
  assert.equal(d.cantando(t), false);
  assert.ok(d.silencioMs(t) >= 9_900);
});

test('alguien canta (nivel claramente mayor al piso): se detecta y deja de haber silencio', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 3_000, 0.002); // sala en silencio
  t = correr(d, t, 2_000, 0.08); // canta
  assert.equal(d.cantando(t), true);
  assert.ok(d.silencioMs(t) < 100);
});

test('un golpe de ruido suelto (menos de 250 ms) NO cuenta como cantar', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 3_000, 0.002);
  t = correr(d, t, 150, 0.3); // un portazo
  t = correr(d, t, 3_000, 0.002);
  assert.equal(d.cantando(t), false);
});

test('cantar con pausas cortas para respirar sigue siendo cantar (no reinicia)', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 2_000, 0.002);
  t = correr(d, t, 200, 0.08);
  t = correr(d, t, 100, 0.002); // respira
  t = correr(d, t, 400, 0.08);
  assert.equal(d.cantando(t), true);
});

test('termina de cantar: tras la retencion ya no esta "cantando" y empieza a correr el silencio', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 2_000, 0.002);
  t = correr(d, t, 2_000, 0.08);
  assert.equal(d.cantando(t), true);
  t = correr(d, t, 2_500, 0.002);
  assert.equal(d.cantando(t), false);
  assert.ok(d.silencioMs(t) >= 2_000 && d.silencioMs(t) < 3_000);
});

test('musica que se filtra al micro (ruido de fondo constante y alto): se aprende y la voz se distingue igual', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 8_000, 0.03); // sola la musica filtrada
  assert.equal(d.cantando(t), false, 'la musica sola NO es una persona cantando');
  t = correr(d, t, 2_000, 0.12); // ahora canta por encima
  assert.equal(d.cantando(t), true);
});

test('cantar fuerte un buen rato no "sube el piso" hasta taparse a si mismo', () => {
  const d = crearDetectorVoz();
  let t = correr(d, 0, 2_000, 0.002);
  t = correr(d, t, 60_000, 0.08); // un minuto cantando
  assert.equal(d.cantando(t), true);
});

test('sin datos del micro no se puede decir nada (vivo = false)', () => {
  const d = crearDetectorVoz();
  assert.equal(d.vivo(1000), false);
  d.muestra(0.01, 1000);
  assert.equal(d.vivo(1500), true);
  assert.equal(d.vivo(9000), false, 'el micro dejo de mandar datos');
  assert.equal(d.silencioMs(5000) >= 0, true);
});

test('muestras invalidas (NaN) se ignoran', () => {
  const d = crearDetectorVoz();
  d.muestra(NaN, 0);
  d.muestra(undefined, 50);
  assert.equal(d.vivo(100), false);
});

// ------------------------------------------------------------- aliento
const base = { enCancion: true, cantable: true, micVivo: true, nombre: 'Ana' };

test('con silencio seguido durante la letra, alienta (con el nombre) y no antes de tiempo', () => {
  const a = crearAliento({ azar: () => 0 });
  assert.equal(a.tick({ ...base, ahora: 20_000, silencioMs: 3_000, cancionMs: 20_000 }), null, 'todavia hay poco silencio');
  const r = a.tick({ ...base, ahora: 24_000, silencioMs: 7_500, cancionMs: 24_000 });
  assert.equal(r.accion, 'mostrar');
  assert.equal(r.tipo, 'aliento');
  assert.ok(MENSAJES_ALIENTO.some((m) => m.replace('{nombre}', 'Ana') === r.texto));
});

test('no alienta en los primeros segundos de la cancion ni en un instrumental (cuando la letra no pide cantar)', () => {
  const a = crearAliento();
  assert.equal(a.tick({ ...base, ahora: 5_000, silencioMs: 9_000, cancionMs: 5_000 }), null, 'recien empieza');
  assert.equal(a.tick({ ...base, ahora: 30_000, silencioMs: 20_000, cancionMs: 30_000, cantable: false }), null, 'instrumental');
});

test('no alienta si no hay cancion o no se escucha el micro (no se puede saber si canta)', () => {
  const a = crearAliento();
  assert.equal(a.tick({ ...base, ahora: 30_000, silencioMs: 20_000, cancionMs: 30_000, enCancion: false }), null);
  assert.equal(a.tick({ ...base, ahora: 31_000, silencioMs: 20_000, cancionMs: 31_000, micVivo: false }), null);
});

test('no insiste todo el tiempo: entre un aliento y otro pasan al menos 14 s, y los mensajes cambian', () => {
  const a = crearAliento({ azar: () => 0 });
  const textos = [];
  let t = 20_000;
  const fin = t + 60_000;
  for (; t < fin; t += 500) {
    const r = a.tick({ ...base, ahora: t, silencioMs: 30_000, cancionMs: t });
    if (r?.accion === 'mostrar') textos.push([t, r.texto]);
  }
  assert.ok(textos.length >= 3 && textos.length <= 5, `${textos.length} alientos en un minuto de silencio`);
  for (let i = 1; i < textos.length; i++) {
    assert.ok(textos[i][0] - textos[i - 1][0] >= 14_000, 'separados');
    assert.notEqual(textos[i][1], textos[i - 1][1], 'mensajes distintos');
  }
});

test('el mensaje se oculta solo despues de unos segundos', () => {
  const a = crearAliento({ azar: () => 0 });
  a.tick({ ...base, ahora: 20_000, silencioMs: 8_000, cancionMs: 20_000 });
  assert.equal(a.visible, true);
  assert.equal(a.tick({ ...base, ahora: 22_000, silencioMs: 10_000, cancionMs: 22_000 }), null);
  const r = a.tick({ ...base, ahora: 25_500, silencioMs: 13_500, cancionMs: 25_500 });
  assert.equal(r.accion, 'ocultar');
  assert.equal(a.visible, false);
});

test('si la voz vuelve despues de un aliento, se celebra ("¡Así se canta!") una sola vez', () => {
  const a = crearAliento({ azar: () => 0 });
  a.tick({ ...base, ahora: 20_000, silencioMs: 8_000, cancionMs: 20_000 });
  const r = a.tick({ ...base, ahora: 21_000, silencioMs: 200, cancionMs: 21_000 });
  assert.equal(r.accion, 'mostrar');
  assert.equal(r.tipo, 'bien');
  assert.equal(a.tick({ ...base, ahora: 21_500, silencioMs: 100, cancionMs: 21_500 }), null, 'no se repite');
});

test('quien canta desde el principio nunca recibe aliento ni celebracion', () => {
  const a = crearAliento();
  for (let t = 10_000; t < 120_000; t += 500) {
    assert.equal(a.tick({ ...base, ahora: t, silencioMs: 100, cancionMs: t }), null);
  }
});

test('al terminar la cancion se oculta lo que quedara visible y se reinicia para la proxima', () => {
  const a = crearAliento({ azar: () => 0 });
  a.tick({ ...base, ahora: 20_000, silencioMs: 8_000, cancionMs: 20_000 });
  const r = a.tick({ ...base, ahora: 21_000, silencioMs: 9_000, cancionMs: 21_000, enCancion: false });
  assert.equal(r.accion, 'ocultar');
  // otra cancion: vuelve a empezar de cero (otra vez espera el silencio y el inicio)
  assert.equal(a.tick({ ...base, ahora: 30_000, silencioMs: 8_000, cancionMs: 3_000 }), null);
});
