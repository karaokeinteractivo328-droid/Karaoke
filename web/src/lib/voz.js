// Reconocer si alguien CANTA (con el microfono) y alentarlo cuando no lo hace.
//
// 1) crearDetectorVoz: recibe el nivel de sonido del micro (RMS, 0..1) varias veces por segundo y dice si
//    hay voz. No usa un umbral fijo: aprende el ruido de fondo de la sala (lo que sobre de la musica
//    despues de la cancelacion de eco, el aire acondicionado...) y exige estar claramente por encima.
//    Una voz cuenta cuando se mantiene un ratito (un golpe de ruido suelto no es cantar). Ademas del volumen
//    mira DONDE esta la energia: la voz vive entre ~200 y 3400 Hz; un golpe, un zumbido grave o el siseo de
//    un parlante tienen su energia en otro lado y casi no cuentan.
//    Si el micro esta mudo (o desconectado, silencio digital) NO se considera "vivo": ahi no se alienta nunca,
//    porque no se puede saber si alguien canta.
// 2) crearAliento: decide CUANDO alentar y QUE decir: solo durante la cancion, solo cuando la letra pide
//    cantar (no en un instrumental), despues de unos segundos seguidos de silencio, sin repetirse ni
//    pasarse de insistente, y celebra cuando la voz vuelve.
//
// Todo es logica pura (el reloj se inyecta) para poder probarla sin microfono.

export const MENSAJES_ALIENTO = [
  '¡Dale {nombre}, cantá! 🎤',
  '¡Animate, que la letra es tuya! ✨',
  '¡Soltá la voz, que te estamos escuchando! 👏',
  '¡Vos podés, cantá fuerte! 💪',
  '¡Todos esperamos tu voz! 🔥',
  '¡Que se escuche ese vozarrón! 🎶',
];
export const MENSAJES_BIEN = ['¡Así se canta! 🔥', '¡Eso es! 🎤', '¡Qué bien suena! 👏'];

export function crearDetectorVoz({
  ahora = () => performance.now(),
  piso = 0.006, // nivel minimo para considerar voz (~ -44 dBFS), aunque la sala este en silencio
  factor = 2.8, // cuantas veces por encima del ruido de fondo tiene que estar
  minActivoMs = 250, // cuanto tiene que sostenerse para ser voz
  huecoMs = 160, // un corte corto (respirar, una consonante) no reinicia
  retencionMs = 1200, // despues de la ultima voz se sigue considerando "cantando" este rato
  minProporcion = 0.3, // si menos de esta parte de la energia esta en la banda de la voz, no es voz (golpe, zumbido)
  calibrarMs = 2500, // tiempo escuchando antes de poder afirmar que NO hay voz (aprende el ruido de la sala)
  mudoMs = 8000, // micro en silencio digital este rato = esta mudo / desconectado
} = {}) {
  let ruido = null;
  let activoDesde = null;
  let ultimoActivo = 0;
  let ultimaVoz = null;
  let inicio = null;
  let ultimaMuestra = null;
  let calibrarHasta = 0; // mientras dure, todo lo que se escucha se toma como ruido de fondo (la musica que recien arranca)
  let ultimaSenal = null; // ultima vez que el micro entrego algo distinto del silencio digital

  // rms = volumen del micro; proporcion (opcional, 0..1) = que parte de la energia esta en la banda de la voz
  function muestra(bruto, t = ahora(), proporcion) {
    if (!Number.isFinite(bruto)) return;
    if (inicio === null) inicio = t;
    ultimaMuestra = t;
    if (bruto > 2e-5) ultimaSenal = t;
    // el volumen "util" es el de la banda de la voz: bruto x raiz(proporcion). Sin dato de banda, vale el bruto.
    const rms = Number.isFinite(proporcion) ? bruto * Math.sqrt(Math.max(0, Math.min(1, proporcion))) : bruto;
    if (ruido === null) ruido = rms;
    if (t < calibrarHasta) { // la musica recien arranca: lo que se cuele por el micro es el nuevo "silencio"
      ruido += (rms - ruido) * 0.35;
      activoDesde = null;
      return;
    }
    const umbral = Math.max(piso, ruido * factor);
    const hay = rms > umbral && !(Number.isFinite(proporcion) && proporcion < minProporcion);
    // el ruido de fondo se aprende: baja rapido y sube despacio cuando NO hay voz. Mientras hay voz el piso
    // queda congelado (cantar fuerte un buen rato no lo sube hasta taparse a si mismo); solo si "hay voz"
    // lleva mas de 25 s seguidos (la musica filtrada se puso mas fuerte) se adapta, muy de a poco.
    if (!hay) ruido += (rms - ruido) * (rms < ruido ? 0.2 : 0.02);
    else if (activoDesde !== null && t - activoDesde > 25_000) ruido += (rms - ruido) * 0.0003;
    if (hay) {
      if (activoDesde === null || t - ultimoActivo > huecoMs) activoDesde = t;
      ultimoActivo = t;
      if (t - activoDesde >= minActivoMs) ultimaVoz = t;
    }
  }

  return {
    muestra,
    cantando: (t = ahora()) => ultimaVoz !== null && t - ultimaVoz <= retencionMs,
    // cuanto hace que no se escucha una voz (si nunca hubo, desde que se empezo a escuchar)
    silencioMs: (t = ahora()) => (inicio === null ? 0 : t - (ultimaVoz ?? inicio)),
    // hay datos recientes del microfono (si no llegan, no se puede decir nada)
    vivo: (t = ahora(), ms = 1500) => ultimaMuestra !== null && t - ultimaMuestra <= ms && ultimaSenal !== null && t - ultimaSenal <= mudoMs,
    // ya escucho el tiempo suficiente como para conocer el ruido de la sala (antes, "no hay voz" no significa nada)
    listo: (t = ahora()) => inicio !== null && t - inicio >= calibrarMs,
    get ruido() { return ruido; },
    // los proximos `ms` se consideran ruido de fondo (se llama mientras arranca la musica: antes no habia nada)
    calibrar(ms = 3000, t = ahora()) { calibrarHasta = Math.max(calibrarHasta, t + ms); },
    reiniciar(t = ahora()) {
      activoDesde = null;
      ultimaVoz = null;
      inicio = t;
    },
  };
}

