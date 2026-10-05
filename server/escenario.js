// El escenario: UNA sola sala, UNA fila, UNA experiencia continua.
//
// Hay dos maquinas que antes estaban mezcladas:
//
//  A) ESCENARIO (global, una sola). Solo 5 estados:
//       STANDBY -> CALLING -> COUNTDOWN -> PLAYING -> RESULT -> (CALLING | STANDBY)
//
//  B) PARTICIPANTE (uno por persona, identificado por un token que guarda su
//     celu):  PUBLIC -> QUEUED -> CALLED -> SINGING -> DONE -> (QUEUED ...)
//
//  C) AUDIO de cada cancion elegida (preparando -> lista | error). "Lista" NO es
//     "se encontro una URL": significa que el server tiene el archivo y lo
//     valido (decodifica, dura lo que debe, no es silencio) Y que la PANTALLA
//     (que es la que suena) lo descargo, lo decodifico en su navegador y tiene
//     el sonido habilitado. Nunca se empieza una performance sin eso.
//
// Todo el modulo es determinista: no usa setTimeout. Lo unico que hace avanzar
// el tiempo es `tick()` (el server lo llama una vez por segundo, el "watchdog")
// y el reloj `ahora()` se inyecta, asi los tests no esperan tiempos reales.

import { randomBytes } from 'node:crypto';

export const ETAPAS = Object.freeze({
  STANDBY: 'STANDBY',
  CALLING: 'CALLING',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  RESULT: 'RESULT',
});

export const ESTADOS_P = Object.freeze({
  PUBLIC: 'PUBLIC',
  QUEUED: 'QUEUED',
  CALLED: 'CALLED',
  SINGING: 'SINGING',
  DONE: 'DONE',
});

export const CONFIG_BASE = Object.freeze({
  LLAMADO_MS: 60_000, // tiempo para tocar LISTO en el celu (si ya tenia cancion elegida)
  LLAMADO_SIN_CANCION_MS: 90_000, // si ademas la tiene que buscar desde cero
  AUDIO_REQUERIDO: true, // no se empieza sin audio listo (los tests lo apagan donde no importa)
  AUDIO_ESPERA_MS: 120_000, // cuanto se espera a que se prepare el audio de quien ya fue llamado
  CALLED_DESCONEXION_MS: 30_000, // llamado y sin celu: gracia antes de saltearlo
  EN_FILA_DESCONEXION_MS: 10 * 60_000, // en fila y sin celu (bloqueo de pantalla, etc.)
  PUBLICO_RETENCION_MS: 30 * 60_000, // publico desconectado: se limpia de memoria
  COUNTDOWN_S: 3,
  RESULT_MS: 15_000,
  RESULT_INTERRUMPIDO_MS: 6_000,
  PLAYING_EXTRA_MS: 25_000, // duracion + esto sin "fin" => el watchdog cierra
  CANTANTE_DESCONEXION_MS: 25_000, // cantando y sin celu => abandono
  PANTALLA_DESCONEXION_MS: 15_000, // pantalla caida en plena performance
  SIN_PERSONA_MS: 45_000, // camara sana y nadie en cuadro => abandono
  FILA_MAX: 30,
  PARTICIPANTES_MAX: 500,
  REACC_MIN_MS: 250, // 4 por segundo por persona
  REACC_MAX_POR_PERSONA: 15, // reacciones que cuentan para el puntaje
  RETO_PUNTOS: 10, // lo que vale cada reto cumplido
  RETOS_MAX: 30, // tope de puntos de retos por performance
  CALLING_TIPICO_S: 10, // para estimar esperas
  DURACION_DEFAULT_S: 220,
});

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
const PESO = Object.freeze({ corazon: 1, fuego: 1.5, aplauso: 1 });
const TOKEN_OK = /^[A-Za-z0-9_-]{16,64}$/;

