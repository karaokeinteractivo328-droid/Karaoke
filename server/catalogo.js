// Catalogo + busqueda de canciones.
//
//   FUENTE DE LAS CANCIONES: YouTube Data API v3 (ver youtube.js). Se BUSCA con la API oficial y
//   se REPRODUCE con el reproductor embebido de YouTube (IFrame API) en la pantalla. NO se
//   descarga ni se extrae audio/video de YouTube: la referencia de la cancion es su `videoId`.
//
//   Los resultados se puntuan para quedarse con versiones aptas para KARAOKE (karaoke.js).
//
//   Ademas hay una BIBLIOTECA LOCAL (server/canciones, o Supabase Storage): son las canciones que
//   suenan sin Internet y sin clave de YouTube. Se reproducen con un <audio> normal.
//
//   La LETRA sincronizada (opcional) se busca en lrclib.net por titulo/artista del video. Muchos
//   videos de karaoke ya traen la letra dentro del video: si lrclib no la tiene, la pantalla
//   muestra el video mas grande.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { puntuarKaraoke } from './karaoke.js';
import { normalizar } from './texto.js';
import { YouTubeError, esVideoId } from './youtube.js';

export { normalizar };
const LRCLIB_POR_DEFECTO = 'https://lrclib.net/api';

// "Bohemian Rhapsody (Karaoke Version) - Sing King" -> { artista: '', tema: 'Bohemian Rhapsody' }
// "Queen - Bohemian Rhapsody (Instrumental)"        -> { artista: 'Queen', tema: 'Bohemian Rhapsody' }
const RUIDO_KARAOKE = /\b(karaoke|karaokê|instrumental|sing[ -]?along|backing[ -]?track|minus[ -]?one|version|versi[oó]n|official|oficial|hd|4k|lyrics?|letra|con letra|audio|video)\b/gi;
export function separarArtistaTema(tituloVideo) {
  let t = String(tituloVideo || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(RUIDO_KARAOKE, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[-–|:\s]+|[-–|:\s]+$/g, '');
  const partes = t.split(/\s[-–|]\s/).map((x) => x.trim()).filter(Boolean);
  if (partes.length >= 2) return { artista: partes[0], tema: partes[1] };
  return { artista: '', tema: partes[0] || t };
}

export function crearCatalogo({
  canciones, // array VIVO que comparte con el escenario (se le agregan las canciones de YouTube elegidas)
  dirLocal, // server/ (para resolver /canciones/...)
  dirCache, // server/cache-audio (solo guarda letras .lrc)
  ffmpeg = 'ffmpeg',
  youtube, // cliente de youtube.js
  fetchFn = (...a) => globalThis.fetch(...a),
  ejecutar, // (cmd, args, {timeout}) -> {stdout, stderr}   (se inyecta en tests)
  onEstadoAudio = () => {},
  log = () => {},
  config = {},
} = {}) {
  const C = {
    POR_PAGINA_LOCAL: 12,
    TIMEOUT_LRCLIB_MS: 9_000,
    TOLERANCIA_LETRA_S: 25,
    LRCLIB: process.env.LRCLIB_URL || LRCLIB_POR_DEFECTO,
    ...config,
  };

  const correr =
    ejecutar ||
    ((cmd, args, { timeout = 60_000 } = {}) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 1 << 26, windowsHide: true }, (err, stdout, stderr) => {
          if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
          resolve({ stdout, stderr });
        });
      }));

  // ---- estado de audio por cancion ----
  const estados = new Map(); // id -> { estado, motivo, promesa }
  const estadoAudio = (id) => estados.get(id) || null;

  // ------------------------------------------------------------------ busqueda
  const locales = () => canciones.filter((c) => c.origen !== 'youtube');
  function coincideLocal(c, q) {
    const nq = normalizar(q);
    if (!nq) return true;
    const h = normalizar(`${c.titulo} ${c.artista}`);
    return nq.split(' ').every((w) => h.includes(w));
  }
  const itemLocal = (c) => ({
    id: c.id, titulo: c.titulo, artista: c.artista, canal: c.artista, duracion: Number(c.duracion) || null,
    thumbnail: null, fuente: 'local', lista: true, karaoke: { esKaraoke: true, score: null, motivos: ['biblioteca'] },
  });

  // Una pagina de resultados. `pageToken` es el nextPageToken opaco de la pagina anterior.
  //   Primera pagina: biblioteca local que coincide + YouTube.  Siguientes: solo YouTube.
  async function buscar(q = '', pageToken = null) {
    const consulta = String(q || '').trim().slice(0, 100);
    const primera = !pageToken;
    const loc = primera ? locales().filter((c) => coincideLocal(c, consulta)).slice(0, C.POR_PAGINA_LOCAL).map(itemLocal) : [];
    const salida = { q: consulta, items: loc, nextPageToken: null, remoto: !!youtube?.configurada, error: null, cuota: youtube?.cuota?.() || null };
    if (consulta.length < 2 && !pageToken) return salida; // vacia = biblioteca local
    if (!youtube) return salida;
    try {
      const r = await youtube.buscar(consulta, pageToken);
      const nombres = new Set(loc.map((x) => `${normalizar(x.artista)}|${normalizar(x.titulo)}`));
      salida.items = [...loc, ...r.items.filter((x) => !nombres.has(`${normalizar(x.canal)}|${normalizar(x.titulo)}`))];
      salida.nextPageToken = r.nextPageToken;
      salida.cuota = r.cuota;
    } catch (e) {
      const mensajes = { sin_clave: 'La búsqueda de YouTube no está configurada en este equipo.', red: 'No se pudo conectar con YouTube.' };
      salida.error = { codigo: e.codigo || 'desconocido', mensaje: e instanceof YouTubeError ? e.message : mensajes[e.codigo] || 'No se pudo buscar en YouTube.' };
      log(`[catalogo] busqueda fallo (${salida.error.codigo}): ${e.message}`);
    }
    return salida;
  }

  // ---------------------------------------------------------------- resolver
  // De un id ("yt-<videoId>" o una cancion local) a una cancion registrada en el escenario.
  // Para YouTube se VERIFICA con la API (embebible, publico, sin restriccion) antes de aceptarla.
  const registrando = new Map();
  async function resolver(id, { busqueda = '' } = {}) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id || '')) throw new Error('id invalido');
    const ya = canciones.find((c) => c.id === id);
    if (ya) return { ...ya };
    const m = /^yt-([A-Za-z0-9_-]{11})$/.exec(id);
    if (!m || !esVideoId(m[1])) throw new Error('cancion desconocida');
    if (!youtube?.configurada) throw new Error('la búsqueda de YouTube no está configurada');
    if (registrando.has(id)) return registrando.get(id);
    const p = (async () => {
      const d = await youtube.detalle(m[1]); // lanza si no se puede reproducir
      const karaoke = puntuarKaraoke(d, busqueda || d.titulo);
      const meta = {
        id,
        origen: 'youtube',
        videoId: d.videoId,
        titulo: d.titulo,
        artista: d.canal,
        canal: d.canal,
        thumbnail: d.thumbnail,
        duracion: d.duracion,
        voces: 'solo',
        // lo que se guarda de la eleccion (ademas del videoId): con que consulta se la encontro y cuan karaoke es
        searchQuery: String(busqueda || '').slice(0, 100),
        karaokeScore: karaoke.score,
        esKaraoke: karaoke.esKaraoke,
        lrc: null,
        offsetLetra: 0,
      };
      canciones.push(meta);
      log(`[SONG] registrada ${id}: "${meta.titulo}" (${meta.canal}, ${meta.duracion}s, karaoke ${meta.karaokeScore})`);
      buscarLetra(meta).catch((e) => log(`[letra] ${id}: ${e.message}`)); // en segundo plano: no frena la eleccion
      return { ...meta };
    })().finally(() => registrando.delete(id));
    registrando.set(id, p);
    return p;
  }

  // ------------------------------------------------------------------- letra
  async function lrclib(ruta) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), C.TIMEOUT_LRCLIB_MS);
    try {
      const r = await fetchFn(`${C.LRCLIB}${ruta}`, { signal: ctl.signal, headers: { 'Lrclib-Client': 'karaoke-interactivo (proyecto universitario)' } });
      if (!r.ok) throw new Error(`lrclib respondio ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // Letra sincronizada para el video elegido (mejor esfuerzo). Se acepta solo si la duracion de la
  // letra es parecida a la del video (si no, el tiempo no coincidiria y seria peor que no tener).
  async function buscarLetra(meta) {
    const { artista, tema } = separarArtistaTema(meta.titulo);
    const q = `${artista} ${tema}`.trim();
    if (q.length < 3) return null;
    const crudo = await lrclib(`/search?q=${encodeURIComponent(q)}`);
    const nTema = normalizar(tema);
    const candidatos = (Array.isArray(crudo) ? crudo : [])
      .filter((r) => r.syncedLyrics && !r.instrumental && normalizar(r.trackName || r.name).includes(nTema.split(' ')[0] || nTema))
      .map((r) => ({ r, dif: Math.abs(Number(r.duration) - Number(meta.duracion)) }))
      .filter((x) => x.dif <= C.TOLERANCIA_LETRA_S)
      .sort((a, b) => a.dif - b.dif);
    if (!candidatos.length) {
      meta.letraEstado = 'sin_letra';
      log(`[letra] ${meta.id}: sin letra sincronizada compatible (el video trae la suya)`);
      return null;
    }
    const mejor = candidatos[0];
    await mkdir(dirCache, { recursive: true });
    await writeFile(join(dirCache, `${meta.id}.lrc`), mejor.r.syncedLyrics, 'utf8');
    meta.lrc = `/cache-audio/${meta.id}.lrc`;
    meta.letraEstado = 'ok';
    meta.letraDesfase = Math.round(meta.duracion - mejor.r.duration);
    log(`[letra] ${meta.id}: letra sincronizada de lrclib (duracion ${mejor.r.duration}s vs video ${meta.duracion}s)`);
    return meta.lrc;
  }

  // ---------------------------------------------------------- validar archivos locales
  async function sondear(archivo) {
    try {
      const { stderr } = await correr(ffmpeg, ['-hide_banner', '-t', '90', '-i', archivo, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { timeout: 60_000 });
      return parsearInfoFfmpeg(stderr);
    } catch (e) {
      const info = parsearInfoFfmpeg(e.stderr || '');
      if (info.duracion) return info;
      throw new Error(`ffmpeg no pudo leer el archivo (${(e.stderr || e.message || '').split('\n').slice(-2, -1)[0] || 'error'})`);
    }
  }

  async function prepararAudio(id) {
    const meta = canciones.find((c) => c.id === id);
    if (!meta) throw new Error('cancion desconocida');
    // YouTube: ya se verifico con la API (embebible / publico / sin restriccion). Que el
    // reproductor la cargue lo confirma la pantalla.
    if (meta.origen === 'youtube') return;
    // biblioteca local: el archivo del repo, o el de Supabase Storage si no esta
    const rel = String(meta.audio || '');
    if (/^https?:\/\//.test(rel)) {
      const r = await fetchFn(rel, { headers: { Range: 'bytes=0-1023' } });
      if (!r.ok && r.status !== 206) throw new Error(`la fuente remota respondio ${r.status}`);
      return;
    }
    const archivo = join(dirLocal, rel.replace(/^\//, ''));
    if (!existsSync(archivo)) {
      if (meta.audioRemoto) return;
      throw new Error('falta el archivo de audio en este equipo');
    }
    const info = await sondear(archivo);
    const falla = veredictoArchivo(info, null);
    if (falla) throw new Error(falla);
    log(`[AUDIO] ${id} validada: ${Math.round(info.duracion)}s, volumen medio ${info.volumenMedio} dB`);
  }

  // Idempotente: varios pedidos comparten la misma preparacion.
  function asegurarAudio(id) {
    const e = estados.get(id);
    if (e?.promesa) return e.promesa;
    if (e?.estado === 'lista') return Promise.resolve();
    const promesa = prepararAudio(id)
      .then(() => {
        estados.set(id, { estado: 'lista', motivo: null });
        onEstadoAudio(id, 'lista', null);
      })
      .catch((err) => {
        const motivo = motivoDe(err);
        estados.set(id, { estado: 'error', motivo });
        log(`[AUDIO ERROR] ${id}: ${motivo}`);
        onEstadoAudio(id, 'error', motivo);
      });
    estados.set(id, { estado: 'preparando', motivo: null, promesa });
    onEstadoAudio(id, 'preparando', null);
    return promesa;
  }

  function reintentar(id) {
    estados.delete(id);
    return asegurarAudio(id);
  }

  // meta completa que necesita la pantalla para reproducir (con el estado actual)
  function metaPublica(id) {
    const c = canciones.find((x) => x.id === id);
    if (!c) return null;
    return {
      id: c.id,
      titulo: c.titulo,
      artista: c.artista,
      canal: c.canal || c.artista,
      thumbnail: c.thumbnail || null,
      duracion: c.duracion,
      voces: c.voces ?? 'solo',
      origen: c.origen || 'local',
      videoId: c.videoId || null,
      searchQuery: c.searchQuery || '',
      karaokeScore: c.karaokeScore ?? null,
      lrc: c.lrc,
      letraEstado: c.letraEstado || (c.lrc ? 'ok' : null),
      audio: c.audio,
      audioRemoto: c.audioRemoto || null,
      offsetLetra: c.offsetLetra || 0,
      audioEstado: estados.get(id)?.estado || 'sin_preparar',
      audioMotivo: estados.get(id)?.motivo || null,
    };
  }

  return {
    buscar,
    resolver,
    asegurarAudio,
    reintentar,
    estadoAudio,
    metaPublica,
    buscarLetra,
    sondear,
    get remoto() {
      return !!youtube?.configurada;
    },
    get motivoCapacidad() {
      return youtube?.configurada ? 'YouTube Data API configurada' : 'falta YOUTUBE_API_KEY: solo la biblioteca local';
    },
  };
}

// El motivo que ve la persona: la causa real, no el comando que fallo.
export function motivoDe(err) {
  const lineas = String(err?.stderr || '').split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const real = [...lineas].reverse().find((l) => /^ERROR|error|HTTP|unavailable|blocked/i.test(l));
  const msg = real || String(err?.message || err || 'error desconocido').split(String.fromCharCode(10))[0];
  return msg.replace(/^ERROR:\s*/i, '').slice(0, 160);
}

export function parsearInfoFfmpeg(stderr) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '');
  const media = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr || '');
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr || '');
  const num = (x) => (x === '-inf' ? -Infinity : Number(x));
  return {
    duracion: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    volumenMedio: media ? num(media[1]) : null,
    volumenMax: max ? num(max[1]) : null,
    tieneAudio: /Audio:/.test(stderr || ''),
  };
}

export function veredictoArchivo(info, esperada) {
  if (!info.tieneAudio) return 'el archivo no tiene pista de audio';
  if (!info.duracion || info.duracion < 20) return `duracion invalida (${info.duracion ?? '?'} s)`;
  if (info.volumenMedio == null || info.volumenMedio < -60 || info.volumenMax === -Infinity) return 'el audio es silencio';
  if (esperada && Math.abs(info.duracion - esperada) > Math.max(25, esperada * 0.25)) {
    return `dura ${Math.round(info.duracion)} s y deberia durar ~${Math.round(esperada)} s`;
  }
  return null;
}
