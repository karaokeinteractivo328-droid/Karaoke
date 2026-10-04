import test from 'node:test';
import assert from 'node:assert/strict';
import { crearEscenario, ETAPAS, ESTADOS_P } from '../escenario.js';

const CANCIONES = [
  { id: 'a', titulo: 'Cancion A', artista: 'Artista A', duracion: 100 },
  { id: 'b', titulo: 'Cancion B', artista: 'Artista B', duracion: 120 },
  { id: 'c', titulo: 'Cancion C', artista: 'Artista C', duracion: 90 },
];

// token de 20 chars por persona
const tk = (n) => `token-${n}`.padEnd(20, 'x');

function mundo(config = {}) {
  let t = 1_000_000;
  const resultados = [];
  let cambios = 0;
  const e = crearEscenario({
    canciones: CANCIONES,
    ahora: () => t,
    onCambio: () => { cambios++; },
    onResultado: (r) => resultados.push(r),
    config,
  });
  const avanzar = (ms) => {
    // avanza el reloj de a 1s llamando al watchdog, como hace el server
    let resto = ms;
    while (resto > 0) {
      const paso = Math.min(1000, resto);
      t += paso;
      resto -= paso;
      e.tick();
    }
  };
  const persona = (n, nombre = `P${n}`) => {
    const token = tk(n);
    e.hola({ token, nombre });
    return token;
  };
  return { e, avanzar, persona, resultados, get cambios() { return cambios; }, get t() { return t; } };
}

// lleva a `token` de CALLING a PLAYING
function aEscenario(m, token, cancionId = 'a') {
  m.e.elegirCancion(token, cancionId, 'solo');
  assert.equal(m.e.listo(token).ok, true);
  m.avanzar(m.e.config.COUNTDOWN_S * 1000);
  assert.equal(m.e.etapa, ETAPAS.PLAYING);
}

test('caso 1: llego y nadie canta -> soy el primero, elijo, canto, resultado, vuelve a STANDBY', () => {
  const m = mundo();
  assert.equal(m.e.etapa, ETAPAS.STANDBY);
  const iara = m.persona(1, 'Iara');
  assert.equal(m.e.entrarFila(iara).ok, true);
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  assert.equal(m.e.snapshot().actual.nombre, 'Iara');
  assert.equal(m.e.snapshot().actual.fase, 'eligiendo');
  assert.equal(m.e.listo(iara).ok, false, 'sin cancion no puede empezar');
  m.e.elegirCancion(iara, 'a', 'solo');
  assert.equal(m.e.snapshot().actual.fase, 'esperando-listo');
  assert.equal(m.e.listo(iara).ok, true);
  assert.equal(m.e.etapa, ETAPAS.COUNTDOWN);
  m.avanzar(3000);
  assert.equal(m.e.etapa, ETAPAS.PLAYING);
  m.e.pantallaFin({ progreso: 1 });
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  assert.equal(m.resultados.length, 1);
  assert.equal(m.e.yo(iara).estado, ESTADOS_P.DONE);
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.etapa, ETAPAS.STANDBY);
});

test('caso 2: llego mientras alguien canta -> entro como publico y me puedo sumar a la fila', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  const b = m.persona(2, 'B');
  assert.equal(m.e.yo(b).estado, ESTADOS_P.PUBLIC);
  assert.equal(m.e.snapshot().actual.nombre, 'A');
  assert.equal(m.e.etapa, ETAPAS.PLAYING, 'no interrumpe');
  assert.equal(m.e.entrarFila(b).ok, true);
  assert.equal(m.e.yo(b).posicion, 1);
  assert.equal(m.e.snapshot().siguiente.nombre, 'B');
  assert.equal(m.e.etapa, ETAPAS.PLAYING, 'sigue el cantante actual');
});

test('caso 3: quiero ser el proximo -> elijo cancion ya y queda preparada', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  const b = m.persona(2, 'B');
  m.e.entrarFila(b);
  assert.equal(m.e.elegirCancion(b, 'c', 'duo').ok, true);
  assert.equal(m.e.snapshot().fila[0].cancion.titulo, 'Cancion C');
  m.e.pantallaFin({ progreso: 1 });
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.etapa, ETAPAS.CALLING, 'pasa solo al siguiente');
  assert.equal(m.e.snapshot().actual.nombre, 'B');
  assert.equal(m.e.snapshot().actual.cancion.id, 'c');
  assert.equal(m.e.snapshot().actual.modo, 'duo');
  assert.equal(m.e.listo(b).ok, true, 'ya tenia la cancion: solo confirma');
});

