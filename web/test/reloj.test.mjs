// Sincronizacion: el audio manda. Reloj + letra palabra por palabra.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearReloj, ANTICIPO_LETRA } from '../src/lib/reloj.js';
import { parsearLRC, indiceActual, tiemposPalabras } from '../src/lib/lrc.js';

function mundo({ esperaMaxMs, latencia } = {}) {
  let now = 50_000;
  const audio = { currentTime: 0, paused: true, ended: false, readyState: 0, playbackRate: 1 };
  const reloj = crearReloj({ audio, ahora: () => now, esperaMaxMs, latencia });
  return {
    audio, reloj,
    avanzar(ms) { now += ms; if (!audio.paused) audio.currentTime += ms / 1000; },
    sonar() { audio.paused = false; audio.readyState = 4; reloj.alReproducir(); },
  };
}

test('mientras el audio carga la letra NO se adelanta (antes corria un reloj propio)', () => {
  const m = mundo();
  m.reloj.iniciar({ conAudio: true });
  m.avanzar(3000); // 3 s cargando el audio
  assert.equal(m.reloj.base(), 0);
  assert.equal(m.reloj.modo, 'espera');
  m.sonar();
  assert.equal(m.reloj.base(), 0, 'arranca desde el comienzo del audio, sin saltos');
});

test('con el audio sonando, el tiempo ES audio.currentTime (sin acumular error)', () => {
  const m = mundo();
  m.reloj.iniciar({ conAudio: true });
  m.sonar();
  for (let i = 0; i < 6000; i++) m.avanzar(50); // 5 minutos
  assert.ok(Math.abs(m.reloj.base() - m.audio.currentTime) <= 0.1, 'sigue al audio, sin deriva');
});

test('si el audio se traba (buffering), la letra se queda con el en vez de seguir sola', () => {
  const m = mundo();
  m.reloj.iniciar({ conAudio: true });
  m.sonar();
  m.avanzar(5000);
  const antes = m.reloj.base();
  m.audio.paused = true; // se trabo
  m.audio.readyState = 2;
  const t = (() => { let x = 0; for (let i = 0; i < 40; i++) { m.avanzar(100); x = m.reloj.base(); } return x; })();
  assert.ok(Math.abs(t - antes) < 0.15, 'no avanza mientras el audio no avanza');
  m.audio.paused = false;
  m.audio.readyState = 4;
  m.avanzar(1000);
  assert.ok(m.reloj.base() > antes + 0.8, 'y retoma con el');
});

test('si el audio nunca suena, despues de la espera se sigue con un reloj propio', () => {
  const m = mundo({ esperaMaxMs: 6000 });
  m.reloj.iniciar({ conAudio: true });
  m.avanzar(5900);
  assert.equal(m.reloj.base(), 0);
  m.avanzar(300);
  assert.equal(m.reloj.modo, 'interno');
  assert.ok(m.reloj.base() < 0.5, 'arranca de cero en ese momento');
  m.avanzar(2000);
  assert.ok(Math.abs(m.reloj.base() - 2.1) < 0.2);
});

test('sin audio configurado se usa el reloj interno desde el principio', () => {
  const m = mundo();
  m.reloj.iniciar({ conAudio: false });
  m.avanzar(1500);
  assert.equal(m.reloj.modo, 'interno');
  assert.ok(Math.abs(m.reloj.base() - 1.5) < 0.01);
});

test('letra(offset) = audio - offset - latencia + anticipo; offsets distintos corren la letra', () => {
  const m = mundo({ latencia: () => 0.05 });
  m.reloj.iniciar({ conAudio: true });
  m.sonar();
  m.avanzar(10_000);
  const sin = m.reloj.letra(0);
  assert.ok(Math.abs(sin - (10 - 0.05 + ANTICIPO_LETRA)) < 0.1);
  assert.ok(Math.abs(m.reloj.letra(2) - (sin - 2)) < 0.01, 'offset +2 atrasa la letra 2 s');
  assert.ok(Math.abs(m.reloj.letra(-1.5) - (sin + 1.5)) < 0.01, 'offset negativo la adelanta');
});

test('la latencia de salida se acota (un valor raro del navegador no rompe la letra)', () => {
  const m = mundo({ latencia: () => 5 });
  m.reloj.iniciar({ conAudio: true });
  m.sonar();
  m.avanzar(10_000);
  assert.ok(m.reloj.letra(0) > 9.7 - 0.01 + ANTICIPO_LETRA - 0.1);
});

// ------------------------------------------------------------ letra / palabras
const LRC = `[00:10.00]Hola mundo lindo
[00:14.00]Esta es otra linea de la cancion
[00:30.00]Despues de un instrumental largo
[00:34.50]Ultima linea`;

test('cada linea se muestra en su momento exacto (inicio, medio, cambio de linea, final)', () => {
  const L = parsearLRC(LRC);
  assert.equal(indiceActual(L, 9.99), -1, 'antes del comienzo');
  assert.equal(indiceActual(L, 10), 0);
  assert.equal(indiceActual(L, 13.99), 0);
  assert.equal(indiceActual(L, 14), 1, 'cambio de linea');
  assert.equal(indiceActual(L, 29.9), 1);
  assert.equal(indiceActual(L, 30), 2);
  assert.equal(indiceActual(L, 99), 3, 'final de la cancion: la ultima linea');
});

test('palabra por palabra: avanzan en orden, la primera arranca con la linea', () => {
  const p = tiemposPalabras('Hola mundo lindo', 10, 14);
  assert.equal(p.length, 3);
  assert.equal(p[0].t0, 10);
  assert.ok(p[1].t0 > p[0].t0 && p[2].t0 > p[1].t0);
  assert.ok(p[2].t0 < 14, 'todas antes de la linea siguiente');
});

test('palabra por palabra: un instrumental largo no estira las ultimas palabras', () => {
  const p = tiemposPalabras('Esta es otra linea de la cancion', 14, 30); // 16 s hasta la proxima
  const ultima = p.at(-1).t0;
  assert.ok(ultima - 14 < 5, `la ultima palabra empieza a ${(ultima - 14).toFixed(1)} s, no al final del hueco`);
});

test('palabra por palabra: linea corta y pegada a la siguiente se comprime en el hueco real', () => {
  const p = tiemposPalabras('Una linea bastante larga para tan poco tiempo', 20, 21.5);
  assert.ok(p.at(-1).t0 < 21.5);
});

test('ultima linea sin siguiente usa una duracion razonable', () => {
  const p = tiemposPalabras('Ultima linea', 34.5, undefined);
  assert.ok(p.at(-1).t0 < 34.5 + 4);
});

test('simulacion: la letra sigue al audio durante toda la cancion en distintos offsets', () => {
  for (const offset of [-1, 0, 1.5]) {
    const m = mundo();
    const L = parsearLRC(LRC);
    m.reloj.iniciar({ conAudio: true });
    m.sonar();
    let ultimo = -1;
    for (let ms = 0; ms < 40_000; ms += 60) {
      m.avanzar(60);
      const idx = indiceActual(L, m.reloj.letra(offset));
      assert.ok(idx >= ultimo, 'la letra nunca retrocede');
      ultimo = idx;
    }
    assert.equal(ultimo, 3);
  }
});
