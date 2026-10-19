// Seleccion de cancion + video: LRCLIB manda, YouTube se adapta.
//
//   El CATALOGO sale de LRCLIB: solo hay temas con letra sincronizada, asi que toda cancion
//   que se puede elegir tiene letra. Despues, para reproducirla, se busca en YouTube el video que
//   MEJOR CALCE con esa letra. Medido con videos reales:
//     - el audio ORIGINAL (master) de duracion igual a la de la letra calza con desfase ~0: es la
//       unica opcion con sincronia garantizada;
//     - un karaoke regrabado puede durar lo mismo y aun asi tener una intro de ~25 s (Party Tyme),
//       asi que su duracion NO garantiza nada: por eso la version karaoke avisa y se puede alinear.
//
//   Todo lo de este archivo es puro (sin red) para poder probarlo.

import { puntuarKaraoke } from './karaoke.js';
import { normalizar } from './texto.js';

export const TIPOS = { original: 'o', karaoke: 'k' };
export const TOL_EXACTA_S = 2; // video y letra duran igual: mismo master -> letra a tiempo
export const TOL_ALTA_S = 3;
export const TOL_MAX_ORIGINAL_S = 6; // mas que esto no es la misma edicion del tema

// versiones del tema que NO son la grabacion de estudio (tienen otra linea de tiempo)
const OTRA_VERSION = /\b(live|en vivo|concierto|concert|acoustic|acustic[oa]|remix|sped up|slowed|nightcore|8d|mashup|cover|demo|extended|extendida|reaction|reaccion|tutorial|lesson|clase)\b/i;
const ES_KARAOKE = /\b(karaoke|karaok[eê]|instrumental|sing[ -]?along|backing[ -]?track|minus[ -]?one|pista|sin voz|no guide melody)\b/i;
const ES_MASTER = /(official audio|audio oficial|\(audio\)|\[audio\]|provided to youtube|\btopic\b|solo audio|audio only)/i;
const ES_LYRIC = /\b(lyrics?|letra|lyric video)\b/i;
const ES_VIDEO_OFICIAL = /(official (music )?video|video oficial|videoclip|clip oficial)/i;
const CANAL_OFICIAL = /(vevo|\btopic\b|oficial|official|records|music)$/i;

const RUIDO = new Set(['official', 'oficial', 'video', 'audio', 'lyrics', 'lyric', 'letra', 'remastered', 'remaster', 'hd', 'ft', 'feat', 'featuring', 'with', 'version', 'version', 'de', 'la', 'el', 'y', 'the', 'and', 'x']);

