// GESTOS: "que esta haciendo la persona con las manos".
//
// Consume TRACKS estables de seguimiento.js (no detecciones crudas): cada mano
// tiene id, posicion suavizada, lado, y puede estar `perdida` unos ms. Aca solo
// se interpreta; no se detecta ni se filtra nada.
//
//  Siempre:
//    arriba (0|1|2)  cuantas manos estan por encima del menton, ESTABLE
//    saludo          movimiento horizontal repetido de una mano (con cooldown)
//    corazon         dos manos formando un corazon
//    pellizco        pulgar + indice juntos
//  Las canciones NO se eligen con la mano: eso es del celu. Los gestos son solo para los
//  retos, la interaccion y el puntaje.
//  Durante el reto de la palabra (opciones en pantalla; no es un menu de canciones):
//    mano a izquierda / centro / derecha + pellizco sostenido -> onOpcion(i)

import { centroPalma } from './seguimiento.js';

const UMBRAL_PELLIZCO = 0.65; // dist pulgar-indice / tamano de la mano (permisivo)
const MS_CONFIRMAR_OPCION = 700;
const MS_TOLERANCIA_PELLIZCO = 250; // el tracker parpadea: no se reinicia el progreso por eso
const MS_ESTABLE = 220; // la cantidad de manos tiene que mantenerse esto antes de contar
const MS_ARRIBA_ESTABLE = 200; // manos arriba: igual, no cambia por un frame
const SEPARACION_DOS_MANOS = 0.12; // dos "manos" mas cerca que esto son una sola mal detectada
const MS_LATCH_SALUDO = 900; // el saludo queda "activo" un rato (los retos leen a otro ritmo)
const MS_COOLDOWN_SALUDO = 2500;
const MS_LATCH_CORAZON = 500;

// --- referencias --------------------------------------------------------------

// Altura (0 arriba .. 1 abajo) por encima de la cual una mano esta "arriba":
// el menton si vemos la cara, la mitad del cuadro si no.
export function alturaMano(cara) {
  return cara ? Math.min(0.75, Math.max(0.3, cara.cy + cara.h * 0.55)) : 0.5;
}

// Histeresis: para pasar a "arriba" tiene que cruzar la linea, para dejar de
// estarlo tiene que bajar un poco mas (una mano en el borde no parpadea).
export function estaArriba(centroY, ref, estabaArriba) {
  return estabaArriba ? centroY < ref + 0.05 : centroY < ref;
}

// Saludo = la mano barre de un lado a otro y vuelve, de forma repetida.
// `hist` = [{ t, x, y }] del centro de la palma (suavizado). Una mano quieta
// (jitter < `amp`) nunca cuenta; una mano que solo se mueve de un lugar a otro
// tampoco: hace falta ir y venir.
export function esSaludo(hist, ahora, { ventanaMs = 1100, amp = 0.025, minSpan = 0.05, vMin = 0.12 } = {}) {
  const pts = hist.filter((h) => ahora - h.t <= ventanaMs);
  if (pts.length < 6) return false;
  let dir = 0;
  let ext = pts[0].x;
  let rev = 0;
  let min = ext;
  let max = ext;
  let camino = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x;
    if (i) camino += Math.abs(x - pts[i - 1].x);
    min = Math.min(min, x);
    max = Math.max(max, x);
    if (dir === 0) {
      if (Math.abs(x - ext) >= amp) { dir = x > ext ? 1 : -1; ext = x; }
    } else if (dir > 0) {
      if (x > ext) ext = x;
      else if (ext - x >= amp) { rev++; dir = -1; ext = x; }
    } else if (x < ext) ext = x;
    else if (x - ext >= amp) { rev++; dir = 1; ext = x; }
  }
  const span = max - min;
  const seg = Math.max(0.001, (pts[pts.length - 1].t - pts[0].t) / 1000);
  if (camino / seg < vMin) return false;
  return (rev >= 2 && span >= minSpan) || (rev >= 1 && span >= 0.1);
}