test('caso 4: el primero pierde conexion -> gracia, si vuelve retoma, si no se libera', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(a);
  m.e.entrarFila(b);
  assert.equal(m.e.snapshot().actual.nombre, 'A');
  m.e.desconectar(a);
  m.avanzar(20_000);
  assert.equal(m.e.snapshot().actual.nombre, 'A', 'todavia en gracia');
  m.e.hola({ token: a, nombre: 'A' }); // vuelve a tiempo
  m.avanzar(20_000);
  assert.equal(m.e.snapshot().actual.nombre, 'A', 'retoma donde estaba');
  assert.equal(m.e.yo(a).estado, ESTADOS_P.CALLED);

  m.e.desconectar(a); // ahora no vuelve
  m.avanzar(m.e.config.CALLED_DESCONEXION_MS + 1000);
  assert.equal(m.e.snapshot().actual.nombre, 'B', 'se libero y paso el siguiente');
  assert.equal(m.e.yo(a).estado, ESTADOS_P.PUBLIC);
  assert.match(m.e.yo(a).mensaje, /perdiste tu turno/);
});

test('caso 5: el cantante abandona a mitad -> resultado parcial, no se guarda, pasa al siguiente', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.entrarFila(b);
  m.avanzar(30_000);
  m.e.desconectar(a);
  m.avanzar(m.e.config.CANTANTE_DESCONEXION_MS + 1000);
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  const res = m.e.snapshot().actual.resultado;
  assert.equal(res.interrumpida, true);
  assert.ok(res.total > 0 && res.total < 40, 'puntaje parcial');
  assert.equal(m.resultados.length, 0, 'lo interrumpido no va al leaderboard');
  m.avanzar(m.e.config.RESULT_INTERRUMPIDO_MS);
  assert.equal(m.e.snapshot().actual.nombre, 'B', 'pasa automaticamente al siguiente');
});

test('caso 5b: el cantante toca "terminar"', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.avanzar(10_000);
  assert.equal(m.e.terminar(tk(99)).ok, false, 'otro no puede terminar mi cancion');
  assert.equal(m.e.terminar(a).ok, true);
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  assert.equal(m.e.snapshot().actual.resultado.interrumpida, true);
});

test('caso 6: dos personas piden el turno -> manda el orden de llegada y entrar es idempotente', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  const c = m.persona(3, 'C');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.entrarFila(b);
  m.e.entrarFila(c);
  m.e.entrarFila(b); // doble toque
  m.e.entrarFila(b);
  const s = m.e.snapshot();
  assert.equal(s.filaTotal, 2);
  assert.deepEqual(s.fila.map((x) => x.nombre), ['B', 'C']);
  assert.equal(m.e.yo(b).posicion, 1);
  assert.equal(m.e.yo(c).posicion, 2);
});

test('caso 7: nadie interactua -> el llamado se saltea y todo vuelve a STANDBY', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  m.avanzar(m.e.config.LLAMADO_SIN_CANCION_MS + 1000);
  assert.equal(m.e.etapa, ETAPAS.STANDBY);
  assert.equal(m.e.yo(a).estado, ESTADOS_P.PUBLIC);
});

test('caso 8: hay gente esperando y nadie canta -> nunca STANDBY, pasa al siguiente', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  const c = m.persona(3, 'C');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.entrarFila(b);
  m.e.entrarFila(c);
  m.e.pantallaFin({ progreso: 1 });
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  assert.equal(m.e.snapshot().actual.nombre, 'B');
  // B se va sin hacer nada: sigue C, no STANDBY
  m.avanzar(m.e.config.LLAMADO_SIN_CANCION_MS + 1000);
  assert.equal(m.e.snapshot().actual.nombre, 'C');
  assert.notEqual(m.e.etapa, ETAPAS.STANDBY);
});

test('ciclo continuo: A canta, B ya preparada, C se suma, D llega durante la de B', () => {
  const m = mundo();
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => m.persona(n, `P${n}`));
  m.e.entrarFila(a);
  m.e.elegirCancion(a, 'a');
  m.e.listo(a);
  m.avanzar(3000);
  m.e.entrarFila(b);
  m.e.elegirCancion(b, 'b');
  m.e.entrarFila(c);
  m.e.elegirCancion(c, 'c');
  m.e.pantallaFin({ progreso: 1 });
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.snapshot().actual.nombre, 'P2');
  m.e.listo(b);
  m.avanzar(3000);
  m.e.entrarFila(d);
  m.e.pantallaFin({ progreso: 1 });
  m.avanzar(m.e.config.RESULT_MS);
  assert.equal(m.e.snapshot().actual.nombre, 'P3');
  assert.equal(m.e.snapshot().siguiente.nombre, 'P4');
});

