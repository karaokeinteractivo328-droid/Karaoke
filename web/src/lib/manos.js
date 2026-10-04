// Gestos de la mano. Consume los landmarks normalizados (0..1, ya espejados)
// que emite web/src/lib/vision.js (MediaPipe HandLandmarker).
//
//  - Durante el turno de alguien (CALLING) la CANCION SE ELIGE CON LA MANO:
//      mano arriba / abajo      -> onScroll('arriba' | 'abajo')
//      pellizco sostenido ~1 s  -> onConfirmar()
//  - Siempre: datos de las manos para el esqueleto y los retos.

const UMBRAL_PELLIZCO = 0.65; // dist pulgar-indice / tamano de la mano (permisivo)
const MS_CONFIRMAR = 900;
const MS_TOLERANCIA_PELLIZCO = 250; // el tracker parpadea: no se reinicia el progreso por eso
const MS_SCROLL = 350;
const ZONA_SCROLL = 0.45; // debajo de esto = arriba, arriba de (1-esto) = abajo (zona muerta chica al medio)
const MS_ESTABLE = 220; // la cantidad de manos tiene que mantenerse esto antes de contar

export function crearGestos({ getSeleccionActiva = () => false, onScroll, onConfirmar, onManos }) {
  let pend = -1;
  let pendDesde = 0;
  let estable = 0;
  let ultimoScroll = 0;
  let pinchStart = 0;
  let pinchProgress = 0;
  let pinchPerdidoDesde = 0;
  let confirmEnviado = false;
  let seleccionPrevia = false;

  // cantidad de manos "estable" (ignora parpadeos del tracker)
  function contarEstable(n, ahora) {
    if (n !== pend) {
      pend = n;
      pendDesde = ahora;
    }
    if (ahora - pendDesde >= MS_ESTABLE) estable = n;
    return estable;
  }

  function reiniciarPellizco() {
    pinchStart = 0;
    pinchProgress = 0;
    pinchPerdidoDesde = 0;
    confirmEnviado = false;
  }

  return function procesar({ manos }) {
    const ahora = performance.now();
    const n = contarEstable(manos.length, ahora);
    const seleccion = !!getSeleccionActiva();
    if (seleccion !== seleccionPrevia) {
      reiniciarPellizco();
      ultimoScroll = ahora; // no scrollea de golpe al empezar el turno
      seleccionPrevia = seleccion;
    }

    if (!manos.length) {
      reiniciarPellizco();
      onManos?.({ manos: [], manosIzq: [], manosDer: [], cantidadManos: 0, corazon: false, pellizco: false, pinchProgress: 0, zonaScroll: null });
      return;
    }

    const kp = manos[0].puntos;
    const tam = d(kp[0], kp[9]) || 1;
    const pellizco = d(kp[4], kp[8]) / tam < UMBRAL_PELLIZCO;
    const corazon = manos.length >= 2 && esCorazon(manos[0].puntos, manos[1].puntos);
    const ny = (kp[0].y + kp[9].y) / 2; // centro de la mano, 0 arriba .. 1 abajo
    const zona = ny < ZONA_SCROLL ? 'arriba' : ny > 1 - ZONA_SCROLL ? 'abajo' : null;

    if (seleccion) {
      if (zona && ahora - ultimoScroll > MS_SCROLL) {
        ultimoScroll = ahora;
        onScroll?.(zona);
      }
      if (pellizco) {
        if (!pinchStart) pinchStart = ahora;
        pinchPerdidoDesde = 0;
        pinchProgress = Math.min(1, (ahora - pinchStart) / MS_CONFIRMAR);
        if (pinchProgress >= 1 && !confirmEnviado) {
          confirmEnviado = true;
          onConfirmar?.();
        }
      } else {
        if (!pinchPerdidoDesde) pinchPerdidoDesde = ahora;
        if (ahora - pinchPerdidoDesde > MS_TOLERANCIA_PELLIZCO) reiniciarPellizco();
      }
    }

    // con hasta 4 manos en pantalla (cantante + copiloto), separamos por
    // mitad de camara para que un reto de "una mano cada uno" tenga sentido -
    // es una heuristica por posicion, no reconocimiento real de personas.
    const manosConLado = manos.map((m) => ({ puntos: m.puntos, lado: ladoDe(m) }));

    onManos?.({
      manos: manosConLado,
      manosIzq: manosConLado.filter((m) => m.lado === 'izq'),
      manosDer: manosConLado.filter((m) => m.lado === 'der'),
      cantidadManos: n,
      corazon,
      pellizco,
      pinchProgress: seleccion ? pinchProgress : 0,
      zonaScroll: seleccion ? zona : null,
    });
  };
}

function d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ladoDe(mano) {
  return mano.puntos[0].x < 0.5 ? 'izq' : 'der';
}

function esCorazon(m1, m2) {
  return d(m1[4], m2[4]) < 0.1 && d(m1[8], m2[8]) < 0.1;
}