export function crearAliento({
  umbralMs = 8000, // silencio seguido antes del primer aliento
  repetirMs = 18000, // entre un aliento y el siguiente
  minInicioMs = 10000, // no se alienta en los primeros segundos de la cancion
  minLineas = 2, // lineas de letra que pasaron SIN voz (un silencio largo en un instrumental no es "no canta")
  finMs = 10000, // ni sobre el final de la cancion
  mostrarMs = 5000, // cuanto se ve cada mensaje
  azar = Math.random,
} = {}) {
  let ultimoAt = null;
  let mostradoAt = null;
  let indice = -1;
  let visible = false;
  let pendienteBien = false; // hubo aliento: si la voz vuelve, se celebra

  const elegir = (lista, i) => lista[((i % lista.length) + lista.length) % lista.length];
  function reiniciar() {
    ultimoAt = null;
    mostradoAt = null;
    indice = Math.floor(azar() * MENSAJES_ALIENTO.length) - 1;
    visible = false;
    pendienteBien = false;
  }
  reiniciar();

  // Devuelve { accion: 'mostrar', tipo, texto } | { accion: 'ocultar' } | null
  // lineasSilencio / restanteMs son opcionales: si no se pasan, esa condicion no se exige
  function tick({ ahora, enCancion, cantable, micVivo, silencioMs, cancionMs, nombre = '', lineasSilencio, restanteMs }) {
    if (!enCancion || !micVivo) {
      const estabaVisible = visible;
      reiniciar();
      return estabaVisible ? { accion: 'ocultar' } : null;
    }
    // la voz volvio despues de un aliento: se celebra
    if (pendienteBien && silencioMs < 800) {
      pendienteBien = false;
      visible = true;
      mostradoAt = ahora;
      ultimoAt = ahora; // y se vuelve a esperar antes de otro aliento
      return { accion: 'mostrar', tipo: 'bien', texto: elegir(MENSAJES_BIEN, Math.floor(azar() * MENSAJES_BIEN.length)) };
    }
    if (visible && ahora - mostradoAt > mostrarMs) {
      visible = false;
      return { accion: 'ocultar' };
    }
    const pasaronLineas = lineasSilencio === undefined || lineasSilencio >= minLineas;
    const nadaDeFinal = restanteMs === undefined || restanteMs >= finMs;
    const toca = cantable && pasaronLineas && nadaDeFinal && cancionMs >= minInicioMs && silencioMs >= umbralMs && (ultimoAt === null || ahora - ultimoAt >= repetirMs);
    if (!toca) return null;
    indice++;
    ultimoAt = ahora;
    mostradoAt = ahora;
    visible = true;
    pendienteBien = true;
    return { accion: 'mostrar', tipo: 'aliento', texto: elegir(MENSAJES_ALIENTO, indice).replace('{nombre}', nombre || 'cantante') };
  }

  return { tick, reiniciar, get visible() { return visible; } };
}