export function crearGestos({ getOpciones = () => 0, onOpcion, onManos }) {
  // estabilidad de la cantidad de manos
  let pend = -1;
  let pendDesde = 0;
  let estable = 0;
  // manos arriba
  const arribaPorId = new Map();
  let arribaPend = -1;
  let arribaPendDesde = 0;
  let arribaEstable = 0;
  // saludo / corazon (con latch)
  let saludoHasta = 0;
  let saludoCooldownHasta = 0;
  let corazonHasta = 0;
  // pellizco
  let pinchStart = 0;
  let pinchProgress = 0;
  let pinchPerdidoDesde = 0;
  let confirmEnviado = false;
  let modoPrevio = '';
  let opcionPinch = -1;

  function contarEstable(n, ahora) {
    if (n !== pend) { pend = n; pendDesde = ahora; }
    if (ahora - pendDesde >= MS_ESTABLE) estable = n;
    return estable;
  }

  function contarArribaEstable(n, ahora) {
    if (n !== arribaPend) { arribaPend = n; arribaPendDesde = ahora; }
    if (ahora - arribaPendDesde >= MS_ARRIBA_ESTABLE) arribaEstable = n;
    return arribaEstable;
  }

  function reiniciarPellizco() {
    pinchStart = 0;
    pinchProgress = 0;
    pinchPerdidoDesde = 0;
    confirmEnviado = false;
    opcionPinch = -1;
  }

  // manos: tracks de seguimiento.js ; cara: { cx, cy, w, h } | null
  return function procesar({ manos: tracks = [], cara = null, ts }) {
    const ahora = ts ?? performance.now();
    const visibles = tracks.filter((t) => !t.perdida);
    const n = contarEstable(visibles.length, ahora);
    const nOpciones = getOpciones() || 0;
    const modo = nOpciones ? 'opciones' : '';
    if (modo !== modoPrevio) {
      reiniciarPellizco();
      modoPrevio = modo;
    }

    // ---- mano arriba (por mano, con histeresis) ----
    const ref = alturaMano(cara);
    const vivos = new Set(tracks.map((t) => t.id));
    for (const id of [...arribaPorId.keys()]) if (!vivos.has(id)) arribaPorId.delete(id);
    for (const t of tracks) arribaPorId.set(t.id, estaArriba(t.centro.y, ref, !!arribaPorId.get(t.id)));
    // las manos perdidas un instante todavia cuentan (la gracia del tracking)
    const arribaTracks = tracks.filter((t) => arribaPorId.get(t.id));
    // una misma mano detectada dos veces no son "dos manos"
    let arribaCruda = 0;
    for (const t of arribaTracks) {
      if (arribaTracks.slice(0, arribaTracks.indexOf(t)).every((o) => Math.abs(o.centro.x - t.centro.x) >= SEPARACION_DOS_MANOS)) arribaCruda++;
    }
    // con 3+ manos (cantante + copiloto) "dos manos" es una por lado
    const conteo = tracks.length >= 3
      ? Number(arribaTracks.some((t) => t.lado === 'izq')) + Number(arribaTracks.some((t) => t.lado === 'der'))
      : arribaCruda;
    const arriba = contarArribaEstable(Math.min(2, conteo), ahora);

    // ---- saludo: movimiento horizontal repetido, con cooldown ----
    if (ahora >= saludoCooldownHasta) {
      const saluda = visibles.some((t) => t.centro.y < ref + 0.25 && esSaludo(t.hist, ahora));
      if (saluda) {
        saludoHasta = ahora + MS_LATCH_SALUDO;
        saludoCooldownHasta = ahora + MS_COOLDOWN_SALUDO;
      }
    }
    const saludo = ahora < saludoHasta;

    // ---- corazon: pulgares e indices de las dos manos juntos ----
    if (visibles.length >= 2 && esCorazon(visibles[0].puntos, visibles[1].puntos)) corazonHasta = ahora + MS_LATCH_CORAZON;
    const corazon = ahora < corazonHasta;

    // lo que ven los demas modulos: manos visibles con su lado y si estan arriba
    const manosOut = visibles.map((t) => ({ id: t.id, puntos: t.puntos, lado: t.lado, arriba: !!arribaPorId.get(t.id) }));
    const base = {
      manos: manosOut,
      manosIzq: manosOut.filter((m) => m.lado === 'izq'),
      manosDer: manosOut.filter((m) => m.lado === 'der'),
      cantidadManos: n,
      arriba,
      unaArriba: arriba >= 1,
      dosArriba: arriba >= 2,
      saludo,
      corazon,
      pellizco: false,
      pinchProgress: 0,
      opcionSel: -1,
    };

    if (!visibles.length) {
      reiniciarPellizco();
      onManos?.(base);
      return;
    }

    // ---- pellizco + seleccion (lista de canciones / opciones del reto) ----
    const m0 = visibles[0];
    const kp = m0.puntos;
    const tam = d(kp[0], kp[9]) || 1;
    const pellizco = d(kp[4], kp[8]) / tam < UMBRAL_PELLIZCO;
    const c = centroPalma(kp);
    let opcionSel = -1;

    if (modo === 'opciones') {
      opcionSel = Math.min(nOpciones - 1, Math.max(0, Math.floor(c.x * nOpciones)));
    }

    if (modo) {
      const msNecesarios = MS_CONFIRMAR_OPCION;
      if (pellizco && (opcionPinch < 0 || opcionPinch === opcionSel)) {
        if (!pinchStart) { pinchStart = ahora; opcionPinch = opcionSel; }
        pinchPerdidoDesde = 0;
        pinchProgress = Math.min(1, (ahora - pinchStart) / msNecesarios);
        if (pinchProgress >= 1 && !confirmEnviado) {
          confirmEnviado = true;
          onOpcion?.(opcionPinch);
        }
      } else if (pellizco) {
        // cambio de opcion en pleno pellizco: empieza de nuevo sobre la nueva
        reiniciarPellizco();
        pinchStart = ahora;
        opcionPinch = opcionSel;
      } else {
        if (!pinchPerdidoDesde) pinchPerdidoDesde = ahora;
        if (ahora - pinchPerdidoDesde > MS_TOLERANCIA_PELLIZCO) reiniciarPellizco();
      }
    }

    onManos?.({
      ...base,
      pellizco,
      pinchProgress: modo ? pinchProgress : 0,
      opcionSel,
    });
  };
}

function d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function esCorazon(m1, m2) {
  return d(m1[4], m2[4]) < 0.1 && d(m1[8], m2[8]) < 0.1;
}
