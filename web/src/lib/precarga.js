// PRECARGA del audio de las canciones que van a sonar (la actual y la que sigue).
//
// Una cancion NO esta "lista" porque exista una URL. Esta lista cuando:
//   1. el server la tiene (la bajo y la valido),
//   2. este navegador la DESCARGO ENTERA (queda en memoria: al empezar no hay red),
//   3. un elemento <audio> aparte la pudo CARGAR y DECODIFICAR (metadata, duracion real,
//      canplaythrough) y la duracion coincide con la esperada,
//   4. play() funciona sobre ella (probado en silencio),
//   5. la letra tambien llego.
// Recien ahi avisa `onEstado(id, 'lista')`. Cualquier fallo avisa 'error' con el motivo.
//
// Si la persona cambia de cancion, `apuntar()` cancela la descarga vieja y arranca la nueva.
//
// Canciones de YouTube: NO se descarga nada (suenan en el reproductor embebido). Para esas,
// "lista" = el server verifico con la API que se puede reproducir + el reproductor de YouTube
// de ESTA pantalla esta cargado y listo (`prepararYouTube`). La letra sincronizada es opcional.

import { logAudio, logCancion, errorAudio } from './audioLog.js';

const ESPERA_SERVIDOR_MS = 150_000;
const SONDEO_MS = 2_000;

