// Retos con puntos reales (server) y reto de la palabra faltante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearEscenario, ETAPAS } from '../escenario.js';

const CANCIONES = [
  { id: 'a', titulo: 'Cancion A', artista: 'Artista A', duracion: 100 },
  { id: 'b', titulo: 'Cancion B', artista: 'Artista B', duracion: 120 },
  { id: 'd', titulo: 'Dueto D', artista: 'Artista D', duracion: 100, voces: 'duo' },
];
const tk = (n) => `token-${n}`.padEnd(20, 'x');

function mundo() {
  let t = 1_000_000;
  const retosRes = [];
  const e = crearEscenario({
    canciones: CANCIONES,
    ahora: () => t,
    onRetoResultado: (r) => retosRes.push(r),
  });
  const avanzar = (ms) => {
    let resto = ms;
    while (resto > 0) {
      const paso = Math.min(1000, resto);
      t += paso;
      resto -= paso;
      e.tick();
    }
  };
  const persona = (n, nombre = `P${n}`) => {
    e.hola({ token: tk(n), nombre });
    return tk(n);
  };
  return { e, avanzar, persona, retosRes };
}

function aEscenario(m, token) {
  m.e.elegirCancion(token, 'a', 'solo');
  assert.equal(m.e.pantallaConfirmar({ cancionId: 'a' }).ok, true);
  m.avanzar(m.e.config.COUNTDOWN_S * 1000);
  assert.equal(m.e.etapa, ETAPAS.PLAYING);
}

// ------------------------------------------------------------------- retos
test('retos: cada reto suma una sola vez (aunque el gesto se mantenga) y el tope es 30', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  assert.equal(m.e.pantallaRetoCumplido({ id: 'x1', tipo: 'dos' }).total, 10);
  // la pantalla insiste (3 s con las manos arriba, o se recarga y reenvia)
  for (let i = 0; i < 5; i++) assert.equal(m.e.pantallaRetoCumplido({ id: 'x1', tipo: 'dos' }).repetido, true);
  assert.equal(m.e.snapshot().actual.retosPuntos, 10);
  m.e.pantallaRetoCumplido({ id: 'x2', tipo: 'saludo' });
  m.e.pantallaRetoCumplido({ id: 'x3', tipo: 'una' });
  m.e.pantallaRetoCumplido({ id: 'x4', tipo: 'corazon' }); // un cuarto no pasa del tope
  assert.equal(m.e.snapshot().actual.retosPuntos, 30);
  const r = m.e.pantallaFin({ progreso: 1 });
  assert.equal(r.desglose.retos, 30, 'RETOS: 30/30');
});

test('retos: si falla uno suma lo de los otros (20/30) y el resultado coincide', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.pantallaRetoCumplido({ id: 'a', tipo: 'una' });
  m.e.pantallaRetoCumplido({ id: 'c', tipo: 'saludo' });
  const r = m.e.pantallaFin({ progreso: 1 });
  assert.equal(r.desglose.retos, 20);
  assert.equal(r.total, 60); // 40 cancion + 20 retos + 0 publico
});

test('retos: fuera de PLAYING no suman, y el valor de cada reto esta acotado', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  assert.equal(m.e.pantallaRetoCumplido({ id: 'z', tipo: 'una' }).ok, false, 'en CALLING no');
  aEscenario(m, a);
  m.e.pantallaRetoCumplido({ id: 'z', tipo: 'una', puntos: 999 });
  assert.equal(m.e.snapshot().actual.retosPuntos, 10, 'nadie puede inflar un reto');
  assert.equal(m.e.pantallaRetoCumplido({ id: '', tipo: 'una' }).ok, false);
});

test('retos: los puntos viven en el server, no se pierden si la pantalla recarga a mitad', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.pantallaRetoCumplido({ id: 'r1', tipo: 'una' });
  m.e.pantallaConectada({ reconexion: false }); // la pantalla se recargo
  assert.equal(m.e.snapshot().actual.retosPuntos, 10);
});

// ------------------------------------------------------- palabra faltante
const RETO = { id: 'w1', opciones: ['amor', 'noche', 'fuego'], correcta: 1, dur: 8 };

function conReto(m, a) {
  m.e.entrarFila(a);
  aEscenario(m, a);
  assert.equal(m.e.pantallaRetoPalabra(RETO).ok, true);
}