const aleatorio = (largo, alfabeto) => {
  const bytes = randomBytes(largo);
  let s = '';
  for (let i = 0; i < largo; i++) s += alfabeto[bytes[i] % alfabeto.length];
  return s;
};
const idCorto = () => aleatorio(6, 'abcdefghijkmnpqrstuvwxyz23456789');
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const limpiarNombre = (n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
const redondear10 = (s) => Math.round(s / 10) * 10;
const reaccionesVacias = () => ({ corazon: 0, fuego: 0, aplauso: 0 });

export function crearEscenario({
  canciones = [],
  onCambio,
  onResultado,
  onRonda, // arranca una performance: el server habilita la subida de ese video
  onRetoResultado, // se resolvio el reto de la palabra (acierto, error o tiempo)
  ahora = () => Date.now(),
  config = {},
  log = () => {},
} = {}) {
  const C = { ...CONFIG_BASE, ...config };
  const participantes = new Map(); // token -> participante
  let fila = []; // tokens, en orden de llegada
  let etapa = ETAPAS.STANDBY;
  let actual = null; // la performance en el escenario (CALLING..RESULT)
  const pantalla = {
    conectada: false,
    camara: true,
    mic: true,
    audio: true,
    desconectadaDesde: null,
    hayPersonaDesde: null,
    ultimaPersonaVista: 0,
    ultimoTickCamara: 0,
  };
  const audioServidor = new Map(); // cancionId -> { estado, motivo }: el server tiene el archivo y lo valido
  const audioPantalla = new Map(); // cancionId -> { estado, motivo }: la pantalla lo cargo y se puede reproducir
  let sucio = false;
  const marcar = () => { sucio = true; };
  const emitirSiCambio = () => {
    if (!sucio) return;
    sucio = false;
    onCambio && onCambio();
  };

  // ---------------------------------------------------------------- catalogo
  const porId = (id) => canciones.find((c) => c.id === id) || null;
  const duracionPromedio = () => {
    const ds = canciones.map((c) => Number(c.duracion)).filter((n) => n > 0);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : C.DURACION_DEFAULT_S;
  };
  const duracionDe = (id) => Number(porId(id)?.duracion) || duracionPromedio();
  const cancionPublica = (id) => {
    const c = porId(id);
    return c
      ? {
          id: c.id,
          titulo: c.titulo,
          artista: c.artista,
          duracion: Number(c.duracion) || null,
          voces: c.voces ?? 'solo',
          // lo que se guarda de la cancion elegida (YouTube): videoId, canal, miniatura, con que
          // consulta se la encontro y cuan "karaoke" es
          origen: c.origen || 'local',
          videoId: c.videoId || null,
          canal: c.canal || c.artista,
          thumbnail: c.thumbnail || null,
          searchQuery: c.searchQuery || '',
          karaokeScore: c.karaokeScore ?? null,
        }
      : null;
  };

  // ----------------------------------------------------------- participantes
  function nuevoParticipante(token) {
    const t = ahora();
    return {
      token,
      id: idCorto(),
      nombre: '',
      estado: ESTADOS_P.PUBLIC,
      cancionId: null,
      modo: 'solo',
      conectado: true,
      desconectadoDesde: null,
      ultimaActividad: t,
      codigoCopiloto: null,
      copiloto: null, // token de mi copiloto
      copilotoDe: null, // token del cantante al que ayudo
      ultimaReaccion: 0,
      ultimoResultado: null,
      modoManual: null, // 'solo' | 'duo' si la persona lo eligio con el selector
      ultimoVideoToken: null,
      mensaje: null,
    };
  }

  function codigoUnico() {
    for (;;) {
      const c = aleatorio(4, ABC);
      if (![...participantes.values()].some((p) => p.codigoCopiloto === c)) return c;
    }
  }

  function soltarCopiloto(cantante, mensaje = null) {
    if (!cantante.copiloto) return;
    const c = participantes.get(cantante.copiloto);
    if (c) {
      c.copilotoDe = null;
      if (mensaje) c.mensaje = mensaje;
    }
    cantante.copiloto = null;
  }

  function eliminarParticipante(p) {
    soltarCopiloto(p);
    if (p.copilotoDe) {
      const s = participantes.get(p.copilotoDe);
      if (s && s.copiloto === p.token) s.copiloto = null;
    }
    fila = fila.filter((t) => t !== p.token);
    participantes.delete(p.token);
  }

  function quitarDeFila(p) {
    fila = fila.filter((t) => t !== p.token);
    if (p.estado === ESTADOS_P.QUEUED) p.estado = ESTADOS_P.PUBLIC;
    soltarCopiloto(p, 'La persona salió de la fila');
    p.codigoCopiloto = null;
    marcar();
  }

  function hola({ token, nombre, intencion } = {}) {
    if (!TOKEN_OK.test(String(token || ''))) return { ok: false, error: 'Sesión inválida' };
    let p = participantes.get(token);
    const nuevo = !p;
    if (nuevo) {
      if (participantes.size >= C.PARTICIPANTES_MAX) return { ok: false, error: 'La sala está llena' };
      p = nuevoParticipante(token);
      participantes.set(token, p);
    }
    const n = limpiarNombre(nombre);
    if (n) p.nombre = n;
    p.conectado = true;
    p.desconectadoDesde = null;
    p.ultimaActividad = ahora();
    // el server se reinicio y este celu estaba en fila: se re-anota solo
    if (nuevo && intencion?.enFila && p.nombre) {
      if (porId(intencion.cancionId)) p.cancionId = intencion.cancionId;
      if (intencion.modo === 'duo' || intencion.modo === 'solo') p.modoManual = p.modo = intencion.modo;
      entrarFilaInterno(p);
    }
    marcar();
    emitirSiCambio();
    return { ok: true, nuevo };
  }

  function desconectar(token) {
    const p = participantes.get(token);
    if (!p || !p.conectado) return;
    p.conectado = false;
    p.desconectadoDesde = ahora();
    marcar();
    emitirSiCambio();
  }

  // -------------------------------------------------------------------- fila
  function entrarFilaInterno(p) {
    if (p.estado === ESTADOS_P.QUEUED || p.estado === ESTADOS_P.CALLED || p.estado === ESTADOS_P.SINGING) {
      return { ok: true, yaEstaba: true };
    }
    if (fila.length >= C.FILA_MAX) return { ok: false, error: 'La fila está llena, probá en un rato' };
    fila.push(p.token);
    p.estado = ESTADOS_P.QUEUED;
    p.mensaje = null;
    p.codigoCopiloto = p.codigoCopiloto || codigoUnico();
    marcar();
    if (etapa === ETAPAS.STANDBY) avanzar();
    return { ok: true };
  }

  function entrarFila(token, nombre, modo) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada, recargá la página' };
    // la persona puede elegir solo / dúo ANTES de anotarse
    if (modo === 'solo' || modo === 'duo') {
      p.modoManual = modo;
      p.modo = modoEfectivo(p);
    }
    const n = limpiarNombre(nombre);
    if (n) p.nombre = n;
    if (!p.nombre) return { ok: false, error: 'Escribí tu nombre' };
    if (p.copilotoDe) return { ok: false, error: 'Estás ayudando a otra persona' };
    p.ultimaActividad = ahora();
    const r = entrarFilaInterno(p);
    emitirSiCambio();
    return r;
  }

  function salirFila(token) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (p.estado === ESTADOS_P.QUEUED) {
      quitarDeFila(p);
    } else if (p.estado === ESTADOS_P.CALLED && actual?.token === token) {
      cancelarLlamado(p, 'Cancelaste tu turno');
    } else if (p.estado === ESTADOS_P.SINGING && actual?.token === token) {
      return terminarInterno(p);
    }
    emitirSiCambio();
    return { ok: true };
  }

  // Solo o dueto: CUALQUIER cancion se puede cantar de las dos formas y lo elige la
  // persona en el selector (si no toca nada, solo).
  const modoEfectivo = (p) => p.modoManual ?? 'solo';

  function elegirModo(token, modo) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (modo !== 'solo' && modo !== 'duo') return { ok: false, error: 'Modo inválido' };
    if (p.estado !== ESTADOS_P.QUEUED && p.estado !== ESTADOS_P.CALLED) {
      return { ok: false, error: 'Primero anotate en la fila' };
    }
    if (p.estado === ESTADOS_P.CALLED && actual?.token === token && etapa !== ETAPAS.CALLING) {
      return { ok: false, error: 'Ya empezó tu turno' };
    }
    p.modoManual = modo;
    p.modo = modoEfectivo(p);
    if (p.estado === ESTADOS_P.CALLED && actual?.token === token) actual.modo = p.modo;
    p.ultimaActividad = ahora();
    marcar();
    emitirSiCambio();
    return { ok: true, modo: p.modo };
  }

  function elegirCancion(token, cancionId, modo) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (!porId(cancionId)) return { ok: false, error: 'Esa canción no existe' };
    if (p.estado !== ESTADOS_P.QUEUED && p.estado !== ESTADOS_P.CALLED) {
      return { ok: false, error: 'Primero anotate en la fila' };
    }
    if (p.estado === ESTADOS_P.CALLED && actual?.token === token && etapa !== ETAPAS.CALLING) {
      return { ok: false, error: 'Ya empezó tu turno' };
    }
    p.cancionId = cancionId;
    if (modo === 'solo' || modo === 'duo') p.modoManual = modo;
    p.modo = modoEfectivo(p);
    p.ultimaActividad = ahora();
    if (p.estado === ESTADOS_P.CALLED && actual?.token === token) {
      actual.cancionId = p.cancionId;
      actual.modo = p.modo;
      actual.llamadoHasta = Math.max(actual.llamadoHasta, ahora() + 20_000);
    }
    marcar();
    emitirSiCambio();
    return { ok: true };
  }

  // ---------------------------------------------------------------- escenario
  function avanzar() {
    while (fila.length) {
      const token = fila.shift();
      const p = participantes.get(token);
      if (!p || p.estado !== ESTADOS_P.QUEUED) continue;
      const t = ahora();
      etapa = ETAPAS.CALLING;
      p.estado = ESTADOS_P.CALLED;
      actual = {
        token,
        rondaId: aleatorio(10, ABC),
        videoToken: null,
        cancionId: p.cancionId,
        modo: p.modo,
        llamadoDesde: t,
        llamadoHasta: t + (p.cancionId ? C.LLAMADO_MS : C.LLAMADO_SIN_CANCION_MS),
        countdownHasta: null,
        cuenta: null,
        playingDesde: null,
        reacciones: reaccionesVacias(),
        porPersona: new Map(),
        retosPuntos: 0,
        retosHechos: new Map(), // idReto -> puntos (una sola recompensa por reto)
        retoPalabra: null,
        resultado: null,
        resultadoHasta: null,
      };
      log(`[escenario] llamado: ${p.nombre}`);
      marcar();
      return true;
    }
    etapa = ETAPAS.STANDBY;
    actual = null;
    marcar();
    return false;
  }

  function cancelarLlamado(p, mensaje) {
    p.estado = ESTADOS_P.PUBLIC;
    p.mensaje = mensaje;
    soltarCopiloto(p, 'La persona perdió su turno');
    p.codigoCopiloto = null;
    actual = null;
    etapa = ETAPAS.STANDBY;
    log(`[escenario] turno cancelado: ${p.nombre} (${mensaje})`);
    marcar();
    avanzar();
  }

  function listo(token) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (etapa !== ETAPAS.CALLING || actual?.token !== token) {
      return { ok: false, error: 'Todavía no es tu turno' };
    }
    if (!p.cancionId) return { ok: false, error: 'Elegí una canción primero' };
    // "Listo" es del celu, pero el audio manda: nunca se arranca con audio roto o a medio preparar
    const a = audioDe(p.cancionId);
    if (a.estado === 'preparando') return { ok: false, error: 'El audio todavía se está preparando', audio: a };
    if (a.estado === 'bloqueado') return { ok: false, error: 'La pantalla necesita activar el sonido', audio: a };
    if (a.estado === 'error') return { ok: false, error: `No se pudo preparar el audio: ${a.motivo || 'fuente no reproducible'}`, audio: a };
    p.ultimaActividad = ahora();
    empezarCountdown(p);
    emitirSiCambio();
    return { ok: true };
  }

  // --------------------------------------------------------------- audio
  // Estado del audio de una cancion, mirado desde donde importa: se escucha o no.
  //   preparando  se esta bajando / validando / cargando en la pantalla
  //   bloqueado   todo cargado pero el navegador de la pantalla no tiene sonido habilitado
  //   lista       existe + cargo + decodifica + el sonido esta habilitado
  //   error       no se pudo (con motivo)
  function audioDe(id) {
    if (!id) return { estado: 'sin_cancion' };
    if (!C.AUDIO_REQUERIDO) return { estado: 'lista' };
    const srv = audioServidor.get(id);
    if (!srv || srv.estado === 'preparando') return { estado: 'preparando', etapa: 'servidor' };
    if (srv.estado === 'error') return { estado: 'error', motivo: srv.motivo || 'No se pudo conseguir el audio' };
    const pan = audioPantalla.get(id);
    if (pan?.estado === 'error') return { estado: 'error', motivo: pan.motivo || 'La pantalla no pudo cargar el audio' };
    if (!pantalla.conectada || !pan || pan.estado !== 'lista') return { estado: 'preparando', etapa: 'pantalla' };
    if (!pantalla.audio) return { estado: 'bloqueado', motivo: 'La pantalla necesita activar el sonido' };
    return { estado: 'lista' };
  }

  // Lo que ve cada persona: quien todavia esta lejos en la fila no necesita que la
  // pantalla ya lo tenga cargado (solo se precarga al que sigue): con el archivo
  // validado en el server ya figura lista.
  function audioDeParticipante(p) {
    const a = audioDe(p.cancionId);
    const cerca = actual?.token === p.token || fila[0] === p.token;
    if (!cerca && a.estado !== 'error' && a.estado !== 'sin_cancion' && audioServidor.get(p.cancionId)?.estado === 'lista') {
      return { estado: 'lista', verificadaEnPantalla: false };
    }
    return a;
  }

  // el server termino de conseguir/validar el archivo (o fallo)
  function audioServidorEstado(id, estado, motivo) {
    if (!id || !['preparando', 'lista', 'error'].includes(estado)) return { ok: false };
    audioServidor.set(id, { estado, motivo: motivo ? String(motivo).slice(0, 160) : null });
    marcar();
    emitirSiCambio();
    return { ok: true };
  }

  // la pantalla (el navegador que suena) reporta que paso con el audio de esa cancion
  function pantallaAudio({ cancionId, estado, motivo } = {}) {
    if (!cancionId || !['preparando', 'lista', 'error'].includes(estado)) return { ok: false };
    audioPantalla.set(String(cancionId).slice(0, 80), { estado, motivo: motivo ? String(motivo).slice(0, 160) : null });
    if (audioPantalla.size > 24) audioPantalla.delete(audioPantalla.keys().next().value);
    marcar();
    emitirSiCambio();
    return { ok: true };
  }

  // la pantalla no pudo reproducir (play() rechazado, error del <audio>): nunca seguimos "cantando" en silencio
  function pantallaAudioFallo({ motivo } = {}) {
    if (!actual || (etapa !== ETAPAS.COUNTDOWN && etapa !== ETAPAS.PLAYING)) return { ok: false };
    const m = String(motivo || 'el audio no se pudo reproducir').slice(0, 160);
    audioPantalla.set(actual.cancionId, { estado: 'error', motivo: m });
    log(`[escenario] fallo de audio en plena performance: ${m}`);
    finalizar({ interrumpida: true, motivo: `Falló el audio (${m})` });
    emitirSiCambio();
    return { ok: true };
  }

  // ids de las canciones que alguien esta esperando o cantando (el cache no las borra)
  function cancionesEnUso() {
    const ids = new Set();
    for (const p of participantes.values()) {
      if (p.cancionId && (p.estado === ESTADOS_P.QUEUED || p.estado === ESTADOS_P.CALLED || p.estado === ESTADOS_P.SINGING)) ids.add(p.cancionId);
    }
    if (actual?.cancionId) ids.add(actual.cancionId);
    return ids;
  }

  // el audio de esa cancion se volvio a pedir (reintento): se descarta lo que se sabia
  function audioReintentar(token) {
    const p = participantes.get(token);
    if (!p?.cancionId) return { ok: false, error: 'Elegí una canción primero' };
    audioServidor.delete(p.cancionId);
    audioPantalla.delete(p.cancionId);
    marcar();
    emitirSiCambio();
    return { ok: true, cancionId: p.cancionId };
  }

  function empezarCountdown(p) {
    const t = ahora();
    etapa = ETAPAS.COUNTDOWN;
    p.estado = ESTADOS_P.SINGING;
    p.mensaje = null;
    actual.cancionId = p.cancionId;
    actual.modo = p.modo;
    actual.videoToken = randomBytes(16).toString('hex');
    actual.countdownHasta = t + C.COUNTDOWN_S * 1000;
    actual.cuenta = C.COUNTDOWN_S;
    onRonda && onRonda({ videoToken: actual.videoToken, rondaId: actual.rondaId });
    marcar();
  }

  function terminarInterno(p) {
    if (etapa === ETAPAS.PLAYING) {
      finalizar({ interrumpida: true, motivo: 'Terminaste la canción antes de tiempo' });
    } else if (etapa === ETAPAS.COUNTDOWN) {
      cancelarLlamado(p, 'Cancelaste tu turno');
    }
    emitirSiCambio();
    return { ok: true };
  }

  function terminar(token) {
    const p = participantes.get(token);
    if (!p || actual?.token !== token) return { ok: false, error: 'No estás cantando' };
    return terminarInterno(p);
  }

  function calcularResultado({ progreso, interrumpida, forzado, motivo }) {
    const t = ahora();
    const dur = duracionDe(actual.cancionId);
    const transcurrido = actual.playingDesde ? (t - actual.playingDesde) / 1000 : 0;
    const prog = Number.isFinite(progreso)
      ? clamp01(progreso)
      : interrumpida || forzado
        ? clamp01(transcurrido / dur)
        : 1;
    const r = actual.reacciones;
    const ponderadas = r.corazon * PESO.corazon + r.fuego * PESO.fuego + r.aplauso * PESO.aplauso;
    const cancion = Math.round(40 * prog);
    const retos = Math.min(C.RETOS_MAX, Math.round(actual.retosPuntos || 0));
    const publico = Math.min(30, Math.round((30 * ponderadas) / 20));
    return {
      total: Math.min(100, cancion + retos + publico),
      desglose: { cancion, retos, publico },
      reacciones: { ...r },
      progreso: prog,
      interrumpida: !!interrumpida,
      forzado: !!forzado,
      motivo: motivo || null,
    };
  }

  function finalizar({ progreso, interrumpida = false, forzado = false, motivo = null } = {}) {
    if (!actual || (etapa !== ETAPAS.PLAYING && etapa !== ETAPAS.COUNTDOWN)) return null;
    const p = participantes.get(actual.token);
    const resultado = calcularResultado({ progreso, interrumpida, forzado, motivo });
    actual.resultado = resultado;
    actual.resultadoHasta = ahora() + (interrumpida || forzado ? C.RESULT_INTERRUMPIDO_MS : C.RESULT_MS);
    etapa = ETAPAS.RESULT;
    if (p) {
      p.estado = ESTADOS_P.DONE;
      p.ultimoResultado = { ...resultado, cancion: cancionPublica(actual.cancionId) };
      p.ultimoVideoToken = actual.videoToken;
      p.mensaje = interrumpida || forzado ? motivo : null;
      soltarCopiloto(p, 'La performance terminó');
      p.codigoCopiloto = null;
    }
    log(`[escenario] resultado ${p?.nombre}: ${resultado.total}${interrumpida ? ' (interrumpida)' : ''}`);
    if (!interrumpida && !forzado) {
      onResultado &&
        onResultado({
          rondaId: actual.rondaId,
          videoToken: actual.videoToken,
          nombre: p?.nombre || null,
          cancion: porId(actual.cancionId),
          resultado,
        });
    }
    marcar();
    return resultado;
  }

  function cerrarResultado() {
    actual = null;
    etapa = ETAPAS.STANDBY;
    avanzar();
  }

  // ---------------------------------------------------- eventos de la pantalla
  // `reconexion`: la MISMA pagina volvio tras un corte de red (conserva su
  // cancion, su grabacion y su reloj) -> no se interrumpe nada. Una pagina
  // nueva (recarga o navegador reiniciado) no puede retomar a medio camino.
  function pantallaConectada({ camara = true, mic = true, audio = true, reconexion = false } = {}) {
    pantalla.conectada = true;
    pantalla.desconectadaDesde = null;
    if (!reconexion) {
      pantalla.camara = !!camara;
      pantalla.mic = !!mic;
      pantalla.audio = !!audio;
      pantalla.hayPersonaDesde = null;
      pantalla.ultimoTickCamara = 0;
      if (etapa === ETAPAS.COUNTDOWN || etapa === ETAPAS.PLAYING) {
        finalizar({ interrumpida: true, motivo: 'Se reinició la pantalla' });
      }
    }
    marcar();
    emitirSiCambio();
  }

  function pantallaDesconectada() {
    if (!pantalla.conectada) return;
    pantalla.conectada = false;
    pantalla.desconectadaDesde = ahora();
    marcar();
    emitirSiCambio();
  }

  function pantallaSalud({ camara, mic, audio } = {}) {
    const antes = `${pantalla.camara}${pantalla.mic}${pantalla.audio}`;
    if (typeof camara === 'boolean') pantalla.camara = camara;
    if (typeof mic === 'boolean') pantalla.mic = mic;
    if (typeof audio === 'boolean') pantalla.audio = audio;
    if (antes !== `${pantalla.camara}${pantalla.mic}${pantalla.audio}`) marcar();
    emitirSiCambio();
  }

  function pantallaPresencia(hayPersona) {
    const t = ahora();
    pantalla.ultimoTickCamara = t;
    if (hayPersona) {
      if (!pantalla.hayPersonaDesde) pantalla.hayPersonaDesde = t;
      pantalla.ultimaPersonaVista = t;
    } else {
      pantalla.hayPersonaDesde = null;
    }
  }

  // Los puntos de retos viven ACA (la pantalla puede recargarse y no se pierden):
  // cada reto se registra por id, una sola vez, hasta RETO_PUNTOS cada uno y
  // RETOS_MAX en total.
  function sumarReto(idReto, tipo, puntos) {
    if (!actual || etapa !== ETAPAS.PLAYING) return { ok: false, error: 'No se está cantando' };
    const id = String(idReto || '').slice(0, 40);
    if (!id) return { ok: false, error: 'Reto inválido' };
    if (actual.retosHechos.has(id)) return { ok: true, repetido: true, total: actual.retosPuntos };
    const p = Math.min(C.RETO_PUNTOS, Math.max(0, Math.round(Number(puntos) || 0)));
    if (!p) return { ok: false, error: 'Puntos inválidos' };
    const total = Math.min(C.RETOS_MAX, actual.retosPuntos + p);
    actual.retosHechos.set(id, total - actual.retosPuntos);
    actual.retosPuntos = total;
    log(`[escenario] reto ${tipo || ''} cumplido: +${actual.retosHechos.get(id)} (retos ${total}/${C.RETOS_MAX})`);
    marcar();
    emitirSiCambio();
    return { ok: true, total };
  }

  function pantallaRetoCumplido({ id, tipo, puntos } = {}) {
    if (!id) return { ok: false, error: 'Reto inválido' };
    return sumarReto(`g:${id}`, tipo, puntos ?? C.RETO_PUNTOS);
  }

  function pantallaFin({ progreso } = {}) {
    if (etapa !== ETAPAS.PLAYING) return null;
    const r = finalizar({ progreso });
    emitirSiCambio();
    return r;
  }

  function reinicioSeguro() {
    log('[escenario] reinicio seguro');
    if (etapa === ETAPAS.PLAYING || etapa === ETAPAS.COUNTDOWN) {
      finalizar({ interrumpida: true, motivo: 'Reinicio manual' });
      cerrarResultado();
    } else if (etapa === ETAPAS.CALLING && actual) {
      const p = participantes.get(actual.token);
      if (p) cancelarLlamado(p, 'Reinicio manual');
      else cerrarResultado();
    } else if (etapa === ETAPAS.RESULT) {
      cerrarResultado();
    } else if (etapa !== ETAPAS.STANDBY || actual) {
      actual = null;
      etapa = ETAPAS.STANDBY;
      avanzar();
    }
    marcar();
    emitirSiCambio();
  }

  // ----------------------------------------------------- reto de la palabra
  // La pantalla tapa una palabra de la letra y manda las opciones + cual es la
  // correcta. El server la guarda (nunca sale en el estado publico), recibe la
  // respuesta del cantante / copiloto (celu) o de la pantalla (mano + pellizco),
  // la compara y avisa el resultado a todos.
  const normalizar = (w) => String(w || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

  function pantallaRetoPalabra({ id, opciones, correcta, dur } = {}) {
    if (!actual || etapa !== ETAPAS.PLAYING) return { ok: false, error: 'No se está cantando' };
    if (actual.retoPalabra && !actual.retoPalabra.resuelto) return { ok: false, error: 'Ya hay un reto activo' };
    if (!Array.isArray(opciones) || opciones.length < 2 || opciones.length > 4) return { ok: false, error: 'Opciones inválidas' };
    const ops = opciones.map((o) => String(o || '').trim().slice(0, 24));
    if (ops.some((o) => !o) || new Set(ops.map(normalizar)).size !== ops.length) return { ok: false, error: 'Opciones inválidas' };
    const i = Number(correcta);
    if (!Number.isInteger(i) || i < 0 || i >= ops.length) return { ok: false, error: 'Respuesta inválida' };
    const ms = Math.min(15, Math.max(2, Number(dur) || 8)) * 1000;
    actual.retoPalabra = {
      id: String(id || aleatorio(6, ABC)).slice(0, 16),
      opciones: ops,
      correcta: i,
      hasta: ahora() + ms,
      resuelto: null,
    };
    marcar();
    emitirSiCambio();
    return { ok: true };
  }

  // ok=true si se registro la respuesta (no si acerto); `acierto` dice eso
  function resolverReto(id, opcion, quien) {
    const r = actual?.retoPalabra;
    if (!r || etapa !== ETAPAS.PLAYING) return { ok: false, error: 'No hay ningún reto activo' };
    if (r.id !== id) return { ok: false, error: 'Ese reto ya terminó' };
    if (r.resuelto) return { ok: false, error: 'Ya se respondió' };
    if (ahora() > r.hasta + 1500) return { ok: false, error: 'Se acabó el tiempo' };
    const o = Number(opcion);
    if (!Number.isInteger(o) || o < 0 || o >= r.opciones.length) return { ok: false, error: 'Opción inválida' };
    return cerrarReto(r, { opcion: o, acierto: o === r.correcta, quien });
  }

  function cerrarReto(r, { opcion = null, acierto = false, timeout = false, quien = null }) {
    r.resuelto = { opcion, acierto, timeout, quien };
    log(`[escenario] reto palabra: ${timeout ? 'sin respuesta' : acierto ? 'acertó' : 'falló'} (${quien || 'tiempo'})`);
    if (acierto) sumarReto(`p:${r.id}`, 'palabra', C.RETO_PUNTOS);
    onRetoResultado && onRetoResultado({ id: r.id, acierto, timeout, opcion, correcta: r.correcta, palabra: r.opciones[r.correcta], quien, puntos: acierto ? C.RETO_PUNTOS : 0 });
    marcar();
    emitirSiCambio();
    return { ok: true, acierto, palabra: r.opciones[r.correcta] };
  }

  function responderReto(token, { id, opcion } = {}) {
    if (!actual) return { ok: false, error: 'No se está cantando' };
    const p = participantes.get(token);
    const cantante = participantes.get(actual.token);
    const esCantante = actual.token === token;
    const esCopiloto = !!p && !!cantante && cantante.copiloto === token;
    if (!esCantante && !esCopiloto) return { ok: false, error: 'Solo responde quien canta o su copiloto' };
    return resolverReto(id, opcion, esCantante ? 'cantante' : 'copiloto');
  }

  function pantallaRetoResponder({ id, opcion } = {}) {
    return resolverReto(id, opcion, 'mano');
  }

  // la pantalla avisa que se acabo el tiempo (el tick tambien lo cierra solo)
  function pantallaRetoFin({ id } = {}) {
    const r = actual?.retoPalabra;
    if (r && r.id === id && !r.resuelto) cerrarReto(r, { timeout: true });
  }

  // ------------------------------------------------------------- reacciones
  function reaccionar(token, tipo) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (!PESO[tipo]) return { ok: false, error: 'Reacción inválida' };
    const t = ahora();
    if (t - p.ultimaReaccion < C.REACC_MIN_MS) return { ok: false, limitada: true };
    p.ultimaReaccion = t;
    p.ultimaActividad = t;
    let contada = false;
    if (etapa === ETAPAS.PLAYING && actual && actual.token !== token) {
      const usadas = actual.porPersona.get(token) || 0;
      if (usadas < C.REACC_MAX_POR_PERSONA) {
        actual.porPersona.set(token, usadas + 1);
        actual.reacciones[tipo] += 1;
        contada = true;
      }
    }
    // no se marca "sucio": las reacciones viajan en su propio evento con totales
    return {
      ok: true,
      contada,
      tipo,
      nombre: p.nombre || null,
      totales: actual ? { ...actual.reacciones } : reaccionesVacias(),
    };
  }

  // -------------------------------------------------------------- copiloto
  function unirseCopiloto(token, codigo) {
    const p = participantes.get(token);
    if (!p) return { ok: false, error: 'Sesión no encontrada' };
    if (p.estado === ESTADOS_P.QUEUED || p.estado === ESTADOS_P.CALLED || p.estado === ESTADOS_P.SINGING) {
      return { ok: false, error: 'Ya estás participando como cantante' };
    }
    const c = String(codigo || '').trim().toUpperCase();
    const cantante = [...participantes.values()].find(
      (x) =>
        x.codigoCopiloto === c &&
        (x.estado === ESTADOS_P.QUEUED || x.estado === ESTADOS_P.CALLED || x.estado === ESTADOS_P.SINGING)
    );
    if (!c || !cantante) return { ok: false, error: 'Código incorrecto' };
    if (cantante.copiloto && cantante.copiloto !== token) {
      return { ok: false, error: 'Esa persona ya tiene copiloto' };
    }
    if (p.copilotoDe && p.copilotoDe !== cantante.token) {
      const anterior = participantes.get(p.copilotoDe);
      if (anterior && anterior.copiloto === token) anterior.copiloto = null;
    }
    cantante.copiloto = token;
    p.copilotoDe = cantante.token;
    p.mensaje = null;
    marcar();
    emitirSiCambio();
    return { ok: true, cantante: cantante.nombre };
  }

  function salirCopiloto(token) {
    const p = participantes.get(token);
    if (!p || !p.copilotoDe) return { ok: true };
    const s = participantes.get(p.copilotoDe);
    if (s && s.copiloto === token) s.copiloto = null;
    p.copilotoDe = null;
    marcar();
    emitirSiCambio();
    return { ok: true };
  }

  // ------------------------------------------------------------------ ETA
  function restanteActualSeg(t) {
    if (etapa === ETAPAS.STANDBY || !actual) return 0;
    const dur = duracionDe(actual.cancionId);
    const res = C.RESULT_MS / 1000;
    if (etapa === ETAPAS.CALLING) return C.CALLING_TIPICO_S + C.COUNTDOWN_S + dur + res;
    if (etapa === ETAPAS.COUNTDOWN) return Math.max(0, (actual.countdownHasta - t) / 1000) + dur + res;
    if (etapa === ETAPAS.PLAYING) return Math.max(0, dur - (t - actual.playingDesde) / 1000) + res;
    return Math.max(0, (actual.resultadoHasta - t) / 1000);
  }

  function etasFila(t) {
    const out = [];
    const res = C.RESULT_MS / 1000;
    let acum = restanteActualSeg(t) + (etapa === ETAPAS.STANDBY ? 0 : C.CALLING_TIPICO_S);
    for (const token of fila) {
      out.push(redondear10(acum));
      const p = participantes.get(token);
      acum += duracionDe(p?.cancionId) + C.COUNTDOWN_S + res + C.CALLING_TIPICO_S;
    }
    return out;
  }

  // ------------------------------------------------------------- snapshots
  function filaPublica(t) {
    const etas = etasFila(t);
    return fila.map((token, i) => {
      const p = participantes.get(token);
      return {
        id: p?.id,
        nombre: p?.nombre || 'Alguien',
        cancion: p?.cancionId ? { titulo: porId(p.cancionId)?.titulo, artista: porId(p.cancionId)?.artista } : null,
        cancionId: p?.cancionId || null,
        audio: p ? audioDeParticipante(p) : null,
        modo: p?.modo || 'solo',
        conectado: p ? p.conectado : false,
        etaSeg: etas[i],
      };
    });
  }

  function retoPublico() {
    const r = actual?.retoPalabra;
    if (!r || r.resuelto || etapa !== ETAPAS.PLAYING) return null;
    return { id: r.id, opciones: r.opciones, hasta: r.hasta };
  }

  function actualPublico() {
    if (!actual) return null;
    const p = participantes.get(actual.token);
    return {
      id: p?.id || null,
      nombre: p?.nombre || 'Alguien',
      cancion: cancionPublica(actual.cancionId),
      audio: audioDe(actual.cancionId),
      modo: actual.modo,
      copiloto: (p?.copiloto && participantes.get(p.copiloto)?.nombre) || null,
      fase: etapa === ETAPAS.CALLING ? 'eligiendo' : null,
      preparada: !!actual.cancionId,
      llamadoDesde: actual.llamadoDesde,
      llamadoHasta: actual.llamadoHasta,
      countdownHasta: actual.countdownHasta,
      cuenta: actual.cuenta,
      playingDesde: actual.playingDesde,
      retoPalabra: retoPublico(),
      retosPuntos: actual.retosPuntos,
      resultado: actual.resultado,
    };
  }

  function snapshot() {
    const t = ahora();
    const lista = filaPublica(t);
    return {
      v: 1,
      serverNow: t,
      etapa,
      actual: actualPublico(),
      siguiente: lista[0] ? { id: lista[0].id, nombre: lista[0].nombre, cancion: lista[0].cancion, cancionId: lista[0].cancionId, audio: lista[0].audio } : null,
      filaTotal: lista.length,
      fila: lista,
      reacciones: actual ? { ...actual.reacciones } : reaccionesVacias(),
      pantalla: { conectada: pantalla.conectada, camara: pantalla.camara, mic: pantalla.mic, audio: pantalla.audio },
    };
  }

  // lo que solo ve la pantalla primaria (el token del video es privado)
  function privadoPantalla() {
    return { videoToken: etapa === ETAPAS.RESULT && actual ? actual.videoToken : null, rondaId: actual?.rondaId || null };
  }

  function yo(token) {
    const p = participantes.get(token);
    if (!p) return null;
    const t = ahora();
    const idx = fila.indexOf(token);
    const etas = idx >= 0 ? etasFila(t) : null;
    const enJuego = [ESTADOS_P.QUEUED, ESTADOS_P.CALLED, ESTADOS_P.SINGING].includes(p.estado);
    const singer = p.copilotoDe ? participantes.get(p.copilotoDe) : null;
    return {
      id: p.id,
      nombre: p.nombre,
      estado: p.estado,
      posicion: idx >= 0 ? idx + 1 : null,
      etaSeg: etas ? etas[idx] : null,
      esSiguiente: idx === 0,
      cancionId: p.cancionId,
      cancion: cancionPublica(p.cancionId),
      modo: p.modo,
      codigoCopiloto: enJuego ? p.codigoCopiloto : null,
      copiloto: p.copiloto ? { nombre: participantes.get(p.copiloto)?.nombre || 'Copiloto' } : null,
      copilotoDe: singer ? { nombre: singer.nombre, estado: singer.estado } : null,
      audio: audioDeParticipante(p),
      mensaje: p.mensaje,
      resultado: p.estado === ESTADOS_P.DONE ? p.ultimoResultado : null,
      videoToken: p.estado === ESTADOS_P.DONE ? p.ultimoVideoToken : null,
    };
  }

  // ------------------------------------------------------------- watchdog
  const camaraSana = (t) => pantalla.conectada && pantalla.camara && t - pantalla.ultimoTickCamara < 5000;

  function tick() {
    const t = ahora();

    // 1) participantes desconectados: gracia segun lo que estaban haciendo
    for (const p of [...participantes.values()]) {
      if (p.conectado || p.desconectadoDesde == null) continue;
      const off = t - p.desconectadoDesde;
      if (p.estado === ESTADOS_P.QUEUED && off > C.EN_FILA_DESCONEXION_MS) {
        quitarDeFila(p);
        p.mensaje = 'Saliste de la fila por inactividad';
      } else if (p.estado === ESTADOS_P.CALLED && actual?.token === p.token && off > C.CALLED_DESCONEXION_MS) {
        cancelarLlamado(p, 'No te encontramos: perdiste tu turno');
      } else if (
        p.estado === ESTADOS_P.SINGING &&
        actual?.token === p.token &&
        (etapa === ETAPAS.COUNTDOWN || etapa === ETAPAS.PLAYING) &&
        off > C.CANTANTE_DESCONEXION_MS
      ) {
        finalizar({ interrumpida: true, motivo: 'Se perdió la conexión' });
      } else if (
        (p.estado === ESTADOS_P.PUBLIC || p.estado === ESTADOS_P.DONE) &&
        off > C.PUBLICO_RETENCION_MS
      ) {
        eliminarParticipante(p);
      }
    }

    // 2) el escenario
    if ((etapa === ETAPAS.COUNTDOWN || etapa === ETAPAS.PLAYING) && actual) {
      if (!pantalla.conectada && pantalla.desconectadaDesde != null && t - pantalla.desconectadaDesde > C.PANTALLA_DESCONEXION_MS) {
        finalizar({ interrumpida: true, motivo: 'Se cayó la pantalla' });
      }
    }

    switch (etapa) {
      case ETAPAS.STANDBY:
        // hay gente esperando pero nadie en el escenario: nunca nos quedamos en STANDBY
        if (fila.length) avanzar();
        break;

      case ETAPAS.CALLING: {
        const p = actual && participantes.get(actual.token);
        if (!p) {
          actual = null;
          etapa = ETAPAS.STANDBY;
          avanzar();
        } else if (t >= actual.llamadoHasta) {
          // si lo unico que falta es que se termine de preparar el audio, no se pierde el
          // turno por eso (hasta AUDIO_ESPERA_MS); si el audio esta roto, se libera
          const a = audioDe(actual.cancionId);
          const esperable = a.estado === 'preparando' || a.estado === 'bloqueado';
          if (esperable && t < actual.llamadoDesde + C.AUDIO_ESPERA_MS) {
            actual.llamadoHasta = t + 5_000;
            marcar();
          } else {
            cancelarLlamado(p, a.estado === 'lista' || a.estado === 'sin_cancion'
              ? 'Se acabó el tiempo: perdiste tu turno'
              : 'No se pudo preparar el audio de tu canción: probá con otra');
          }
        }
        break;
      }

      case ETAPAS.COUNTDOWN: {
        const cuenta = Math.max(1, Math.ceil((actual.countdownHasta - t) / 1000));
        if (t >= actual.countdownHasta) {
          etapa = ETAPAS.PLAYING;
          actual.playingDesde = t;
          actual.cuenta = null;
          pantalla.ultimaPersonaVista = t;
          marcar();
        } else if (cuenta !== actual.cuenta) {
          actual.cuenta = cuenta;
          marcar();
        }
        break;
      }

      case ETAPAS.PLAYING: {
        const rp = actual.retoPalabra;
        if (rp && !rp.resuelto && t > rp.hasta + 1500) cerrarReto(rp, { timeout: true });
        const dur = duracionDe(actual.cancionId) * 1000;
        if (t - actual.playingDesde > dur + C.PLAYING_EXTRA_MS) {
          finalizar({ forzado: true, motivo: 'La canción no terminó a tiempo' });
        } else if (
          camaraSana(t) &&
          t - actual.playingDesde > C.SIN_PERSONA_MS &&
          t - pantalla.ultimaPersonaVista > C.SIN_PERSONA_MS
        ) {
          finalizar({ interrumpida: true, motivo: 'No había nadie en cámara' });
        }
        break;
      }

      case ETAPAS.RESULT:
        if (actual && t >= actual.resultadoHasta) cerrarResultado();
        break;
    }

    emitirSiCambio();
  }

  return {
    // identidad / fila
    hola,
    desconectar,
    entrarFila,
    salirFila,
    elegirCancion,
    elegirModo,
    listo,
    terminar,
    reaccionar,
    unirseCopiloto,
    salirCopiloto,
    // pantalla
    pantallaConectada,
    pantallaDesconectada,
    pantallaSalud,
    pantallaPresencia,
    pantallaRetoCumplido,
    pantallaRetoPalabra,
    pantallaRetoResponder,
    pantallaRetoFin,
    responderReto,
    audioServidorEstado,
    pantallaAudio,
    pantallaAudioFallo,
    audioReintentar,
    cancionesEnUso,
    pantallaFin,
    reinicioSeguro,
    // lectura
    snapshot,
    privadoPantalla,
    yo,
    tick,
    participantesConectados: () => [...participantes.values()].filter((p) => p.conectado).map((p) => p.token),
    get etapa() { return etapa; },
    get config() { return C; },
  };
}
