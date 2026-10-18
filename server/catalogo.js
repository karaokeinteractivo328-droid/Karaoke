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
import { normalizarOffset } from './offsets.js';
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
  offsets, // offsets.js: desfase de la letra guardado por cancion (opcional)
  log = () => {},
  config = {},
} = {}) {
  const C = {
    POR_PAGINA_LOCAL: 12,
    TIMEOUT_LRCLIB_MS: 6_000,
    TOLERANCIA_SINCRONIA_S: 3, // video y letra duran casi igual: la letra de lrclib cae con el video (medido en videos reales)
    MAX_SINCRONIA: 12, // a cuantos resultados se les consulta la letra al buscar
    ESPERA_SINCRONIA_MS: 4_000, // cuanto se espera esa consulta antes de mostrar los resultados
    CACHE_LRCLIB_MS: 6 * 3600_000,
    ESPERA_LETRA_MS: 12_000, // cuanto se espera la letra antes de dar la cancion por lista
    TOLERANCIA_LETRA_S: 25, // diferencia de duracion en la que la letra se da por buena
    TOLERANCIA_LETRA_AMPLIA_S: 90, // mas alla de esto no se usa; entre ambas se usa igual (la version karaoke suele tener intro/final extra)
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
      const yt = r.items.filter((x) => !nombres.has(`${normalizar(x.canal)}|${normalizar(x.titulo)}`));
      await enriquecerSincronia(yt);
      // karaoke primero y, dentro de eso, los de letra sincronizada (orden estable para el resto)
      yt.sort((a, b) => (b.karaoke?.esKaraoke ? 1 : 0) - (a.karaoke?.esKaraoke ? 1 : 0) || (b.karaoke?.score ?? 0) + bonoSincronia(b) - ((a.karaoke?.score ?? 0) + bonoSincronia(a)));
      salida.items = [...loc, ...yt];
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
        offsetLetra: offsets?.get(id) ?? 0, // lo que ajusto alguien la ultima vez que se canto
      };
      canciones.push(meta);
      log(`[SONG] registrada ${id}: "${meta.titulo}" (${meta.canal}, ${meta.duracion}s, karaoke ${meta.karaokeScore})`);
      asegurarLetra(meta); // en segundo plano: no frena la eleccion
      return { ...meta };
    })().finally(() => registrando.delete(id));
    registrando.set(id, p);
    return p;
  }

  // ------------------------------------------------------------------- letra
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

  // Mejor letra sincronizada de lrclib para un video (o null). Se prueba de lo mas preciso
  // (artista + tema) a lo mas amplio. El titulo del video es desordenado ("TEMA - ARTISTA | KARAOKE",
  // "ARTISTA - TEMA (Karaoke Version)"), asi que se compara por PALABRAS sin importar el orden.
  // Gana la de duracion mas cercana al video (y, a igualdad, la del mismo artista): lrclib tiene
  // varias versiones del mismo tema con tiempos muy distintos (p. ej. 10 s vs 42 s para la 1ra linea).
  const palabras = (t) => normalizar(t).split(' ').filter((w) => w.length > 1);
  async function elegirLetra(titulo, duracion) {
    const { artista, tema } = separarArtistaTema(titulo);
    const consulta = `${artista} ${tema}`.trim();
    if (consulta.length < 3) return null;
    const rutas = [];
    if (artista && tema) rutas.push(`/search?track_name=${encodeURIComponent(tema)}&artist_name=${encodeURIComponent(artista)}`);
    rutas.push(`/search?q=${encodeURIComponent(consulta)}`);
    if (artista) rutas.push(`/search?q=${encodeURIComponent(tema)}`);
    const buscadas = palabras(consulta);
    const nArtista = palabras(artista)[0] || '';
    const puntuar = (r) => {
      if (!r.syncedLyrics || r.instrumental) return null;
      const nombre = new Set(palabras(`${r.artistName || ''} ${r.trackName || r.name || ''}`));
      const halladas = buscadas.filter((w) => nombre.has(w)).length;
      if (!buscadas.length || halladas / buscadas.length < 0.6) return null; // no es el mismo tema
      const dif = Math.abs(Number(r.duration) - Number(duracion));
      if (!(dif <= C.TOLERANCIA_LETRA_AMPLIA_S)) return null;
      const mismoArtista = !!nArtista && palabras(r.artistName).includes(nArtista);
      return { r, dif, mismoArtista, orden: dif - (mismoArtista ? 5 : 0) + (dif > C.TOLERANCIA_LETRA_S ? 1000 : 0) };
    };
    let mejor = null;
    for (const ruta of rutas) {
      let crudo;
      try { crudo = await lrclib(ruta); } catch (e) { log(`[letra] lrclib fallo (${e.message})`); continue; }
      const candidatos = (Array.isArray(crudo) ? crudo : []).map(puntuar).filter(Boolean).sort((x, y) => x.orden - y.orden);
      if (candidatos.length && (!mejor || candidatos[0].orden < mejor.orden)) mejor = candidatos[0];
      if (mejor && mejor.dif <= C.TOLERANCIA_SINCRONIA_S) break; // ya hay una que calza
    }
    return mejor;
  }

  // Letra sincronizada para el video elegido (mejor esfuerzo). Hasta TOLERANCIA_LETRA_AMPLIA_S de
  // diferencia de duracion se guarda igual, pero solo se la considera CONFIABLE (se dibuja la letra
  // de la app) si dura casi igual que el video (nivel "alta") o si alguien ya la alineo a mano.
  async function buscarLetra(meta) {
    const mejor = await elegirLetra(meta.titulo, meta.duracion);
    if (!mejor) {
      meta.letraEstado = 'sin_letra';
      log(`[letra] ${meta.id}: sin letra sincronizada compatible (el video trae la suya)`);
      return null;
    }
    await mkdir(dirCache, { recursive: true });
    await writeFile(join(dirCache, `${meta.id}.lrc`), mejor.r.syncedLyrics, 'utf8');
    meta.lrc = `/cache-audio/${meta.id}.lrc`;
    meta.letraEstado = 'ok';
    meta.letraDesfase = Math.round(meta.duracion - mejor.r.duration);
    meta.letraAproximada = mejor.dif > C.TOLERANCIA_LETRA_S;
    meta.letraNivel = mejor.dif <= C.TOLERANCIA_SINCRONIA_S ? 'alta' : 'media';
    log(`[letra] ${meta.id}: letra de lrclib "${mejor.r.artistName} - ${mejor.r.trackName}" (duracion ${mejor.r.duration}s vs video ${meta.duracion}s, sincronia ${meta.letraNivel})`);
    return meta.lrc;
  }

  // Al buscar: a los primeros resultados se les mira si hay letra de lrclib que calce con la duracion
  // del video. Los que calzan ("alta") suben en la lista y se marcan: son los que van a salir a tiempo.
  async function enriquecerSincronia(items) {
    const objetivo = items.filter((i) => i.fuente === 'youtube' && i.sincronia === undefined).slice(0, C.MAX_SINCRONIA);
    if (!objetivo.length) return;
    const tareas = objetivo.map(async (it) => {
      try {
        const m = await elegirLetra(it.titulo, it.duracion);
        it.sincronia = m ? { nivel: m.dif <= C.TOLERANCIA_SINCRONIA_S ? 'alta' : 'media', dif: Math.round(m.dif) } : { nivel: 'sin_letra' };
      } catch {
        it.sincronia = null;
      }
    });
    await Promise.race([Promise.all(tareas), new Promise((r) => setTimeout(r, C.ESPERA_SINCRONIA_MS))]);
  }
  const bonoSincronia = (i) => (i.karaoke?.esKaraoke && i.sincronia?.nivel === 'alta' ? 30 : 0);

  // Una sola busqueda de letra por cancion (la eleccion la dispara en segundo plano y la
  // preparacion del audio la espera un rato: asi, cuando la cancion figura "lista", la letra ya esta).
  const letrasEnCurso = new Map();
  function asegurarLetra(meta) {
    if (meta.lrc || meta.letraEstado) return Promise.resolve();
    if (!letrasEnCurso.has(meta.id)) {
      letrasEnCurso.set(meta.id, buscarLetra(meta).catch((e) => log(`[letra] ${meta.id}: ${e.message}`)));
    }
    return letrasEnCurso.get(meta.id);
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
    if (meta.origen === 'youtube') {
      // la letra sincronizada (lrclib) se espera un poco: asi la pantalla ya la tiene al precargar
      await Promise.race([asegurarLetra(meta), new Promise((r) => setTimeout(r, C.ESPERA_LETRA_MS))]);
      return;
    }
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
      letraNivel: c.letraNivel || null,
      // la letra de la app se dibuja solo si va a salir a tiempo: dura casi igual que el video o alguien ya la alineo
      letraConfiable: !!c.lrc && (c.letraNivel === 'alta' || offsets?.get(id) != null),
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
