// Catalogo + busqueda + audio de las canciones.
//
// ARQUITECTURA HIBRIDA (cada pieza hace lo que mejor hace):
//   - METADATA + LETRA SINCRONIZADA: lrclib.net  (gratis, sin clave, CORS abierto,
//     20 resultados por busqueda, duracion y letra .lrc). Solo metadata: NO da audio.
//   - AUDIO REPRODUCIBLE: (1) la biblioteca local (server/canciones, siempre anda y no
//     necesita Internet) y (2) un RESOLVEDOR A PEDIDO en el server (yt-dlp): busca la
//     version del tema cuya duracion coincide con la letra, la baja ENTERA, la valida y la
//     sirve desde nuestro propio server (mismo CORS, Range, preload, currentTime exacto).
//   Descartados: Spotify (no entrega audio crudo, exige Premium), Deezer / iTunes (solo
//   previews de 30 s), Jamendo (canciones completas pero solo musica independiente),
//   YouTube IFrame (sin control de preload ni de sincronizacion, con anuncios).
//
// Una cancion NUNCA se marca "lista" por tener una URL: se baja, se valida con ffmpeg
// (decodifica, dura lo que debe, no es silencio) y recien ahi avisa `onEstadoAudio`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const LRCLIB_POR_DEFECTO = 'https://lrclib.net/api';
const MALAS = /\b(live|en vivo|cover|karaoke|instrumental|remix|reaction|tutorial|slowed|sped ?up|nightcore|8d|acoustic version|reverb|mashup)\b/i;

export const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// lrclib a veces trae el titulo como "Artista - Tema": se deja solo el tema
export function limpiarTitulo(titulo, artista) {
  const t = String(titulo || '').trim();
  const a = String(artista || '').trim();
  if (a && t.toLowerCase().startsWith(`${a.toLowerCase()} - `)) return t.slice(a.length + 3).trim();
  return t;
}

const idSeguro = (s) => /^[A-Za-z0-9_-]{1,60}$/.test(s || '');

// --- eleccion de la version correcta (pura: se testea sin red) ---------------------
// candidatos: [{ id, title, duration }]  meta: { titulo, artista, duracion }
// La letra de lrclib esta cronometrada para UNA version del tema: si el audio dura distinto
// (en vivo, remix, con intro larga) la letra sale corrida. Por eso se elige por duracion.
export function elegirCandidato(candidatos, meta, { tolerancia = 6, toleranciaMax = 15 } = {}) {
  const tituloMeta = `${meta.titulo} ${meta.artista}`;
  const limpios = (candidatos || [])
    .filter((c) => c?.id && Number(c.duration) > 0)
    .filter((c) => !MALAS.test(c.title || '') || MALAS.test(tituloMeta));
  const conDif = limpios.map((c) => ({ ...c, dif: Math.abs(Number(c.duration) - Number(meta.duracion)) }));
  // si el titulo contiene el artista y el tema, mejor
  const t = normalizar(meta.titulo);
  const a = normalizar(meta.artista);
  const puntuar = (c) => {
    const nt = normalizar(c.title);
    return c.dif + (nt.includes(t) ? 0 : 4) + (nt.includes(a) || normalizar(c.channel).includes(a) ? 0 : 2);
  };
  conDif.sort((x, y) => puntuar(x) - puntuar(y));
  const mejor = conDif.find((c) => c.dif <= tolerancia) || null;
  if (mejor) return { ...mejor, desfaseProbable: false };
  const aprox = conDif.find((c) => c.dif <= toleranciaMax) || null;
  return aprox ? { ...aprox, desfaseProbable: true } : null;
}

// --- validacion del archivo ----------------------------------------------------------
// El motivo que ve la persona: la ultima linea de error real de yt-dlp/ffmpeg ("ERROR: HTTP Error 403"),
// no el comando entero que fallo.
export function motivoDe(err) {
  const lineas = String(err?.stderr || '').split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const real = [...lineas].reverse().find((l) => /^ERROR|error|HTTP|Sign in|unavailable|blocked/i.test(l));
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
  return null; // ok
}

