// Datos de las manos para los retos y el esqueleto en pantalla.
// Consume los landmarks normalizados (0..1, ya espejados) que emite
// web/src/lib/vision.js (MediaPipe HandLandmarker).
//
// Ya NO se usa para elegir cancion ni confirmar turno (eso lo hace cada
// persona desde su celu): la camara solo alimenta los retos de gestos.

const UMBRAL_PELLIZCO = 0.65; // dist pulgar-indice / tamano de la mano (permisivo)
const MS_ESTABLE = 220; // la cantidad de manos tiene que mantenerse esto antes de contar

export function crearGestos({ onManos }) {
  let pend = -1;
  let pendDesde = 0;
  let estable = 0;

  // cantidad de manos "estable" (ignora parpadeos del tracker)
  function contarEstable(n, ahora) {
    if (n !== pend) {
      pend = n;
      pendDesde = ahora;
    }
    if (ahora - pendDesde >= MS_ESTABLE) estable = n;
    return estable;
  }

  return function procesar({ manos }) {
    const ahora = performance.now();
    const n = contarEstable(manos.length, ahora);
    if (!manos.length) {
      onManos?.({ manos: [], manosIzq: [], manosDer: [], cantidadManos: 0, corazon: false, pellizco: false });
      return;
    }

    const kp = manos[0].puntos;
    const tam = d(kp[0], kp[9]) || 1;
    const pellizco = d(kp[4], kp[8]) / tam < UMBRAL_PELLIZCO;
    const corazon = manos.length >= 2 && esCorazon(manos[0].puntos, manos[1].puntos);

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
