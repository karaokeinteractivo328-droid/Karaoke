// Reproductor EMBEBIDO de YouTube (IFrame Player API): es el unico mecanismo de reproduccion
// que usa el proyecto para las canciones de YouTube. No se descarga ni se extrae audio: la
// cancion es un `videoId` y suena dentro del reproductor oficial, que tiene que estar VISIBLE
// (YouTube exige un minimo de 200x200 px y que no este tapado).
//
// Lo que se ve de afuera es un ADAPTADOR con la misma forma que un <audio>
// (currentTime / paused / ended / readyState / duration / playbackRate): asi reloj.js sigue
// siendo la UNICA fuente de tiempo para la letra, los retos y el progreso, sin duplicar logica.

import { logAudio, errorAudio } from './audioLog.js';

export const ESTADO = { SIN_EMPEZAR: -1, TERMINADO: 0, REPRODUCIENDO: 1, PAUSADO: 2, CARGANDO: 3, LISTO: 5 };

// codigos de error de la IFrame API -> que le decimos a la persona
export const ERRORES = {
  2: 'el identificador del video no es válido',
  5: 'el reproductor de YouTube tuvo un error',
  100: 'el video ya no existe o es privado',
  101: 'el dueño del video no permite reproducirlo fuera de YouTube',
  150: 'el dueño del video no permite reproducirlo fuera de YouTube',
};

let promesaApi = null;
export function cargarApiYouTube({ win = globalThis.window, doc = globalThis.document, timeoutMs = 15_000 } = {}) {
  if (win?.YT?.Player) return Promise.resolve(win.YT);
  if (promesaApi) return promesaApi;
  promesaApi = new Promise((resolve, reject) => {
    const t = setTimeout(() => { promesaApi = null; reject(new Error('el reproductor de YouTube tardó demasiado en cargar')); }, timeoutMs);
    const previo = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      clearTimeout(t);
      previo?.();
      resolve(win.YT);
    };
    const s = doc.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { clearTimeout(t); promesaApi = null; reject(new Error('no se pudo cargar el reproductor de YouTube (¿sin Internet?)')); };
    doc.head.append(s);
  });
  // se guarda solo mientras esta pendiente (varios llamados a la vez comparten un unico script)
  promesaApi.then(() => { promesaApi = null; }, () => { promesaApi = null; });
  return promesaApi;
}

// Crea el reproductor dentro de `elementoId` (un <div> vacio que YouTube reemplaza por el iframe).
export function crearReproductorYouTube({ YT, elementoId, ancho = 640, alto = 360, origen, onEstado = () => {}, onError = () => {}, espera = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let player = null;
  let estado = ESTADO.SIN_EMPEZAR;
  let videoId = null;
  let calentado = null; // videoId que ya se cargo en silencio durante la cuenta regresiva
  let esperando = []; // callbacks que esperan un estado

  const listo = new Promise((resolve, reject) => {
    try {
      player = new YT.Player(elementoId, {
        width: ancho,
        height: alto,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, enablejsapi: 1, origin: origen },
        events: {
          onReady: () => { logAudio('reproductor de YouTube listo'); resolve(); },
          onStateChange: (e) => {
            estado = e.data;
            esperando = esperando.filter((w) => !w(estado));
            onEstado(estado);
          },
          onError: (e) => {
            const mensaje = ERRORES[e.data] || `error ${e.data} del reproductor de YouTube`;
            errorAudio(`YouTube: ${mensaje} (código ${e.data}, video ${videoId})`);
            esperando.forEach((w) => w(null, mensaje));
            esperando = [];
            onError({ codigo: e.data, mensaje });
          },
        },
      });
    } catch (e) {
      reject(e);
    }
  });

  // espera un estado; rechaza si pasa `ms` o si hay un error
  function esperarEstado(buscado, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { esperando = esperando.filter((w) => w !== chequeo); reject(Object.assign(new Error('timeout'), { codigo: 'timeout' })); }, ms);
      const chequeo = (actual, errorMsg) => {
        if (errorMsg) { clearTimeout(t); reject(Object.assign(new Error(errorMsg), { codigo: 'error' })); return true; }
        if (buscado(actual)) { clearTimeout(t); resolve(actual); return true; }
        return false;
      };
      if (buscado(estado)) { clearTimeout(t); return resolve(estado); }
      esperando.push(chequeo);
    });
  }

  // Durante la cuenta regresiva: se carga el video EN SILENCIO, arranca a buffer y se deja en pausa,
  // asi cuando empieza la cancion ya esta en memoria del reproductor (el 3-2-1 ya sirvio de carga).
  async function precalentar(id, { ms = 8000 } = {}) {
    await listo;
    videoId = id;
    player.mute();
    player.loadVideoById({ videoId: id, startSeconds: 0 });
    try {
      await esperarEstado((s) => s === ESTADO.REPRODUCIENDO, ms);
      player.pauseVideo();
      player.seekTo(0, true);
      calentado = id;
      logAudio(`YouTube ${id}: precalentado durante la cuenta regresiva`);
    } catch (e) {
      calentado = null;
      errorAudio(`YouTube ${id}: no se pudo precalentar (${e.message}); se carga al empezar`);
    }
  }

  // Empieza a sonar. Si el navegador bloquea el autoplay con sonido, rechaza con codigo 'autoplay'.
  async function reproducir(id, { ms = 8000 } = {}) {
    await listo;
    videoId = id;
    if (calentado === id) {
      player.seekTo(0, true);
    } else {
      player.loadVideoById({ videoId: id, startSeconds: 0 });
    }
    player.unMute();
    player.setVolume(100);
    player.playVideo();
    try {
      await esperarEstado((s) => s === ESTADO.REPRODUCIENDO, ms);
    } catch (e) {
      if (e.codigo === 'timeout') throw Object.assign(new Error('el navegador bloqueó la reproducción con sonido (autoplay) o YouTube no respondió'), { codigo: 'autoplay' });
      throw e;
    }
    calentado = null;
    logAudio(`YouTube ${id}: play() OK · volumen ${player.getVolume?.()} · muted ${player.isMuted?.()}`);
  }

  function restaurarSonido() {
    player?.unMute?.();
    player?.setVolume?.(100);
  }

  function detener() {
    try { player?.stopVideo?.(); } catch {}
    calentado = null;
    esperando = [];
  }

  // Misma forma que un <audio>: lo que usa reloj.js
  const adaptador = {
    get currentTime() { try { return Number(player?.getCurrentTime?.()) || 0; } catch { return 0; } },
    set currentTime(v) { try { player?.seekTo?.(v, true); } catch {} },
    get duration() { try { return Number(player?.getDuration?.()) || 0; } catch { return 0; } },
    get paused() { return estado !== ESTADO.REPRODUCIENDO && estado !== ESTADO.CARGANDO; },
    get ended() { return estado === ESTADO.TERMINADO; },
    get readyState() { return estado === ESTADO.REPRODUCIENDO ? 4 : estado === ESTADO.CARGANDO ? 2 : 1; },
    playbackRate: 1,
    get volume() { try { return (player?.getVolume?.() ?? 100) / 100; } catch { return 1; } },
    get muted() { try { return !!player?.isMuted?.(); } catch { return false; } },
    get error() { return null; },
    pause() { try { player?.pauseVideo?.(); } catch {} },
  };

  return {
    listo,
    precalentar,
    reproducir,
    detener,
    restaurarSonido,
    adaptador,
    get estado() { return estado; },
    get videoId() { return videoId; },
    get calentado() { return calentado; },
    destruir() { try { player?.destroy?.(); } catch {} },
  };
}