export function crearPrecarga({
  base = '',
  fetchFn = (...a) => globalThis.fetch(...a),
  crearAudio = () => new Audio(),
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  onEstado = () => {},
  max = 3,
  prepararYouTube = async () => { throw new Error('esta pantalla no tiene reproductor de YouTube'); },
  esperaServidorMs = ESPERA_SERVIDOR_MS,
  sondeoMs = SONDEO_MS,
} = {}) {
  const jobs = new Map(); // id -> { id, estado, motivo, etapa, meta, lrc, blobUrl, ctl }
  let objetivos = [];
  let protegido = new Set(); // ids que suenan ahora (no se sueltan)

  const url = (u) => (/^https?:\/\//.test(u) ? u : `${base}${u}`);

  function poner(job, estado, motivo = null, etapa = null) {
    if (job.estado === estado && job.motivo === motivo && job.etapa === etapa) return;
    job.estado = estado;
    job.motivo = motivo;
    job.etapa = etapa;
    if (estado === 'lista') logAudio(`${job.id}: LISTA (precargada y reproducible)`);
    else if (estado === 'error') errorAudio(`${job.id}: ${motivo}`);
    onEstado(job.id, estado, motivo, etapa);
  }

  async function traerMeta(job) {
    const limite = Date.now() + esperaServidorMs;
    for (;;) {
      if (job.ctl.signal.aborted) throw new Cancelado();
      const r = await fetchFn(`${base}/api/cancion/${encodeURIComponent(job.id)}`, { signal: job.ctl.signal });
      if (!r.ok) throw new Error(`el server no conoce esa canción (${r.status})`);
      const meta = await r.json();
      if (meta.audioEstado === 'error') throw new Error(meta.audioMotivo || 'el server no pudo preparar el audio');
      if (meta.audioEstado === 'lista') return meta;
      logCancion(`${job.id}: el server todavía prepara el audio (${meta.audioEstado})`);
      poner(job, 'preparando', null, 'servidor');
      if (Date.now() > limite) throw new Error('el server tardó demasiado en preparar el audio');
      await esperar(sondeoMs);
    }
  }

  // Cargar de verdad en un <audio>: asi se sabe que el navegador lo decodifica.
  function probar(blobUrl, meta, signal) {
    return new Promise((resolve, reject) => {
      const a = crearAudio();
      let listo = false;
      const fin = (err) => {
        if (listo) return;
        listo = true;
        clearTimeout(t);
        a.onerror = a.oncanplaythrough = a.onloadedmetadata = null;
        try { a.pause?.(); a.removeAttribute?.('src'); } catch {}
        err ? reject(err) : resolve();
      };
      const t = setTimeout(() => fin(new Error('el navegador no llegó a cargar el audio (timeout)')), 25_000);
      signal.addEventListener('abort', () => fin(new Cancelado()));
      a.preload = 'auto';
      a.muted = true;
      a.onerror = () => fin(new Error(`el navegador no puede decodificar este audio (código ${a.error?.code ?? '?'})`));
      a.oncanplaythrough = async () => {
        const d = a.duration;
        if (!Number.isFinite(d) || d < 20) return fin(new Error(`duración inválida (${d})`));
        const esperada = Number(meta.duracion) || 0;
        if (esperada && Math.abs(d - esperada) > Math.max(25, esperada * 0.25)) {
          return fin(new Error(`el audio dura ${Math.round(d)} s y debería durar ~${Math.round(esperada)} s`));
        }
        logAudio(`${meta.id}: canplaythrough, duración ${d.toFixed(1)} s`);
        try {
          await a.play(); // en silencio: prueba que el navegador puede reproducirlo
          a.pause();
          fin();
        } catch (e) {
          fin(new Error(`play() rechazado: ${e.name}: ${e.message}`));
        }
      };
      a.src = blobUrl;
      try { a.load?.(); } catch {}
    });
  }

  async function correr(job) {
    try {
      logCancion(`${job.id}: precarga iniciada`);
      poner(job, 'preparando', null, 'servidor');
      const meta = await traerMeta(job);
      job.meta = meta;
      if (meta.origen === 'youtube') {
        // sin descarga: se confirma que el reproductor embebido esta listo en este navegador
        poner(job, 'preparando', null, 'reproductor');
        await prepararYouTube(meta, job.ctl.signal);
        if (meta.lrc) {
          try {
            const l = await fetchFn(url(meta.lrc), { signal: job.ctl.signal });
            if (l.ok) job.lrc = await l.text();
          } catch { /* la letra es opcional: el video de karaoke ya trae la suya */ }
        }
        if (job.ctl.signal.aborted) throw new Cancelado();
        poner(job, 'lista');
        return;
      }
      poner(job, 'preparando', null, 'descarga');
      const origen = meta.audio ? url(meta.audio) : null;
      if (!origen) throw new Error('la canción no tiene fuente de audio');
      const r = await fetchFn(origen, { signal: job.ctl.signal });
      if (!r.ok) throw new Error(`la fuente de audio respondió ${r.status}`);
      const tipo = r.headers?.get?.('content-type') || '';
      if (tipo && !/audio|octet-stream|mp4|mpeg/i.test(tipo)) throw new Error(`la fuente no es audio (${tipo})`);
      const blob = await r.blob();
      if (blob.size < 50_000) throw new Error(`el archivo de audio está vacío o incompleto (${blob.size} bytes)`);
      logAudio(`${job.id}: descargada (${(blob.size / 1e6).toFixed(1)} MB, ${tipo || 'sin tipo'})`);
      if (job.ctl.signal.aborted) throw new Cancelado();

      poner(job, 'preparando', null, 'decodificando');
      const blobUrl = URL.createObjectURL(blob);
      job.blobUrl = blobUrl;
      await probar(blobUrl, meta, job.ctl.signal);

      // la letra tambien tiene que estar
      if (meta.lrc) {
        const l = await fetchFn(url(meta.lrc), { signal: job.ctl.signal });
        if (!l.ok) throw new Error(`no se pudo cargar la letra (${l.status})`);
        job.lrc = await l.text();
        if (!job.lrc.trim()) throw new Error('la letra está vacía');
      }
      if (job.ctl.signal.aborted) throw new Cancelado();
      poner(job, 'lista');
    } catch (e) {
      if (e instanceof Cancelado || job.ctl.signal.aborted) {
        logCancion(`${job.id}: precarga cancelada`);
        return;
      }
      poner(job, 'error', String(e.message || e).slice(0, 160));
    }
  }

  function iniciar(id) {
    const job = { id, estado: 'preparando', motivo: null, etapa: null, meta: null, lrc: null, blobUrl: null, ctl: new AbortController() };
    jobs.set(id, job);
    correr(job);
    return job;
  }

  function soltar(id) {
    const job = jobs.get(id);
    if (!job) return;
    job.ctl.abort();
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
    jobs.delete(id);
  }

  // `ids`: lo que hay que tener cargado (en orden de prioridad). Todo lo demas se suelta.
  function apuntar(ids) {
    objetivos = [...new Set(ids.filter(Boolean))].slice(0, max);
    for (const id of objetivos) if (!jobs.has(id)) iniciar(id);
    for (const id of [...jobs.keys()]) if (!objetivos.includes(id) && !protegido.has(id)) soltar(id);
  }

  return {
    apuntar,
    proteger(ids) { protegido = new Set(ids.filter(Boolean)); },
    reintentar(id) {
      soltar(id);
      return iniciar(id);
    },
    soltar,
    obtener(id) {
      const j = jobs.get(id);
      return j?.estado === 'lista' ? { blobUrl: j.blobUrl, meta: j.meta, lrc: j.lrc } : null;
    },
    estado: (id) => (jobs.get(id) ? { estado: jobs.get(id).estado, motivo: jobs.get(id).motivo, etapa: jobs.get(id).etapa } : null),
    // para volver a informar al server despues de una reconexion / reinicio
    estados: () => [...jobs.values()].map((j) => ({ id: j.id, estado: j.estado, motivo: j.motivo })),
    get ids() { return [...jobs.keys()]; },
  };
}

class Cancelado extends Error {}
