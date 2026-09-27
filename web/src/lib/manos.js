// Gestos de la mano -> acciones del karaoke.
// Consume los landmarks normalizados (0..1, ya espejados) que emite
// web/src/lib/vision.js (MediaPipe HandLandmarker).
//
//   mano visible en ESPERANDO             -> presencia
//   1 mano (solo) / 2 manos (duo) en MODO -> elegir modo (sostener)
//   mano arriba / abajo en SELECCIONANDO  -> scroll
//   pellizco (pulgar + indice) sostenido  -> confirmar
//   gesto de corazon (dos manos)          -> efecto

const UMBRAL_PELLIZCO = 0.55; // dist pulgar-indice / tamano de la mano (mas permisivo)
const MS_PRESENCIA = 500;
const MS_CONFIRMAR = 900;
const MS_SCROLL = 480;
const MS_MODO = 1000;
const MS_ESTABLE = 220; // la cantidad de manos tiene que mantenerse esto antes de contar

export function crearGestos({ getEstado, onGesto, onManos }) {
  const st = {
    lastEstado: null,
    presenciaEnviada: false,
    manoDesde: 0,
    ultimoScroll: 0,
    pinchStart: 0,
    pinchProgress: 0,
    confirmEnviado: false,
    // MODO
    countPend: -1,
    countPendDesde: 0,
    countEstable: 0,
    modoDesde: 0,
    modoEnviado: false,
  };

  // cantidad de manos "estable" (ignora parpadeos del tracker)
  function contarEstable(n, ahora) {
    if (n !== st.countPend) {
      st.countPend = n;
      st.countPendDesde = ahora;
    }
    if (ahora - st.countPendDesde >= MS_ESTABLE) st.countEstable = n;
    return st.countEstable;
  }

  return function procesar({ manos }) {
    const estado = getEstado();
    const ahora = performance.now();
    if (estado !== st.lastEstado) {
      if (estado === 'ESPERANDO') st.presenciaEnviada = false;
      st.pinchStart = 0;
      st.pinchProgress = 0;
      st.confirmEnviado = false;
      st.countPend = -1;
      st.countEstable = 0;
      st.modoDesde = 0;
      st.modoEnviado = false;
      st.lastEstado = estado;
    }

    const n = contarEstable(manos.length, ahora);
    const corazon = manos.length >= 2 && esCorazon(manos[0].puntos, manos[1].puntos);

    // --- MODO: sostener 1 mano (solo) o 2 (duo) ---
    if (estado === 'MODO') {
      const eleccion = n === 1 ? 'solo' : n >= 2 ? 'duo' : null;
      if (!eleccion) {
        st.modoDesde = 0;
      } else if (!st.modoDesde || st.modoUlt !== eleccion) {
        st.modoDesde = ahora;
        st.modoUlt = eleccion;
      }
      const progreso = eleccion ? Math.min(1, (ahora - st.modoDesde) / MS_MODO) : 0;
      if (eleccion && progreso >= 1 && !st.modoEnviado) {
        st.modoEnviado = true;
        onGesto({ tipo: 'modo', valor: eleccion });
      }
      onManos?.({
        manos: manos.map((m) => ({ puntos: m.puntos })),
        cantidadManos: n,
        corazon: false,
        modoElegido: eleccion,
        modoProgreso: progreso,
        gesto: eleccion ? `${eleccion} ${Math.round(progreso * 100)}%` : 'mostrá 1 o 2 manos',
      });
      return;
    }

    const mano = manos[0];
    if (!mano) {
      st.manoDesde = 0;
      st.pinchStart = 0;
      st.pinchProgress = 0;
      onManos?.({ manos: [], cantidadManos: 0, corazon: false, pinchProgress: 0, gesto: 'sin manos' });
      return;
    }

    const kp = mano.puntos;
    const tam = d(kp[0], kp[9]) || 1;
    const pellizco = d(kp[4], kp[8]) / tam < UMBRAL_PELLIZCO;
    const ny = (kp[0].y + kp[9].y) / 2; // centro de la mano, 0 arriba .. 1 abajo
    let gesto = `${n} mano${n === 1 ? '' : 's'}`;

    if (estado === 'ESPERANDO') {
      if (!st.manoDesde) st.manoDesde = ahora;
      if (!st.presenciaEnviada && ahora - st.manoDesde > MS_PRESENCIA) {
        st.presenciaEnviada = true;
        onGesto({ tipo: 'presencia' });
      }
      gesto = 'listo!';
    } else if (estado === 'SELECCIONANDO') {
      const zona = ny < 0.38 ? 'arriba' : ny > 0.62 ? 'abajo' : null;
      if (zona && ahora - st.ultimoScroll > MS_SCROLL) {
        st.ultimoScroll = ahora;
        onGesto({ tipo: 'scroll', direccion: zona });
      }
      if (pellizco) {
        if (!st.pinchStart) st.pinchStart = ahora;
        st.pinchProgress = Math.min(1, (ahora - st.pinchStart) / MS_CONFIRMAR);
        if (st.pinchProgress >= 1 && !st.confirmEnviado) {
          st.confirmEnviado = true;
          onGesto({ tipo: 'confirmar' });
        }
        gesto = `confirmando ${Math.round(st.pinchProgress * 100)}%`;
      } else {
        st.pinchStart = 0;
        st.pinchProgress = 0;
        st.confirmEnviado = false;
        gesto = zona ? (zona === 'arriba' ? '↑ subiendo' : '↓ bajando') : 'movete arriba/abajo o pellizcá';
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
      pinchProgress: st.pinchProgress,
      zonaScroll: estado === 'SELECCIONANDO' ? (ny < 0.38 ? 'arriba' : ny > 0.62 ? 'abajo' : null) : null,
      gesto,
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