test('palabra: se publican las opciones pero NUNCA la respuesta correcta', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  conReto(m, a);
  const pub = m.e.snapshot().actual.retoPalabra;
  assert.deepEqual(pub.opciones, ['amor', 'noche', 'fuego']);
  assert.equal('correcta' in pub, false);
  assert.equal(JSON.stringify(m.e.snapshot()).includes('"correcta"'), false);
});

test('palabra: el cantante responde bien -> se compara, acierta y suma 10', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  conReto(m, a);
  const r = m.e.responderReto(a, { id: 'w1', opcion: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.acierto, true);
  assert.equal(r.palabra, 'noche');
  assert.equal(m.e.snapshot().actual.retosPuntos, 10);
  assert.equal(m.retosRes.at(-1).acierto, true);
  assert.equal(m.retosRes.at(-1).puntos, 10);
  assert.equal(m.e.snapshot().actual.retoPalabra, null, 'el reto se cierra');
  assert.equal(m.e.responderReto(a, { id: 'w1', opcion: 1 }).ok, false, 'no se puede responder dos veces');
  assert.equal(m.e.snapshot().actual.retosPuntos, 10, 'ni cobrar dos veces');
});

test('palabra: respuesta equivocada -> avisa cual era y no suma', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  conReto(m, a);
  const r = m.e.responderReto(a, { id: 'w1', opcion: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.acierto, false);
  assert.equal(m.retosRes.at(-1).palabra, 'noche');
  assert.equal(m.retosRes.at(-1).puntos, 0);
  assert.equal(m.e.snapshot().actual.retosPuntos, 0);
});

test('palabra: la respuesta con la mano (pantalla) tambien se compara en el server', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  conReto(m, a);
  assert.equal(m.e.pantallaRetoResponder({ id: 'w1', opcion: 1 }).acierto, true);
  assert.equal(m.retosRes.at(-1).quien, 'mano');
  assert.equal(m.e.snapshot().actual.retosPuntos, 10);
});

test('palabra: sin respuesta (ningun gesto cuenta solo) cierra por tiempo y no da puntos', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  conReto(m, a);
  m.avanzar(12_000);
  assert.equal(m.retosRes.at(-1).timeout, true);
  assert.equal(m.retosRes.at(-1).acierto, false);
  assert.equal(m.e.snapshot().actual.retosPuntos, 0);
  assert.equal(m.e.responderReto(a, { id: 'w1', opcion: 1 }).ok, false, 'fuera de tiempo no vale');
});

test('palabra: solo responde el cantante o su copiloto', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const fan = m.persona(2, 'Fan');
  const copi = m.persona(3, 'Copi');
  m.e.entrarFila(a);
  m.e.unirseCopiloto(copi, m.e.yo(a).codigoCopiloto);
  aEscenario(m, a);
  m.e.pantallaRetoPalabra(RETO);
  assert.equal(m.e.responderReto(fan, { id: 'w1', opcion: 1 }).ok, false, 'el publico no');
  assert.equal(m.e.responderReto(a, { id: 'otro', opcion: 1 }).ok, false, 'id equivocado');
  assert.equal(m.e.responderReto(a, { id: 'w1', opcion: 9 }).ok, false, 'opcion invalida');
  assert.equal(m.e.responderReto(copi, { id: 'w1', opcion: 1 }).acierto, true, 'el copiloto si');
});

test('palabra: validaciones de lo que manda la pantalla', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  assert.equal(m.e.pantallaRetoPalabra(RETO).ok, false, 'solo mientras se canta');
  aEscenario(m, a);
  assert.equal(m.e.pantallaRetoPalabra({ ...RETO, opciones: ['uno'] }).ok, false);
  assert.equal(m.e.pantallaRetoPalabra({ ...RETO, opciones: ['amor', 'AMOR', 'x'] }).ok, false, 'opciones repetidas');
  assert.equal(m.e.pantallaRetoPalabra({ ...RETO, correcta: 7 }).ok, false);
  assert.equal(m.e.pantallaRetoPalabra(RETO).ok, true);
  assert.equal(m.e.pantallaRetoPalabra({ ...RETO, id: 'w2' }).ok, false, 'uno a la vez');
});

test('palabra: el reto no sobrevive a la performance', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  conReto(m, a);
  m.e.entrarFila(b);
  m.e.pantallaFin({ progreso: 1 });
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.snapshot().actual?.retoPalabra ?? null, null);
});