// "TINI, Maria Becerra - Miénteme (Video Oficial)" -> "Miénteme"
export function tituloLimpio(trackName) {
  let t = String(trackName || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  const partes = t.split(/\s[-–|]\s/).map((x) => x.trim()).filter(Boolean);
  if (partes.length > 1) t = partes[partes.length - 1];
  return t.replace(/^[-–|:\s]+|[-–|:\s]+$/g, '');
}

const palabras = (t) => normalizar(String(t || '').replace(/\(.*?\)|\[.*?\]/g, ' ')).split(' ').filter((w) => w.length > 1 && !RUIDO.has(w));
const tokensTitulo = (titulo) => [...new Set(palabras(tituloLimpio(titulo)))].sort().join(' ');
const tokensArtista = (artista) => new Set(palabras(artista));
// Mismo tema = mismo titulo y artistas que se solapan ("TINI" y "TINI, Maria Becerra" son el mismo; dos
// artistas distintos con un tema del mismo nombre, no).
export function mismoTema(artistaA, tituloA, artistaB, tituloB) {
  const ta = tokensTitulo(tituloA);
  if (!ta || ta !== tokensTitulo(tituloB)) return false;
  const a = tokensArtista(artistaA);
  return [...tokensArtista(artistaB)].some((w) => a.has(w)) || !a.size || !tokensArtista(artistaB).size;
}

function centroDuracion(durs) {
  // la duracion con mas versiones a +-3 s (esa es la grabacion de estudio); a igualdad, la mas corta
  let mejor = null;
  for (const d of durs) {
    const n = durs.filter((x) => Math.abs(x - d) <= 3).length;
    if (!mejor || n > mejor.n || (n === mejor.n && d < mejor.d)) mejor = { d, n };
  }
  return mejor?.d ?? 0;
}

// Resultado crudo de lrclib /search -> temas distintos con todas sus versiones sincronizadas.
export function agruparTemas(crudo, { max = 15 } = {}) {
  const grupos = [];
  for (const r of Array.isArray(crudo) ? crudo : []) {
    if (!r || typeof r !== 'object') continue;
    if (!r?.syncedLyrics || r.instrumental) continue;
    const nombre = `${r.trackName || r.name || ''}`;
    const dur = Number(r.duration);
    if (!(dur >= 60 && dur <= 600)) continue;
    if (OTRA_VERSION.test(nombre) || ES_KARAOKE.test(nombre)) continue; // no es la de estudio
    const clave = tokensTitulo(nombre);
    if (!clave) continue;
    const version = { id: r.id, duracion: dur, artista: String(r.artistName || '').trim(), titulo: tituloLimpio(nombre), syncedLyrics: r.syncedLyrics };
    const g = grupos.find((x) => x.clave === clave && mismoTema(x.vs[0].artista, x.vs[0].titulo, version.artista, version.titulo));
    if (g) g.vs.push(version);
    else grupos.push({ clave, vs: [version] });
  }
  const temas = [];
  for (const { clave, vs } of grupos) {
    const centro = centroDuracion(vs.map((v) => v.duracion));
    const principales = vs.filter((v) => Math.abs(v.duracion - centro) <= 3);
    const rep = [...principales].sort((a, b) => a.titulo.length - b.titulo.length)[0];
    temas.push({ clave, id: rep.id, artista: rep.artista, titulo: rep.titulo, duracion: Math.round(centro), variantes: vs.map((v) => ({ id: v.id, duracion: v.duracion, syncedLyrics: v.syncedLyrics })) });
  }
  return temas.slice(0, max);
}

// dif entre la duracion de un video y la version de la letra que mas se le parece
export function mejorVariante(duracionVideo, variantes) {
  let mejor = null;
  for (const v of variantes) {
    const dif = Math.abs(Number(duracionVideo) - Number(v.duracion));
    if (!mejor || dif < mejor.dif) mejor = { variante: v, dif };
  }
  return mejor;
}

const puntosDuracion = (dif) => (dif <= 1 ? 80 : dif <= TOL_EXACTA_S ? 65 : dif <= TOL_ALTA_S ? 40 : dif <= TOL_MAX_ORIGINAL_S ? 10 : -dif);

// Puntaje de un video para un tema.  tipo: 'original' (audio de estudio, sincronia garantizada) o
// 'karaoke' (sin voz, la sincronia depende de cada video).
export function puntuarVideo(video, tema, tipo) {
  const texto = `${video.titulo || ''} ${video.canal || ''}`;
  const mv = mejorVariante(video.duracion, tema.variantes);
  if (!mv) return { excluir: true, motivo: 'sin letra' };
  const { dif, variante } = mv;
  if (OTRA_VERSION.test(texto) && !OTRA_VERSION.test(tema.titulo)) return { excluir: true, motivo: 'otra version del tema' };
  const esKaraoke = ES_KARAOKE.test(texto);

  if (tipo === 'original') {
    if (esKaraoke) return { excluir: true, motivo: 'es karaoke' };
    if (dif > TOL_MAX_ORIGINAL_S) return { excluir: true, motivo: `dura ${Math.round(dif)} s distinto a la letra` };
    const master = ES_MASTER.test(texto);
    const lyric = ES_LYRIC.test(texto);
    const videoOficial = ES_VIDEO_OFICIAL.test(texto);
    const canalOficial = CANAL_OFICIAL.test(String(video.canal || '').trim());
    const score = (master ? 40 : lyric ? 25 : videoOficial ? 15 : 0) + (canalOficial ? 15 : 0) + puntosDuracion(dif);
    const nivel = dif <= TOL_EXACTA_S ? 'exacta' : dif <= TOL_ALTA_S ? 'alta' : 'media';
    return { excluir: false, score, dif, variante, nivel, master, confiable: nivel !== 'media' };
  }

  // karaoke
  const k = video.karaoke || puntuarKaraoke(video, `${tema.artista} ${tema.titulo}`);
  if (k.excluir) return { excluir: true, motivo: 'no sirve para karaoke' };
  const score = (k.esKaraoke ? k.score : k.score - 60) + (dif <= 1 ? 40 : dif <= TOL_ALTA_S ? 25 : dif <= TOL_MAX_ORIGINAL_S ? 10 : 0);
  // la duracion NO garantiza que la letra caiga (intros de logo / cuentas regresivas): nunca "confiable"
  return { excluir: false, score, dif, variante, nivel: 'aproximada', master: false, confiable: false, esKaraoke: k.esKaraoke, karaoke: k };
}

// Mejor video de una lista de candidatos (o null si ninguno sirve).
export function elegirVideo(videos, tema, tipo) {
  let mejor = null;
  for (const v of videos) {
    const p = puntuarVideo(v, tema, tipo);
    if (p.excluir) continue;
    if (!mejor || p.score > mejor.p.score) mejor = { video: v, p };
  }
  return mejor;
}

export const consultasDe = (tema, tipo) =>
  tipo === 'original'
    ? [`${tema.artista} ${tema.titulo} official audio`, `${tema.artista} ${tema.titulo}`]
    : [`${tema.artista} ${tema.titulo} karaoke`];
