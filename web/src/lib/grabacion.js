// Graba un MediaStream de video (el canvas compuesto: cámara + letra) + un
// MediaStream de audio (canción + voz, mezclados por audioBus) -> Blob webm.
// El server lo pasa a .mp4 con ffmpeg.

export function crearGrabacion() {
  let rec = null;
  let chunks = [];
  let blob = null;

  function mimeSoportado() {
    return (
      ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
        (m) => window.MediaRecorder?.isTypeSupported?.(m)
      ) || ''
    );
  }

  function iniciar(videoStream, audioStream) {
    if (!window.MediaRecorder) return;
    // una grabacion anterior que quedo colgada no puede bloquear la siguiente
    if (rec && rec.state === 'inactive') rec = null;
    if (rec) {
      try { rec.stop(); } catch {}
      rec = null;
    }
    const vt = videoStream?.getVideoTracks?.()[0];
    if (!vt) return;
    const at = audioStream?.getAudioTracks?.() || [];
    const grab = new MediaStream([vt, ...at]);

    chunks = [];
    blob = null;
    try {
      const mimeType = mimeSoportado();
      rec = new MediaRecorder(grab, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    } catch (err) {
      console.warn('[grabacion] MediaRecorder:', err.message);
      return;
    }
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    rec.start(1000);
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
        const b = chunks.length ? new Blob(chunks, { type: chunks[0]?.type || 'video/webm' }) : null;
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
    get grabando() { return rec?.state === 'recording'; },
  };
}