// -------------------------------------------------------------------- duetos
test('dueto: tocar "Duo" ANTES de elegir cancion se respeta (antes la cancion lo pisaba)', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(b); // B canta; A espera
  m.e.entrarFila(a);
  assert.equal(m.e.elegirModo(a, 'duo').ok, true);
  assert.equal(m.e.yo(a).modo, 'duo');
  m.e.elegirCancion(a, 'a'); // una cancion comun, sin tocar el modo
  assert.equal(m.e.yo(a).modo, 'duo', 'el modo elegido a mano no se pisa');
  assert.equal(m.e.elegirModo(a, 'solo').ok, true);
  assert.equal(m.e.yo(a).modo, 'solo');
});

test('dueto: CUALQUIER cancion se puede cantar solo o a dueto, lo elige la persona', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(b);
  m.e.entrarFila(a);
  for (const cancion of ['a', 'b', 'd']) {
    m.e.elegirCancion(a, cancion);
    assert.equal(m.e.yo(a).modo, 'solo', `${cancion}: sin tocar nada es solo (aunque venga marcada como dueto)`);
    assert.equal(m.e.elegirModo(a, 'duo').ok, true);
    assert.equal(m.e.yo(a).modo, 'duo', `${cancion}: se puede elegir dueto`);
    m.e.elegirModo(a, 'solo');
  }
  m.e.elegirModo(a, 'duo');
  m.e.elegirCancion(a, 'b'); // cambiar de cancion no cambia la eleccion
  assert.equal(m.e.yo(a).modo, 'duo');
});

test('dueto: llega a PLAYING en modo dueto (celu y mano) y se ve el compañero', () => {
  const m = mundo();
  const a = m.persona(1, 'Ana');
  const c = m.persona(2, 'Compa');
  m.e.entrarFila(a);
  m.e.unirseCopiloto(c, m.e.yo(a).codigoCopiloto);
  m.e.elegirCancion(a, 'a');
  m.e.elegirModo(a, 'duo'); // dueto con una cancion comun (no marcada como dueto)
  assert.equal(m.e.pantallaConfirmar({ cancionId: 'a' }).ok, true); // confirmada con la mano
  assert.equal(m.e.snapshot().actual.modo, 'duo');
  m.avanzar(m.e.config.COUNTDOWN_S * 1000);
  assert.equal(m.e.etapa, ETAPAS.PLAYING);
  assert.equal(m.e.snapshot().actual.modo, 'duo');
  assert.equal(m.e.snapshot().actual.copiloto, 'Compa', 'la pantalla sabe quien es la VOZ 2');
});

test('dueto: el modo se puede cambiar en CALLING pero no una vez que arranco', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  assert.equal(m.e.elegirModo(a, 'duo').ok, true);
  assert.equal(m.e.snapshot().actual.modo, 'duo');
  m.e.elegirCancion(a, 'a');
  m.e.pantallaConfirmar({ cancionId: 'a' });
  assert.equal(m.e.elegirModo(a, 'solo').ok, false, 'ya empezo');
  assert.equal(m.e.elegirModo(a, 'trio').ok, false, 'modo invalido');
});

test('dueto: tras reiniciar el server el modo elegido se conserva', () => {
  const m = mundo();
  const b = m.persona(2, 'B');
  m.e.entrarFila(b);
  m.e.hola({ token: tk(7), nombre: 'Yaz', intencion: { enFila: true, cancionId: 'a', modo: 'duo' } });
  assert.equal(m.e.yo(tk(7)).modo, 'duo');
});

test('dueto: se puede elegir ANTES de anotarse y llega a la pantalla como dueto', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  assert.equal(m.e.entrarFila(a, 'A', 'duo').ok, true); // solo/duo viaja con "Quiero cantar"
  assert.equal(m.e.yo(a).modo, 'duo');
  assert.equal(m.e.snapshot().actual.modo, 'duo', 'si pasa ya, el escenario lo sabe');
  m.e.salirFila(a);
  assert.equal(m.e.entrarFila(a, 'A').ok, true, 'sin elegir nada recuerda la eleccion anterior');
  assert.equal(m.e.yo(a).modo, 'duo');
  assert.equal(m.e.entrarFila(a, 'A', 'trio').ok, true, 'un modo invalido se ignora');
});
