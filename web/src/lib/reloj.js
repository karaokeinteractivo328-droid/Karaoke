// Reloj de la cancion: UNA sola fuente de verdad para la letra, los retos, la
// barra de progreso y el fin.
//
// Antes la letra usaba un temporizador propio desde que arrancaba PLAYING y
// "saltaba" al audio cuando este empezaba a sonar: si el audio tardaba en
// cargar (Supabase, wifi lenta) la letra salia ADELANTADA y despues pegaba un
// salto; lo mismo en cada pausa o buffering. Ahora:
//
//   'espera'  el audio todavia no suena -> el tiempo NO avanza (la letra queda
//             en el comienzo, no se adelanta)
//   'audio'   suena -> el tiempo ES audio.currentTime (se interpola entre
//             actualizaciones, porque algunos navegadores lo actualizan de a saltos)
//   'interno' no hay audio utilizable (o no sono en esperaMaxMs) -> reloj propio
//             desde ese momento, para que el show no se quede trabado
//
// letra(offset) = tiempo de LETRA = audio - offsetLetra - latencia de salida
//                 + un pequeno anticipo (la letra se lee un instante antes de cantarla).

export const ANTICIPO_LETRA = 0.1; // s

export function crearReloj({ audio, ahora = () => performance.now(), latencia = () => 0, esperaMaxMs = 6000 } = {}) {
  let modo = 'espera';
  let inicio = 0;
  let t0Interno = 0;
  let muestra = { t: -1, en: 0 };
  let conAudio = false;

  function iniciar({ conAudio: hayAudio }) {
    conAudio = !!hayAudio;
    inicio = ahora();
    muestra = { t: -1, en: 0 };
    modo = conAudio ? 'espera' : 'interno';
    t0Interno = inicio;
  }

  // el elemento <audio> empezo a sonar de verdad (evento 'playing')
  function alReproducir() {
    if (!conAudio) return;
    modo = 'audio';
    muestra = { t: -1, en: 0 };
  }

  function pasarAInterno() {
    modo = 'interno';
    t0Interno = ahora();
  }

  // si el audio no sono a tiempo, seguimos con el reloj propio
  function revisar() {
    if (modo === 'espera' && conAudio && ahora() - inicio > esperaMaxMs) pasarAInterno();
  }

  // segundos de AUDIO transcurridos
  function base() {
    revisar();
    if (modo === 'espera') return 0;
    if (modo === 'interno') return Math.max(0, (ahora() - t0Interno) / 1000);
    const ct = audio.currentTime || 0;
    const t = ahora();
    if (ct !== muestra.t) {
      muestra = { t: ct, en: t };
      return ct;
    }
    // currentTime no cambio desde la ultima lectura: interpolamos un poquito
    // (nunca mas de 100 ms, y no si esta en pausa/buffering)
    if (audio.paused || audio.ended || audio.readyState < 3) return ct;
    return ct + Math.min(0.1, ((t - muestra.en) / 1000) * (audio.playbackRate || 1));
  }

  const letra = (offset = 0) => base() - offset - Math.min(0.3, latencia() || 0) + ANTICIPO_LETRA;

  return {
    iniciar,
    alReproducir,
    base,
    letra,
    get modo() {
      revisar();
      return modo;
    },
  };
}
