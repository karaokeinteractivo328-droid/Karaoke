// Catalogo + busqueda de canciones.
//
//   El CATALOGO sale de LRCLIB (lrclib.net): solo aparecen temas con LETRA SINCRONIZADA, asi que toda
//   cancion que se puede elegir tiene letra. Al elegirla (id "lr-<id de lrclib>-o|k") el server busca en
//   YouTube (Data API v3) el video que mejor calza con esa letra (ver seleccion.js):
//     o = audio ORIGINAL del tema: la letra cae a tiempo sola (mismo master que uso lrclib)
//     k = KARAOKE sin voz: la letra puede salir corrida (se avisa y se puede alinear)
//   Se REPRODUCE con el reproductor embebido de YouTube en la pantalla. NO se descarga ni se extrae
//   audio/video de YouTube: la referencia de la cancion es su `videoId`.
//
//   Ademas hay una BIBLIOTECA LOCAL (server/canciones, o Supabase Storage): suena sin Internet ni
//   clave de YouTube, con un <audio> normal.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizar } from './texto.js';
import { normalizarOffset } from './offsets.js';
import { YouTubeError } from './youtube.js';
import { agruparTemas, consultasDe, elegirVideo, mejorVariante, mismoTema, tituloLimpio } from './seleccion.js';

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
  canciones, // array VIVO que comparte con el escenario (se le agregan las canciones elegidas)
  dirLocal, // server/ (para resolver /canciones/...)
  dirCache, // server/cache-audio (solo guarda letras .lrc)
  ffmpeg = 'ffmpeg',
  youtube, // cliente de youtube.js
  fetchFn = (...a) => globalThis.fetch(...a),
  ejecutar, // (cmd, args, {timeout}) -> {stdout, stderr}   (se inyecta en tests)
  onEstadoAudio = () => {},
  offsets, // offsets.js: desfase de la letra guardado por cancion (opcional)
  elecciones, // almacen.js: que video se eligio para cada cancion (evita gastar cuota tras un reinicio)
  log = () => {},
  config = {},
} = {}) {
  const C = {
    POR_PAGINA_LOCAL: 12,
    TIMEOUT_LRCLIB_MS: 6_000,
    CACHE_LRCLIB_MS: 6 * 3600_000,
    MAX_TEMAS: 15, // temas distintos por busqueda
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

  const itemLrclib = (t) => ({
    id: `lr-${t.id}`, titulo: t.titulo, artista: t.artista, canal: t.artista, duracion: t.duracion,
    thumbnail: null, fuente: 'lrclib', lista: false, letra: true, karaoke: null,
  });

  // Resultados de una consulta: la biblioteca local + los temas de LRCLIB (todos con letra sincronizada).
  // No cuesta nada de cuota de YouTube: eso recien pasa al ELEGIR una cancion.
  async function buscar(q = '', pageToken = null) {
    const consulta = String(q || '').trim().slice(0, 100);
    const loc = !pageToken ? locales().filter((c) => coincideLocal(c, consulta)).slice(0, C.POR_PAGINA_LOCAL).map(itemLocal) : [];
    const salida = { q: consulta, items: loc, nextPageToken: null, remoto: !!youtube?.configurada, error: null, cuota: youtube?.cuota?.() || null };
    if (pageToken || consulta.length < 2) return salida; // vacia = biblioteca local
    if (!youtube?.configurada) {
      salida.error = { codigo: 'sin_clave', mensaje: 'La búsqueda de YouTube no está configurada en este equipo.' };
      return salida;
    }
    try {
      const temas = agruparTemas(await lrclib(`/search?q=${encodeURIComponent(consulta)}`), { max: C.MAX_TEMAS });
      // la biblioteca local ya tiene esos temas (y suenan sin Internet): no se repiten
      salida.items = [...loc, ...temas.filter((t) => !loc.some((x) => mismoTema(x.artista, x.titulo, t.artista, t.titulo))).map(itemLrclib)];
    } catch (e) {
      salida.error = { codigo: 'lrclib', mensaje: 'No se pudo consultar el catálogo de letras. Probá de nuevo.' };
      log(`[catalogo] busqueda fallo (lrclib): ${e.message}`);
    }
    return salida;
  }

  // ------------------------------------------------------------------- lrclib
  const cacheLrclib = new Map(); // ruta -> { t, datos } | { promesa }
  async function lrclib(ruta) {
    const hit = cacheLrclib.get(ruta);
    if (hit?.promesa) return hit.promesa;
    if (hit && Date.now() - hit.t < C.CACHE_LRCLIB_MS) return hit.datos;
    const promesa = (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), C.TIMEOUT_LRCLIB_MS);
      try {
        const r = await fetchFn(`${C.LRCLIB}${ruta}`, { signal: ctl.signal, headers: { 'Lrclib-Client': 'karaoke-interactivo (proyecto universitario)' } });
        if (!r.ok) throw new Error(`lrclib respondio ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    })();
    cacheLrclib.set(ruta, { promesa });
    try {
      const datos = await promesa;
      cacheLrclib.set(ruta, { t: Date.now(), datos });
      if (cacheLrclib.size > 500) cacheLrclib.delete(cacheLrclib.keys().next().value);
      return datos;
    } catch (e) {
      cacheLrclib.delete(ruta);
      throw e;
    }
  }

  // El tema de lrclib con TODAS sus versiones sincronizadas (cada una con su duracion)
  async function temaDe(lrId) {
    const t = await lrclib(`/get/${lrId}`);
    if (!t?.syncedLyrics) throw new YouTubeError('sin_letra', 'Esa canción ya no tiene letra sincronizada.');
    const titulo = tituloLimpio(t.trackName || t.name);
    const artista = String(t.artistName || '').trim();
    let variantes = [];
    try {
      const crudo = await lrclib(`/search?q=${encodeURIComponent(`${artista} ${titulo}`.trim())}`);
      const g = agruparTemas([t, ...(Array.isArray(crudo) ? crudo : [])], { max: 200 }).find((x) => x.variantes.some((v) => v.id === t.id));
      variantes = g?.variantes || [];
    } catch {
      // sin las demas versiones igual se puede: queda la que se eligio
    }
    if (!variantes.some((v) => v.id === t.id)) variantes.push({ id: t.id, duracion: Number(t.duration), syncedLyrics: t.syncedLyrics });
    return { id: t.id, artista, titulo, duracion: Math.round(Number(t.duration)), variantes };
  }

  // ------------------------------------------------------------ elegir el video
  // Busca en YouTube el video que mejor calza con la letra (ver seleccion.js) y lo recuerda.
  async function buscarVideoPara(tema, tipo, malos = []) {
    let mejor = null;
    for (const q of consultasDe(tema, tipo)) {
      const r = tipo === 'karaoke' ? await youtube.buscar(q) : await youtube.candidatos(q);
      const e = elegirVideo((r.items || []).filter((v) => !malos.includes(v.videoId)), tema, tipo);
      if (e && (!mejor || e.p.score > mejor.p.score)) mejor = e;
      if (mejor && (tipo === 'karaoke' || mejor.p.nivel === 'exacta')) break; // el original se sigue buscando hasta dar con uno exacto
    }
    if (!mejor) {
      throw new YouTubeError('sin_version', tipo === 'original'
        ? 'No encontramos el audio original de esta canción con la duración de la letra. Probá la versión karaoke.'
        : 'No encontramos un karaoke reproducible para esta canción. Probá la versión original.');
    }
    const { video: v, p } = mejor;
    return {
      videoId: v.videoId, titulo: v.titulo, canal: v.canal, thumbnail: v.thumbnail, duracion: v.duracion,
      varianteId: p.variante.id, nivel: p.nivel, dif: Math.round(p.dif * 10) / 10, confiable: !!p.confiable,
      karaokeScore: p.karaoke?.score ?? null, esKaraoke: !!p.esKaraoke,
    };
  }

  // videos que ya fallaron para una cancion (en memoria y, si hay almacen, tambien en disco)
  const malosMem = new Map();
  const malosDe = (id) => [...new Set([...(malosMem.get(id) || []), ...(elecciones?.get(`${id}_malos`) || [])])];

  // ---------------------------------------------------------------- resolver
  // De un id ("lr-<id lrclib>-o|k" o una cancion local) a una cancion registrada en el escenario.
  const registrando = new Map();
  const ID_LR = /^lr-(\d{1,10})-([ok])$/;
  async function resolver(id, { busqueda = '' } = {}) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id || '')) throw new Error('id invalido');
    const ya = canciones.find((c) => c.id === id);
    if (ya) return { ...ya };
    const m = ID_LR.exec(id);
    if (!m) throw new Error('cancion desconocida');
    if (!youtube?.configurada) throw new Error('la búsqueda de YouTube no está configurada');
    if (registrando.has(id)) return registrando.get(id);
    const p = registrar(id, Number(m[1]), m[2] === 'o' ? 'original' : 'karaoke', busqueda).finally(() => registrando.delete(id));
    registrando.set(id, p);
    return p;
  }

  async function registrar(id, lrId, tipo, busqueda) {
    const tema = await temaDe(lrId);
    let el = elecciones?.get(id);
    if (!el) {
      el = await buscarVideoPara(tema, tipo, malosDe(id));
      elecciones?.set(id, el);
    }
    const variante = tema.variantes.find((v) => v.id === el.varianteId) || mejorVariante(el.duracion, tema.variantes).variante;
    await mkdir(dirCache, { recursive: true });
    await writeFile(join(dirCache, `${id}.lrc`), variante.syncedLyrics, 'utf8');
    const meta = {
      id,
      origen: 'youtube',
      tipo,
      videoId: el.videoId,
      titulo: tema.titulo,
      artista: tema.artista,
      canal: el.canal,
      thumbnail: el.thumbnail,
      duracion: el.duracion,
      voces: 'solo',
      // lo que se guarda de la eleccion: con que consulta se la encontro y cuan karaoke es
      searchQuery: String(busqueda || '').slice(0, 100),
      karaokeScore: el.karaokeScore,
      esKaraoke: el.esKaraoke,
      lrc: `/cache-audio/${id}.lrc`,
      letraEstado: 'ok',
      letraNivel: el.nivel,
      letraDesfase: Math.round(el.duracion - variante.duracion),
      letraConfianza: !!el.confiable, // se sabe que la letra cae con el video (audio original de duracion igual)
      offsetLetra: offsets?.get(id) ?? 0, // lo que ajusto alguien la ultima vez que se canto
    };
    canciones.push(meta);
    log(`[SONG] registrada ${id}: "${meta.artista} - ${meta.titulo}" -> video ${el.videoId} (${meta.canal}, ${meta.duracion}s, ${tipo}, sincronia ${el.nivel}, dif ${el.dif}s)`);
    return { ...meta };
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
    // YouTube: el video ya se verifico con la API (embebible / publico / sin restriccion). Que el
    // reproductor lo cargue lo confirma la pantalla.
    if (meta.origen === 'youtube') return; // la letra ya se guardo al elegir el video
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

  // Reintentar: si es de YouTube se descarta el video que fallo y se elige el siguiente mejor
  function reintentar(id) {
    const c = canciones.find((x) => x.id === id);
    estados.delete(id);
    if (c?.origen === 'youtube') {
      const malos = [...malosDe(id), c.videoId].slice(-10);
      malosMem.set(id, malos);
      elecciones?.set(`${id}_malos`, malos);
      elecciones?.delete(id);
      canciones.splice(canciones.indexOf(c), 1);
      return resolver(id, { busqueda: c.searchQuery })
        .then(() => asegurarAudio(id))
        .catch((e) => {
          const motivo = motivoDe(e);
          estados.set(id, { estado: 'error', motivo });
          log(`[AUDIO ERROR] ${id}: ${motivo}`);
          onEstadoAudio(id, 'error', motivo);
        });
    }
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
      letraNivel: c.letraNivel || null,
      tipo: c.tipo || null,
      // la letra va a salir a tiempo: audio original de duracion igual a la letra, o alguien ya la alineo a mano
      letraConfiable: !!c.lrc && (c.letraConfianza === true || offsets?.get(id) != null),
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
    sondear,
    // Guarda el desfase de la letra de una cancion (lo ajusta quien canta en vivo)
    fijarOffset(id, valor) {
      const c = canciones.find((x) => x.id === id);
      if (!c) return null;
      const n = offsets ? offsets.set(id, valor) : normalizarOffset(valor);
      if (n === null) return null;
      c.offsetLetra = n;
      return n;
    },
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
