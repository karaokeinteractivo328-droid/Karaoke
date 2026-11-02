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
  let analizadorMic = null; // mide el nivel del micro (para saber si alguien canta)
  let analizadorVoz = null; // idem, pero con un micro SIN control automatico de ganancia (mide mejor; si hay, se usa este)
  let datosMic = null;
  let espectroMic = null;
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
      analizadorMic = crearAnalizador();
      m.connect(analizadorMic);
      micConectado = true;
    } catch (e) {
      console.warn('[audioBus] mic:', e.message);
    }
  }

  function crearAnalizador() {
    const a = actx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.3;
    datosMic ||= new Float32Array(a.fftSize);
    espectroMic ||= new Float32Array(a.frequencyBinCount);
    return a;
  }

  // Segundo micro solo para MEDIR (no va a la grabacion ni a los parlantes). El del navegador trae control
  // automatico de ganancia: sube el volumen en el silencio y lo baja apenas alguien canta, y eso confunde al
  // detector de voz. Este se pide sin ese control.
  function agregarMicAnalisis(stream) {
    if (!actx || analizadorVoz || !stream?.getAudioTracks?.().length) return false;
    try {
      const m = actx.createMediaStreamSource(stream);
      analizadorVoz = crearAnalizador();
      m.connect(analizadorVoz);
      return true;
    } catch (e) {
      console.warn('[audioBus] mic de analisis:', e.message);
      return false;
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

  // Nivel del micro (RMS 0..1) o null si no hay micro. Es lo que llega DESPUES de la cancelacion de eco del
  // navegador, o sea: la voz de la gente mas lo poco de musica que se cuele.
  function nivelMic() {
    return analisisMic()?.rms ?? null;
  }

  // { rms, proporcion } del micro: rms = volumen (0..1); proporcion = que parte de la energia cae en la banda de la
  // voz (200-3400 Hz) respecto de todo lo audible. null si no hay micro.
  function analisisMic() {
    const a = analizadorVoz || analizadorMic;
    if (!a || actx?.state !== 'running') return null;
    a.getFloatTimeDomainData(datosMic);
    let suma = 0;
    for (let i = 0; i < datosMic.length; i++) suma += datosMic[i] * datosMic[i];
    const rms = Math.sqrt(suma / datosMic.length);
    a.getFloatFrequencyData(espectroMic);
    const hzPorBin = actx.sampleRate / a.fftSize;
    let voz = 0;
    let total = 0;
    for (let i = 1; i < espectroMic.length; i++) {
      const hz = i * hzPorBin;
      if (hz < 60 || hz > 12000) continue;
      const p = 10 ** (espectroMic[i] / 10); // dB -> potencia (-Infinity = 0)
      total += p;
      if (hz >= 200 && hz <= 3400) voz += p;
    }
    return { rms, proporcion: total > 0 ? voz / total : 0 };
  }

  return {
    tick,
    nivelMic,
    analisisMic,
    agregarMic,
    agregarMicAnalisis,
    desbloquear,
    streamGrabacion: () => salidaGrab?.stream || null,
    get contexto() { return actx; },
  };
}
