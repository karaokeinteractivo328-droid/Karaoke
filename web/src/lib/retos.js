// Retos con las manos durante la cancion.
//
// - PLANIFICADOS: cada performance tiene un plan de RETOS_POR_CANCION retos,
//   cada uno atado a un instante de la cancion (en segundos de AUDIO, el mismo
//   reloj que usa la letra) y alineado al comienzo de una linea de letra. No
//   aparecen al azar ni dependen de un temporizador propio que se desfase.
// - VALIDADOS: un gesto cuenta solo si se SOSTIENE `hold` ms (con 150 ms de
//   tolerancia al parpadeo del tracker). Un frame suelto nunca suma.
// - UNA SOLA RECOMPENSA por reto: al cumplirse, el reto termina y no vuelve a
//   sumar aunque la persona mantenga el gesto. Los puntos los registra el server
//   (onCumplido), no esta pantalla.
// - El reto de la PALABRA no se resuelve con un gesto: se contesta eligiendo una
//   opcion (mano + pellizco, o desde el celu) y el server compara la respuesta.
//
// Consume `datos` de manos.js: { manos, unaArriba, dosArriba, saludo, corazon, ... }.

export const PUNTOS_RETO = 10;
export const RETOS_POR_CANCION = 3; // 3 x 10 = 30, el tope de retos del puntaje
const TOLERANCIA_PARPADEO = 0.15; // s sin el gesto antes de reiniciar la espera

// --- poses de la mano (sobre los 21 landmarks) ---
const dedoArriba = (p, tip, pip) => p[tip].y < p[pip].y - 0.02;
const esPuño = (p) => ![[8, 6], [12, 10], [16, 14], [20, 18]].some(([t, i]) => dedoArriba(p, t, i));
const esPaz = (p) =>
  dedoArriba(p, 8, 6) && dedoArriba(p, 12, 10) && !dedoArriba(p, 16, 14) && !dedoArriba(p, 20, 18);
const señalando = (p) =>
  dedoArriba(p, 8, 6) && !dedoArriba(p, 12, 10) && !dedoArriba(p, 16, 14) && !dedoArriba(p, 20, 18);

// hold = ms que hay que sostener el gesto; dur = segundos que dura el reto
export const RETOS = {
  una: { clave: 'una', icono: '✋', texto: '¡Levantá una mano!', dur: 7, hold: 400, ok: (d) => d.unaArriba },
  dos: { clave: 'dos', icono: '🙌', texto: '¡Levantá las dos manos!', dur: 7, hold: 400, ok: (d) => d.dosArriba },
  saludo: { clave: 'saludo', icono: '👋', texto: '¡Saludá!', dur: 7, hold: 0, ok: (d) => d.saludo }, // el saludo ya es un movimiento sostenido
  corazon: { clave: 'corazon', icono: '💖', texto: '¡Hacé un corazón!', dur: 8, hold: 300, ok: (d) => d.corazon },
  puno: {
    clave: 'puno', icono: '✊', texto: '¡Puño bien alto!', dur: 7, hold: 400,
    ok: (d) => d.manos.some((m) => m.arriba && esPuño(m.puntos)),
  },
  paz: { clave: 'paz', icono: '✌️', texto: '¡Seña de paz!', dur: 7, hold: 400, ok: (d) => d.manos.some((m) => esPaz(m.puntos)) },
  cielo: {
    clave: 'cielo', icono: '👆', texto: '¡Señalá al cielo!', dur: 7, hold: 400,
    ok: (d) => d.manos.some((m) => m.arriba && señalando(m.puntos)),
  },
};
export const RETO_PALABRA = { clave: 'palabra', icono: '🫥', texto: '¡Completá la palabra!', tipo: 'palabra', dur: 10 };

const GESTOS = Object.keys(RETOS);
// los dos primeros retos tienen que ser faciles de entender de un vistazo
const FACILES = ['una', 'dos', 'saludo', 'corazon'];

function mezclar(a, azar) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Plan de la performance: [{ at, tipo, estado }] ordenado por `at` (s de audio).
//  duracion : segundos de la cancion
//  inicios  : segundos (de audio) en que arranca cada linea de letra
export function armarPlan({ duracion, inicios = [], conPalabra = true, azar = Math.random, cantidad = RETOS_POR_CANCION }) {
  const dur = Math.max(30, Number(duracion) || 0);
  // reparto en la parte "util" de la cancion: ni al arranque ni sobre el final
  const desde = Math.max(14, dur * 0.18);
  const hasta = dur - Math.max(20, dur * 0.12);
  const lineas = [...inicios].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const tipos = mezclar(FACILES, azar).slice(0, cantidad);
  if (conPalabra) tipos[Math.floor(azar() * cantidad)] = 'palabra';
  // completa con otros gestos si hacia falta (ej. sin palabra)
  for (let i = 0; i < cantidad; i++) {
    if (!tipos[i]) tipos[i] = mezclar(GESTOS.filter((g) => !tipos.includes(g)), azar)[0];
  }
  const plan = [];
  for (let k = 0; k < cantidad; k++) {
    let at = desde + ((hasta - desde) * (k + 0.5)) / cantidad;
    // alinear al comienzo de la linea de letra que arranca justo despues
    const linea = lineas.find((t) => t >= at - 1 && t < at + 12);
    if (linea !== undefined) at = linea;
    plan.push({ at, tipo: tipos[k], estado: 'pendiente' });
  }
  return plan.sort((a, b) => a.at - b.at);
}