test('reacciones: cuentan solo en PLAYING, tope por persona, rate limit, y suman al puntaje', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const f = m.persona(2, 'Fan');
  m.e.entrarFila(a);
  m.e.elegirCancion(a, 'a');
  assert.equal(m.e.reaccionar(f, 'corazon').contada, false, 'en CALLING no cuenta');
  m.e.listo(a);
  m.avanzar(3000);
  let contadas = 0;
  for (let i = 0; i < 30; i++) {
    m.avanzar(300); // supera el rate limit de 250ms
    if (m.e.reaccionar(f, 'fuego').contada) contadas++;
  }
  assert.equal(contadas, m.e.config.REACC_MAX_POR_PERSONA, 'tope por persona');
  assert.equal(m.e.reaccionar(f, 'fuego').limitada, true, 'rate limit: sin esperar no pasa');
  assert.equal(m.e.reaccionar(a, 'corazon').contada, false, 'el cantante no se cuenta a si mismo');
  m.e.pantallaRetos(18);
  const r = m.e.pantallaFin({ progreso: 1 });
  assert.equal(r.desglose.cancion, 40);
  assert.equal(r.desglose.retos, 18);
  assert.equal(r.desglose.publico, 30, '15 fuegos * 1.5 = 22.5 ponderadas >= 20 -> tope 30');
  assert.equal(r.total, 88);
  assert.equal(r.reacciones.fuego, 15);
});

test('copiloto: un solo lugar por cantante, sin permisos de control', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  const codigo = m.e.yo(a).codigoCopiloto;
  assert.match(codigo, /^[A-Z2-9]{4}$/);
  const x = m.persona(2, 'X');
  const y = m.persona(3, 'Y');
  assert.equal(m.e.unirseCopiloto(x, 'ZZZZ').ok, false);
  assert.equal(m.e.unirseCopiloto(x, codigo).ok, true);
  assert.equal(m.e.unirseCopiloto(y, codigo).ok, false, 'ya tiene copiloto');
  assert.equal(m.e.yo(x).copilotoDe.nombre, 'A');
  assert.equal(m.e.yo(a).copiloto.nombre, 'X');
  assert.equal(m.e.elegirCancion(x, 'b').ok, false, 'el copiloto no elige la cancion del cantante');
  assert.equal(m.e.listo(x).ok, false, 'ni puede iniciar');
  assert.equal(m.e.terminar(x).ok, false, 'ni interrumpir');
  m.e.elegirCancion(a, 'a');
  m.e.listo(a);
  m.avanzar(3000);
  m.e.pantallaFin({ progreso: 1 });
  assert.equal(m.e.yo(x).copilotoDe, null, 'al terminar se libera');
});

test('server reiniciado: el celu se re-anota solo con su cancion guardada', () => {
  const m = mundo();
  const token = tk(7);
  const r = m.e.hola({ token, nombre: 'Rocio', intencion: { enFila: true, cancionId: 'b', modo: 'duo' } });
  assert.equal(r.ok, true);
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  assert.equal(m.e.snapshot().actual.cancion.id, 'b');
  assert.equal(m.e.snapshot().actual.modo, 'duo');
});

test('token invalido y sala llena', () => {
  const m = mundo({ FILA_MAX: 2 });
  assert.equal(m.e.hola({ token: 'corto' }).ok, false);
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => m.persona(n));
  m.e.entrarFila(a);
  assert.equal(m.e.entrarFila(b).ok, true);
  assert.equal(m.e.entrarFila(c).ok, true);
  assert.equal(m.e.entrarFila(d).ok, false, 'fila llena');
});

test('recuperacion: pantalla recargada en plena performance -> se cierra y sigue el siguiente', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.entrarFila(b);
  m.e.pantallaConectada({ camara: true, mic: true, audio: true });
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  assert.equal(m.e.snapshot().actual.resultado.interrumpida, true);
  m.avanzar(m.e.config.RESULT_INTERRUMPIDO_MS);
  assert.equal(m.e.snapshot().actual.nombre, 'B');
});

