// Graba un MediaStream de video (el canvas compuesto: cámara + letra) + un
// MediaStream de audio (canción + voz, mezclados por audioBus) -> Blob webm.
// El server lo pasa a .mp4 con ffmpeg.

export function crearGrabacion() {
  let rec = null;
  let chunks = [];
  let blob = null;
  let diag = { motivo: 'nunca se inicio' }; // por que no hay video (para el log de la pantalla)
  let inicioMs = 0;
  let duracionS = 0; // cuanto duro la ultima grabacion (el server la usa para mostrar el progreso)

  // MP4 (H.264 + AAC) directo cuando el navegador puede (Chrome >= 126): el server solo lo "empaqueta"
  // en milisegundos. Con webm, el server tiene que RECODIFICAR (lento en un servidor gratuito).
  function mimeSoportado() {
    return (
      [
        'video/mp4;codecs=avc1.640028,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || ''
    );
  }

  function iniciar(videoStream, audioStream) {
    if (!window.MediaRecorder) { diag = { motivo: 'este navegador no tiene MediaRecorder' }; return; }
    // una grabacion anterior que quedo colgada no puede bloquear la siguiente
    if (rec && rec.state === 'inactive') rec = null;
    if (rec) {
      try { rec.stop(); } catch {}
      rec = null;
    }
    const vt = videoStream?.getVideoTracks?.()[0];
    if (!vt) { diag = { motivo: 'el canvas no entrego pista de video' }; return; }
    const at = audioStream?.getAudioTracks?.() || [];
    const grab = new MediaStream([vt, ...at]);

    chunks = [];
    blob = null;
    try {
      const mimeType = mimeSoportado();
      rec = new MediaRecorder(grab, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    } catch (err) {
      console.warn('[grabacion] MediaRecorder:', err.message);
      diag = { motivo: 'MediaRecorder fallo: ' + err.message };
      return;
    }
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    rec.onerror = (e) => { diag = { motivo: 'error del grabador: ' + (e.error?.message || e.type) }; };
    rec.start(1000);
    inicioMs = performance.now();
    diag = { motivo: 'grabando', mime: rec.mimeType, audio: at.length > 0 };
  }

  function detener() {
    return new Promise((resolve) => {
      // sin grabacion en curso no hay nada que entregar (y jamas devolvemos el
      // blob de la performance anterior para subirlo con el token de otra)
      if (!rec || rec.state === 'inactive') return resolve(null);
      let listo = false;
      const entregar = () => {
        if (listo) return;
        listo = true;
        clearTimeout(seguridad);
        duracionS = inicioMs ? (performance.now() - inicioMs) / 1000 : 0;
        const b = chunks.length ? new Blob(chunks, { type: chunks[0]?.type || rec?.mimeType || 'video/webm' }) : null;
        rec = null;
        chunks = [];
        resolve(b);
      };
      // si el navegador nunca dispara 'stop' no nos quedamos esperando para siempre
      const seguridad = setTimeout(entregar, 5000);
      rec.onstop = entregar;
      try { rec.stop(); } catch { entregar(); }
    });
  }

  return {
    iniciar,
    detener,
    get blob() { return blob; },
    get duracion() { return duracionS; },
    get grabando() { return rec?.state === 'recording'; },
    get diagnostico() { return { ...diag, trozos: chunks.length }; },
  };
}