// callbacks:
//   onCartel(cartel|null)          cartel visible (se llama en cada tick mientras hay reto)
//   onCumplido({id,tipo,puntos})   un gesto se valido: el server suma los puntos
//   onResultado({ok,puntos,tipo,palabra?,motivo?})   feedback para la persona
//   onPalabra({t}) -> {id,hasta,opciones}|null   la pantalla prepara el reto de la palabra
//   onPalabraFin({id})             se acabo el tiempo sin respuesta
export function crearRetos({ onCartel, onCumplido, onResultado, onPalabra, onPalabraFin, azar = Math.random } = {}) {
  let plan = [];
  let activo = null; // { id, item, reto, hasta, okDesde, ultimoOk, opciones? }
  let seq = 0;
  let puntaje = 0; // solo informativo: los puntos "de verdad" los lleva el server

  function reset() {
    activo = null;
    plan = [];
    puntaje = 0;
    onCartel?.(null);
  }

  function planificar(opts) {
    reset();
    plan = armarPlan({ azar, ...opts });
    return plan;
  }

  function cerrar(item, estado) {
    item.estado = estado;
    activo = null;
    onCartel?.(null);
  }

  function cartel(t) {
    const r = activo.reto;
    return {
      id: activo.id,
      clave: r.clave,
      tipo: r.tipo || 'gesto',
      icono: r.icono,
      texto: r.texto,
      puntos: PUNTOS_RETO,
      opciones: activo.opciones || null,
      resto: Math.max(0, Math.min(1, (activo.hasta - t) / (activo.hasta - activo.desde))),
      sostener: activo.hold && activo.okDesde ? Math.min(1, ((t - activo.okDesde) * 1000) / activo.hold) : 0,
    };
  }

  // t = segundos de AUDIO (el mismo reloj de la letra). hayManos = hay camara y
  // tracking funcionando (sin eso los retos de gestos se saltean).
  function tick(t, datos, { hayManos = true } = {}) {
    if (activo) {
      const r = activo.reto;
      if (r.tipo === 'palabra') {
        // lo cierra el server (resolverPalabra); aca solo el limite de seguridad
        if (t > activo.hasta + 2) {
          onPalabraFin?.({ id: activo.id });
          onResultado?.({ ok: false, puntos: 0, tipo: 'palabra', motivo: 'tiempo' });
          cerrar(activo.item, 'perdido');
          return;
        }
        onCartel?.(cartel(t));
        return;
      }
      const cumple = !!(datos && r.ok(datos));
      if (cumple) {
        activo.okDesde ||= t;
        activo.ultimoOk = t;
        if ((t - activo.okDesde) * 1000 >= r.hold) {
          // validado: una sola vez, el reto termina y no vuelve a sumar
          puntaje += PUNTOS_RETO;
          const id = activo.id;
          const item = activo.item;
          onCumplido?.({ id, tipo: r.clave, puntos: PUNTOS_RETO });
          onResultado?.({ ok: true, puntos: PUNTOS_RETO, tipo: r.clave });
          cerrar(item, 'cumplido');
          return;
        }
      } else if (activo.okDesde && t - activo.ultimoOk > TOLERANCIA_PARPADEO) {
        activo.okDesde = 0; // lo solto: la espera empieza de nuevo
      }
      if (t >= activo.hasta) {
        onResultado?.({ ok: false, puntos: 0, tipo: r.clave, motivo: 'tiempo' });
        cerrar(activo.item, 'perdido');
        return;
      }
      onCartel?.(cartel(t));
      return;
    }

    const item = plan.find((p) => p.estado === 'pendiente' && t >= p.at);
    if (!item) return;
    // si se paso mucho (pausa, carga lenta) ese momento ya no tiene sentido
    if (t > item.at + 12) { item.estado = 'salteado'; return; }

    if (item.tipo === 'palabra') {
      const p = onPalabra?.({ t });
      if (!p) return; // todavia no hay una palabra con tiempo suficiente: se reintenta
      activo = { id: p.id, item, reto: RETO_PALABRA, desde: t, hasta: p.hasta, opciones: p.opciones };
      item.estado = 'activo';
      onCartel?.(cartel(t));
      return;
    }
    const reto = RETOS[item.tipo];
    if (!hayManos) { item.estado = 'salteado'; return; } // sin camara no se pueden pedir gestos
    activo = { id: `r${++seq}-${Math.round(t)}`, item, reto, desde: t, hasta: t + reto.dur, okDesde: 0, ultimoOk: 0, hold: reto.hold };
    item.estado = 'activo';
    onCartel?.(cartel(t));
  }

  // el server resolvio el reto de la palabra (acierto, error o tiempo)
  function resolverPalabra({ id, acierto, timeout, palabra, puntos }) {
    if (!activo || activo.reto.tipo !== 'palabra' || activo.id !== id) return false;
    if (acierto) puntaje += puntos ?? PUNTOS_RETO;
    onResultado?.({ ok: !!acierto, puntos: acierto ? (puntos ?? PUNTOS_RETO) : 0, tipo: 'palabra', palabra, motivo: timeout ? 'tiempo' : undefined });
    cerrar(activo.item, acierto ? 'cumplido' : 'perdido');
    return true;
  }

  // la pantalla no pudo armar/enviar el reto de la palabra
  function cancelarPalabra(id) {
    if (activo?.reto.tipo === 'palabra' && activo.id === id) cerrar(activo.item, 'salteado');
  }

  return {
    reset,
    planificar,
    tick,
    resolverPalabra,
    cancelarPalabra,
    get plan() { return plan; },
    get activo() { return activo; },
    get puntaje() { return puntaje; },
  };
}