test('recuperacion: pantalla caida y nunca vuelve -> el watchdog cierra', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.pantallaConectada({});
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.pantallaDesconectada();
  m.avanzar(m.e.config.PANTALLA_DESCONEXION_MS + 1000);
  assert.equal(m.e.etapa, ETAPAS.RESULT);
});

test('recuperacion: la pantalla se cuelga y no manda "fin" -> watchdog fuerza el resultado', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.pantallaConectada({ camara: false });
  m.e.entrarFila(a);
  aEscenario(m, a, 'c'); // 90s
  m.avanzar(90_000 + m.e.config.PLAYING_EXTRA_MS + 2000);
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  assert.equal(m.e.snapshot().actual.resultado.forzado, true);
  assert.equal(m.resultados.length, 0);
});

test('recuperacion: camara sana y nadie en cuadro -> abandono; sin camara no se usa este criterio', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.pantallaConectada({ camara: true });
  m.e.entrarFila(a);
  aEscenario(m, a, 'b'); // 120s
  for (let i = 0; i < 60; i++) {
    m.e.pantallaPresencia(false); // la camara reporta "nadie"
    m.avanzar(1000);
    if (m.e.etapa === ETAPAS.RESULT) break;
  }
  assert.equal(m.e.etapa, ETAPAS.RESULT);
  assert.match(m.e.snapshot().actual.resultado.motivo, /cámara/);

  const m2 = mundo();
  const a2 = m2.persona(1, 'A');
  m2.e.pantallaConectada({ camara: false });
  m2.e.entrarFila(a2);
  aEscenario(m2, a2, 'b');
  m2.avanzar(100_000);
  assert.equal(m2.e.etapa, ETAPAS.PLAYING, 'sin camara no se abandona por falta de persona');
});

test('autostart por camara: el llamado con cancion arranca solo si la camara lo ve parado', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.pantallaConectada({ camara: true });
  m.e.entrarFila(a);
  m.e.elegirCancion(a, 'a');
  for (let i = 0; i < 12; i++) {
    m.e.pantallaPresencia(true);
    m.avanzar(1000);
  }
  assert.ok([ETAPAS.COUNTDOWN, ETAPAS.PLAYING].includes(m.e.etapa), 'arranco solo');

  const m2 = mundo();
  const b = m2.persona(1, 'B');
  m2.e.pantallaConectada({ camara: false });
  m2.e.entrarFila(b);
  m2.e.elegirCancion(b, 'a');
  for (let i = 0; i < 12; i++) { m2.e.pantallaPresencia(true); m2.avanzar(1000); }
  assert.equal(m2.e.etapa, ETAPAS.CALLING, 'sin camara solo arranca con LISTO del celu');
});

test('reinicio seguro: cierra la performance y deja el sistema consistente', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.entrarFila(b);
  m.e.reinicioSeguro();
  assert.equal(m.e.snapshot().actual.nombre, 'B');
  assert.equal(m.e.etapa, ETAPAS.CALLING);
  m.e.reinicioSeguro();
  assert.equal(m.e.etapa, ETAPAS.STANDBY);
  assert.equal(m.e.snapshot().filaTotal, 0);
});

test('ETA: crece con la posicion y se calcula con la duracion de cada cancion', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  const b = m.persona(2, 'B');
  const c = m.persona(3, 'C');
  m.e.entrarFila(a);
  aEscenario(m, a, 'a'); // 100s
  m.e.entrarFila(b);
  m.e.elegirCancion(b, 'b'); // 120s
  m.e.entrarFila(c);
  const etas = m.e.snapshot().fila.map((x) => x.etaSeg);
  assert.ok(etas[0] > 0 && etas[1] > etas[0]);
  assert.ok(etas[1] - etas[0] >= 120, 'C espera al menos lo que dura la de B');
  m.avanzar(60_000);
  assert.ok(m.e.snapshot().fila[0].etaSeg < etas[0], 'baja con el tiempo');
});

test('el token del video no viaja en el snapshot publico', () => {
  const m = mundo();
  const a = m.persona(1, 'A');
  m.e.entrarFila(a);
  aEscenario(m, a);
  m.e.pantallaFin({ progreso: 1 });
  assert.equal(JSON.stringify(m.e.snapshot()).includes('videoToken'), false);
  assert.match(m.e.privadoPantalla().videoToken, /^[0-9a-f]{32}$/);
  assert.match(m.e.yo(a).videoToken, /^[0-9a-f]{32}$/);
  assert.equal(m.e.yo(m.persona(2)).videoToken, null);
});
