// Un único grafo de Web Audio para toda la app (createMediaElementSource se
// puede llamar UNA sola vez por elemento):
//   <audio de la canción> --> parlantes  + analizador (energía)  + grabación
//   micrófono             -->                                      grabación
//
// energia()          -> 0..1 para el latido de la estrella
// streamGrabacion()  -> MediaStream de audio (canción + voz) para MediaRecorder
// desbloquear()      -> resume() del AudioContext (necesita un gesto del usuario)

// Mezcla de la GRABACION (los parlantes no se tocan): la musica baja y la voz sube, con un
// compresor al final para que la voz fuerte no sature.
export const GANANCIA_MUSICA_GRABACION = 0.3;
export const GANANCIA_VOZ_GRABACION = 2.4;

export function crearAudioBus(audioEl) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let actx = null;
  let analyser = null;
  let datos = null;
  let salidaGrab = null;
  let micConectado = false;
  let mezcla = null; // entrada comun de la grabacion (compresor -> salidaGrab)
  let gananciaMusica = null;
  let gananciaVoz = null;
  let energiaSuave = 0;

  if (AC) {
    actx = new AC();
    const src = actx.createMediaElementSource(audioEl);
    analyser = actx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.85;
    datos = new Uint8Array(analyser.frequencyBinCount);
    salidaGrab = actx.createMediaStreamDestination();
    mezcla = actx.createDynamicsCompressor();
    mezcla.threshold.value = -16;
    mezcla.knee.value = 12;
    mezcla.ratio.value = 5;
    mezcla.attack.value = 0.004;
    mezcla.release.value = 0.2;
    const margen = actx.createGain(); // ~-2 dB de margen para que la voz fuerte no llegue a 0 dB
    margen.gain.value = 0.8;
    mezcla.connect(margen);
    margen.connect(salidaGrab);
    gananciaMusica = actx.createGain();
    gananciaMusica.gain.value = GANANCIA_MUSICA_GRABACION;
    gananciaVoz = actx.createGain();
    gananciaVoz.gain.value = GANANCIA_VOZ_GRABACION;
    gananciaMusica.connect(mezcla);
    gananciaVoz.connect(mezcla);

    src.connect(analyser);
    src.connect(actx.destination); // suena por los parlantes (a volumen normal)
    src.connect(gananciaMusica); // y entra a la grabación mas baja que la voz
  }

  const desbloquear = () => actx?.resume?.();
  addEventListener('pointerdown', desbloquear);
  addEventListener('keydown', desbloquear);

  function agregarMic(stream) {
    if (!actx || micConectado || !stream?.getAudioTracks?.().length) return;
    try {
      const m = actx.createMediaStreamSource(stream);
      m.connect(gananciaVoz); // el mic SOLO va a la grabación (no a los parlantes -> sin acople)
      micConectado = true;
    } catch (e) {
      console.warn('[audioBus] mic:', e.message);
    }
  }

  function tick() {
    let e = 0;
    if (analyser) {
      analyser.getByteFrequencyData(datos);
      for (let i = 0; i < datos.length; i++) e += datos[i];
      e = e / datos.length / 255;
    }
    energiaSuave += (e - energiaSuave) * 0.15;
    return energiaSuave;
  }

  return {
    tick,
    agregarMic,
    desbloquear,
    streamGrabacion: () => salidaGrab?.stream || null,
    get contexto() { return actx; },
  };
}