export function crearCatalogo({
  canciones, // array VIVO que comparte con el escenario (se le agregan las canciones remotas)
  dirLocal, // server/ (para resolver /canciones/...)
  dirCache, // server/cache-audio
  ffmpeg = 'ffmpeg',
  fetchFn = globalThis.fetch,
  ejecutar, // (cmd, args, { timeout }) => Promise<{ stdout, stderr }>  (se inyecta en tests)
  onEstadoAudio = () => {},
  enUso = () => new Set(), // ids que estan en la fila / en el escenario (no se borran)
  log = () => {},
  config = {},
} = {}) {
  const C = {
    MAX_ARCHIVOS: 40,
    CONCURRENCIA: 2,
    TIMEOUT_BUSQUEDA_MS: 30_000,
    TIMEOUT_DESCARGA_MS: 150_000,
    TIMEOUT_LRCLIB_MS: 9_000,
    CACHE_BUSQUEDA_MS: 10 * 60_000,
    POR_PAGINA: 10,
    LRCLIB: process.env.LRCLIB_URL || LRCLIB_POR_DEFECTO, // se puede apuntar a un lrclib propio / de prueba
    ...config,
  };

  const correr =
    ejecutar ||
    ((cmd, args, { timeout = 60_000 } = {}) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 1 << 26, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            return reject(err);
          }
          resolve({ stdout, stderr });
        });
      }));

  // ---- capacidades: sin yt-dlp solo se ofrecen canciones que realmente se pueden reproducir
  let ytdlp = null; // ['yt-dlp'] | ['python','-m','yt_dlp']
  let capacidadMotivo = 'sin detectar';
  async function detectar() {
    if (config.YTDLP === 'off') {
      capacidadMotivo = 'desactivado (AUDIO_REMOTO=0)';
      return false;
    }
    const intentos = config.YTDLP ? [String(config.YTDLP).split(' ')] : [['yt-dlp'], ['python', '-m', 'yt_dlp'], ['python3', '-m', 'yt_dlp']];
    for (const cmd of intentos) {
      try {
        const { stdout } = await correr(cmd[0], [...cmd.slice(1), '--version'], { timeout: 15_000 });
        ytdlp = cmd;
        capacidadMotivo = `yt-dlp ${String(stdout).trim()}`;
        log(`[catalogo] resolvedor de audio disponible: ${capacidadMotivo}`);
        return true;
      } catch {
        /* sigue con el proximo */
      }
    }
    capacidadMotivo = 'yt-dlp no esta instalado en este equipo';
    log(`[catalogo] sin resolvedor de audio remoto (${capacidadMotivo}): solo se ofrece la biblioteca local`);
    return false;
  }
  const remotoDisponible = () => !!ytdlp;

  // ---- estado de audio por cancion ----
  const estados = new Map(); // id -> { estado, motivo, promesa }
  const emitir = (id, estado, motivo = null) => {
    const prev = estados.get(id);
    estados.set(id, { ...prev, estado, motivo });
    log(`[AUDIO] ${id}: ${estado}${motivo ? ' (' + motivo + ')' : ''}`);
    onEstadoAudio(id, estado, motivo);
  };
  const estadoAudio = (id) => estados.get(id) || null;

  // ---- cola de trabajos con concurrencia limitada ----
  let activos = 0;
  const espera = [];
  function encolar(fn) {
    return new Promise((resolve, reject) => {
      const lanzar = () => {
        activos++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            activos--;
            const sig = espera.shift();
            if (sig) sig();
          });
      };
      if (activos < C.CONCURRENCIA) lanzar();
      else espera.push(lanzar);
    });
  }

  // ---- lrclib ----
  async function lrclib(ruta) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), C.TIMEOUT_LRCLIB_MS);
    try {
      const r = await fetchFn(`${C.LRCLIB}${ruta}`, {
        signal: ctl.signal,
        headers: { 'Lrclib-Client': 'karaoke-interactivo (proyecto universitario)' },
      });
      if (!r.ok) throw new Error(`lrclib respondio ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ---- busqueda ----
  const cacheBusqueda = new Map();
  const locales = () => canciones.filter((c) => c.origen !== 'remoto');

  function coincideLocal(c, q) {
    const nq = normalizar(q);
    if (!nq) return true;
    const h = normalizar(`${c.titulo} ${c.artista}`);
    return nq.split(' ').every((w) => h.includes(w));
  }

  const itemLocal = (c) => ({ id: c.id, titulo: c.titulo, artista: c.artista, duracion: Number(c.duracion) || null, fuente: 'local', lista: true });

  // Varias versiones del mismo tema: se queda una sola (la de duracion mas comun).
  function deduplicar(resultados) {
    const grupos = new Map();
    for (const r of resultados) {
      const k = `${normalizar(r.artistName)}|${normalizar(limpiarTitulo(r.trackName || r.name, r.artistName))}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(r);
    }
    const out = [];
    for (const lista of grupos.values()) {
      const ds = lista.map((x) => Math.round(x.duration)).sort((a, b) => a - b);
      const mediana = ds[Math.floor(ds.length / 2)];
      lista.sort((x, y) => Math.abs(x.duration - mediana) - Math.abs(y.duration - mediana));
      out.push(lista[0]);
    }
    return out;
  }

  async function buscarRemoto(q) {
    const clave = normalizar(q);
    const hit = cacheBusqueda.get(clave);
    if (hit && Date.now() - hit.t < C.CACHE_BUSQUEDA_MS) return hit.data;
    const crudo = await lrclib(`/search?q=${encodeURIComponent(q)}`);
    const validos = (Array.isArray(crudo) ? crudo : []).filter(
      (r) => r.syncedLyrics && !r.instrumental && r.duration >= 60 && r.duration <= 600 && (r.trackName || r.name) && r.artistName
    );
    const data = deduplicar(validos).map((r) => ({
      id: `lrclib-${r.id}`,
      titulo: limpiarTitulo(r.trackName || r.name, r.artistName),
      artista: r.artistName,
      duracion: Math.round(r.duration),
      fuente: 'lrclib',
      lista: false, // se prepara (descarga + valida) al elegirla
    }));
    cacheBusqueda.set(clave, { t: Date.now(), data });
    if (cacheBusqueda.size > 200) cacheBusqueda.delete(cacheBusqueda.keys().next().value);
    return data;
  }

  // pagina: 0,1,2...  q vacia = biblioteca local completa
  async function buscar(q = '', pagina = 0) {
    const consulta = String(q || '').trim().slice(0, 80);
    const loc = locales().filter((c) => coincideLocal(c, consulta)).map(itemLocal);
    let remotos = [];
    let errorRemoto = null;
    if (consulta.length >= 2 && remotoDisponible()) {
      try {
        const nombres = new Set(loc.map((c) => `${normalizar(c.artista)}|${normalizar(c.titulo)}`));
        remotos = (await buscarRemoto(consulta)).filter((r) => !nombres.has(`${normalizar(r.artista)}|${normalizar(r.titulo)}`));
      } catch (e) {
        errorRemoto = e.name === 'AbortError' ? 'La búsqueda tardó demasiado' : 'No se pudo consultar el catálogo online';
        log(`[catalogo] busqueda remota fallo (${e.message})`);
      }
    }
    const todos = [...loc, ...remotos];
    const desde = Math.max(0, Number(pagina) || 0) * C.POR_PAGINA;
    return {
      q: consulta,
      pagina: Number(pagina) || 0,
      items: todos.slice(desde, desde + C.POR_PAGINA),
      total: todos.length,
      hayMas: todos.length > desde + C.POR_PAGINA,
      remoto: remotoDisponible(),
      error: errorRemoto,
    };
  }

  // ---- resolver: de un id (local o lrclib-N) a una cancion registrada en el escenario ----
  const sinPromesa = (m) => ({ ...m });

  async function resolver(id) {
    if (!idSeguro(id)) throw new Error('id invalido');
    const ya = canciones.find((c) => c.id === id);
    if (ya) return sinPromesa(ya);
    const m = /^lrclib-(\d+)$/.exec(id);
    if (!m) throw new Error('cancion desconocida');
    if (!remotoDisponible()) throw new Error('este equipo no puede preparar canciones online');
    const r = await lrclib(`/get/${m[1]}`);
    if (!r?.syncedLyrics || !(r.trackName || r.name)) throw new Error('esa cancion no tiene letra sincronizada');
    await mkdir(dirCache, { recursive: true });
    await writeFile(join(dirCache, `${id}.lrc`), r.syncedLyrics, 'utf8');
    const meta = {
      id,
      titulo: limpiarTitulo(r.trackName || r.name, r.artistName),
      artista: r.artistName,
      duracion: Math.round(r.duration),
      voces: 'solo',
      lrc: `/cache-audio/${id}.lrc`,
      audio: `/cache-audio/${id}.m4a`,
      offsetLetra: 0,
      origen: 'remoto',
    };
    canciones.push(meta);
    log(`[SONG] registrada ${id}: ${meta.artista} - ${meta.titulo} (${meta.duracion}s)`);
    return sinPromesa(meta);
  }

  // ---- ffmpeg ----
  async function sondear(archivo) {
    try {
      const { stderr } = await correr(ffmpeg, ['-hide_banner', '-t', '90', '-i', archivo, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { timeout: 60_000 });
      return parsearInfoFfmpeg(stderr);
    } catch (e) {
      // ffmpeg devuelve error si el archivo esta roto; si imprimio info igual la leemos
      const info = parsearInfoFfmpeg(e.stderr || '');
      if (info.duracion) return info;
      throw new Error(`ffmpeg no pudo leer el archivo (${(e.stderr || e.message || '').split('\n').slice(-2, -1)[0] || 'error'})`);
    }
  }

  // ---- adquirir el audio ----
  async function adquirirRemoto(meta) {
    const base = join(dirCache, meta.id);
    log(`[SONG] buscando fuente de audio para ${meta.artista} - ${meta.titulo}`);
    const consulta = `${meta.artista} ${meta.titulo}`;
    const { stdout } = await correr(
      ytdlp[0],
      [...ytdlp.slice(1), '--dump-json', '--flat-playlist', '--no-warnings', `ytsearch8:${consulta} audio`],
      { timeout: C.TIMEOUT_BUSQUEDA_MS }
    );
    const cands = String(stdout)
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => {
        try {
          const j = JSON.parse(l);
          return { id: j.id, title: j.title, duration: j.duration, channel: j.channel || j.uploader };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const elegido = elegirCandidato(cands, meta);
    if (!elegido) throw new Error('no hay una version cuya duracion coincida con la letra');
    log(`[AUDIO] fuente elegida: ${elegido.id} "${elegido.title}" (${elegido.duration}s vs ${meta.duracion}s)${elegido.desfaseProbable ? ' ⚠ desfase probable' : ''}`);
    await correr(
      ytdlp[0],
      [
        ...ytdlp.slice(1),
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--no-playlist', '--no-warnings', '--no-part', '--socket-timeout', '20', '--retries', '2',
        '-o', `${base}.%(ext)s`,
        `https://www.youtube.com/watch?v=${elegido.id}`,
      ],
      { timeout: C.TIMEOUT_DESCARGA_MS }
    );
    const archivos = (await readdir(dirCache)).filter((f) => f.startsWith(`${meta.id}.`) && !f.endsWith('.lrc') && !f.endsWith('.tmp.m4a'));
    if (!archivos.length) throw new Error('la descarga no genero ningun archivo');
    const origen = join(dirCache, archivos[0]);
    const destino = `${base}.m4a`;
    if (!origen.endsWith('.m4a')) {
      const tmp = `${base}.tmp.m4a`;
      await correr(ffmpeg, ['-y', '-i', origen, '-vn', '-c:a', 'aac', '-b:a', '160k', tmp], { timeout: 120_000 });
      await rm(origen, { force: true });
      await rename(tmp, destino);
    }
    return { desfaseProbable: elegido.desfaseProbable };
  }

  async function prepararAudio(id) {
    const meta = canciones.find((c) => c.id === id);
    if (!meta) throw new Error('cancion desconocida');
    emitir(id, 'preparando');
    if (meta.origen === 'remoto') {
      const archivo = join(dirCache, `${id}.m4a`);
      if (!existsSync(archivo)) {
        if (!remotoDisponible()) throw new Error('este equipo no puede bajar canciones online');
        const r = await encolar(() => adquirirRemoto(meta));
        meta.desfaseProbable = !!r.desfaseProbable;
      }
      const info = await sondear(archivo);
      const falla = veredictoArchivo(info, meta.duracion);
      if (falla) {
        await rm(archivo, { force: true }).catch(() => {});
        throw new Error(falla);
      }
      log(`[AUDIO] ${id} validada: ${Math.round(info.duracion)}s, volumen medio ${info.volumenMedio} dB`);
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
      if (meta.audioRemoto) return; // el cliente cae a la copia de Supabase
      throw new Error('falta el archivo de audio en este equipo');
    }
    const info = await sondear(archivo);
    const falla = veredictoArchivo(info, null);
    if (falla) throw new Error(falla);
    log(`[AUDIO] ${id} validada: ${Math.round(info.duracion)}s, volumen medio ${info.volumenMedio} dB`);
  }

  // Empieza (o recupera) la preparacion; es idempotente: varias llamadas comparten la misma.
  function asegurarAudio(id) {
    const e = estados.get(id);
    if (e?.promesa) return e.promesa;
    if (e?.estado === 'lista') return Promise.resolve();
    const promesa = prepararAudio(id)
      .then(() => {
        estados.set(id, { estado: 'lista', motivo: null });
        onEstadoAudio(id, 'lista', null);
        limpiarCache().catch(() => {});
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

  // ---- limpieza del cache (no se borra lo que esta en la fila) ----
  async function limpiarCache() {
    let lista;
    try {
      lista = await readdir(dirCache);
    } catch {
      return;
    }
    const audios = lista.filter((f) => f.endsWith('.m4a'));
    if (audios.length <= C.MAX_ARCHIVOS) return;
    const protegidas = enUso();
    const info = [];
    for (const f of audios) {
      const id = f.replace(/\.m4a$/, '');
      if (protegidas.has(id)) continue;
      try {
        info.push({ f, id, t: (await stat(join(dirCache, f))).mtimeMs });
      } catch {}
    }
    info.sort((a, b) => a.t - b.t);
    for (const x of info.slice(0, audios.length - C.MAX_ARCHIVOS)) {
      await rm(join(dirCache, x.f), { force: true }).catch(() => {});
      await rm(join(dirCache, `${x.id}.lrc`), { force: true }).catch(() => {});
      estados.delete(x.id);
    }
  }

  // meta completa que necesita la pantalla para reproducir (con el estado actual del audio)
  function metaPublica(id) {
    const c = canciones.find((x) => x.id === id);
    if (!c) return null;
    return {
      id: c.id,
      titulo: c.titulo,
      artista: c.artista,
      duracion: c.duracion,
      voces: c.voces ?? 'solo',
      lrc: c.lrc,
      audio: c.audio,
      audioRemoto: c.audioRemoto || null,
      offsetLetra: c.offsetLetra || 0,
      origen: c.origen || 'local',
      desfaseProbable: !!c.desfaseProbable,
      audioEstado: estados.get(id)?.estado || 'sin_preparar',
      audioMotivo: estados.get(id)?.motivo || null,
    };
  }

  return {
    detectar,
    buscar,
    resolver,
    asegurarAudio,
    reintentar,
    estadoAudio,
    metaPublica,
    limpiarCache,
    sondear,
    get remoto() {
      return remotoDisponible();
    },
    get motivoCapacidad() {
      return capacidadMotivo;
    },
  };
}
