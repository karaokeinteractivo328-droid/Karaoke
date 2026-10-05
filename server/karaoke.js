// Puntuacion "apto para karaoke" de un resultado de YouTube.
//
// La API de YouTube NO tiene un filtro "karaoke": se busca de forma amplia y se PUNTUA cada
// resultado. Nada esta enterrado en una condicion gigante: todo son TABLAS de reglas
// (termino -> peso) que se pueden leer, ajustar y testear una por una.
//
//   score = terminos a favor + terminos en contra (atenuados si ya es karaoke)
//         + canal + relevancia respecto de lo que pidio la persona + duracion plausible
//
// El filtro NO es estricto: `excluir` es solo para lo que claramente no sirve (no es la
// cancion, reaccion, album completo...). Lo dudoso se ordena mas abajo pero se muestra.

import { normalizar } from './texto.js';

// ----- a favor: la palabra aparece en titulo / canal / descripcion ---------------------
export const A_FAVOR = [
  { id: 'karaoke', re: /\b(karaoke|karaokê|caraoque|karaoké)\b/, peso: 60, fuerte: true },
  { id: 'instrumental', re: /\binstrumental\b/, peso: 45, fuerte: true },
  { id: 'sing-along', re: /\bsing[ -]?along\b/, peso: 50, fuerte: true },
  { id: 'backing-track', re: /\bbacking[ -]?tracks?\b/, peso: 50, fuerte: true },
  { id: 'minus-one', re: /\b(minus[ -]?one|vocal removal|without vocals?|no vocals?|sin voz|sin vocal|pista)\b/, peso: 40, fuerte: true },
  { id: 'karaoke-version', re: /\b(karaoke version|version karaoke|official karaoke|karaoke instrumental)\b/, peso: 20, fuerte: false },
  { id: 'lyrics', re: /\b(lyrics?|letra|letras|con letra)\b/, peso: 15, fuerte: false },
];

// ----- en contra: lo que normalmente NO es una version cantable --------------------------
export const EN_CONTRA = [
  { id: 'video-oficial', re: /\b(official (music )?video|video oficial|videoclip|video clip)\b/, peso: -50 },
  { id: 'music-video', re: /\bmusic video\b/, peso: -40 },
  { id: 'en-vivo', re: /\b(live|en vivo|concert|concierto|tour|festival|unplugged)\b/, peso: -45 },
  { id: 'album', re: /\b(full album|album completo|playlist|nonstop|non stop|megamix|compilation|recopilacion|greatest hits|mix)\b/, peso: -60 },
  { id: 'reaccion', re: /\b(reaction|reacciona|reaccion|reacting)\b/, peso: -70 },
  { id: 'cover', re: /\bcover\b/, peso: -30 },
  { id: 'remix', re: /\b(remix|nightcore|sped up|slowed|reverb|8d audio|mashup)\b/, peso: -35 },
  { id: 'tutorial', re: /\b(tutorial|lesson|lecci[oó]n|clase|como tocar|how to play|chords?|acordes|piano tutorial)\b/, peso: -40 },
  { id: 'trailer', re: /\b(trailer|teaser|behind the scenes|entrevista|interview)\b/, peso: -50 },
];

// canales que se dedican a esto (se suma al termino "karaoke" del nombre del canal)
export const CANALES_KARAOKE = [/sing king/, /karafun/, /zoom karaoke/, /stingray karaoke/, /sunfly/, /party tyme/, /karaoke version/, /singer'?s? edge/, /karaoke (mundial|latino|hits|world)/];

const PALABRAS_VACIAS = new Set(['the', 'a', 'an', 'de', 'la', 'el', 'los', 'las', 'y', 'and', 'by', 'feat', 'ft', 'version', 'con', 'en', 'del', 'official', 'video', 'audio']);
const TERMINOS_KARAOKE_EN_CONSULTA = /\b(karaoke|karaokê|instrumental|sing[ -]?along|backing[ -]?track|minus[ -]?one|caraoque)\b/;

export const UMBRAL = {
  KARAOKE: 40, // desde aca se muestra la etiqueta "KARAOKE"
  MOSTRAR: -25, // por debajo de esto (y sin ser karaoke) se manda al fondo
  RELEVANCIA_MIN: 0.34, // menos que esto de la consulta presente en el titulo = no es esa cancion
  CUOTA_MIN_APTOS: 5, // si hay menos que esto de karaoke se prueban consultas alternativas
};

const suma = (reglas, texto) => reglas.filter((r) => r.re.test(texto));

// Cuanto de lo que pidio la persona (sin las palabras de karaoke) esta en el titulo/canal.
export function relevancia(consulta, titulo, canal = '') {
  const ruido = new RegExp(TERMINOS_KARAOKE_EN_CONSULTA.source, 'g');
  const tokens = normalizar(consulta)
    .replace(ruido, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !PALABRAS_VACIAS.has(t));
  if (!tokens.length) return 1;
  const pajar = ` ${normalizar(titulo)} ${normalizar(canal)} `;
  const hay = tokens.filter((t) => pajar.includes(t)).length;
  return hay / tokens.length;
}

function puntosDuracion(seg) {
  if (!seg) return 0;
  if (seg < 60) return -40;
  if (seg < 120) return -10;
  if (seg <= 480) return 0;
  if (seg <= 900) return -15;
  return -60; // mas de 15 min: casi seguro compilacion / album
}

// --------------------------------------------------------------------------------------
// resultado: { titulo, canal, descripcion?, duracion? (s) }   consulta: lo que escribio la persona
// devuelve { score, esKaraoke, relevancia, excluir, motivos: [...] }
export function puntuarKaraoke(resultado, consulta = '') {
  const titulo = normalizar(resultado.titulo);
  const canal = normalizar(resultado.canal);
  const desc = normalizar(String(resultado.descripcion || '').slice(0, 400));
  const motivos = [];
  let score = 0;

  // 1) palabras de karaoke (titulo y canal pesan; la descripcion solo ayuda un poco)
  const aFavor = suma(A_FAVOR, `${titulo} ${canal}`);
  for (const r of aFavor) { score += r.peso; motivos.push(`+${r.peso} ${r.id}`); }
  if (!aFavor.length && /\b(karaoke|instrumental|sing along|backing track)\b/.test(desc)) { score += 10; motivos.push('+10 descripcion'); }
  if (CANALES_KARAOKE.some((re) => re.test(canal))) { score += 30; motivos.push('+30 canal-karaoke'); }
  const esKaraokeFuerte = aFavor.some((r) => r.fuerte) || /karaoke/.test(canal);

  // 2) lo que normalmente no es cantable (se atenua si el titulo ya dice que es karaoke)
  const atenuacion = esKaraokeFuerte ? 0.3 : 1;
  for (const r of suma(EN_CONTRA, titulo)) {
    const p = Math.round(r.peso * atenuacion);
    score += p;
    motivos.push(`${p} ${r.id}`);
  }

  // 3) es la cancion que se pidio?
  const rel = relevancia(consulta, resultado.titulo, resultado.canal);
  const pRel = Math.round((rel - 0.5) * 60);
  score += pRel;
  motivos.push(`${pRel >= 0 ? '+' : ''}${pRel} relevancia(${rel.toFixed(2)})`);

  // 4) duracion plausible
  const pDur = puntosDuracion(resultado.duracion);
  if (pDur) { score += pDur; motivos.push(`${pDur} duracion`); }

  const esKaraoke = esKaraokeFuerte && score >= UMBRAL.KARAOKE - 25 ? true : score >= UMBRAL.KARAOKE;
  // se excluye solo lo que claramente no sirve: no es la cancion, o es una reaccion/album/tutorial sin ser karaoke
  const claramenteMalo = suma(EN_CONTRA, titulo).some((r) => ['reaccion', 'album', 'tutorial', 'trailer'].includes(r.id)) && !esKaraokeFuerte;
  const excluir = rel < UMBRAL.RELEVANCIA_MIN || claramenteMalo;
  return { score, esKaraoke, relevancia: rel, excluir, motivos };
}

// --------------------------------------------------------------------------------------
// Consultas a probar, de la mas especifica a la mas amplia. NO se usan todas siempre
// (cada busqueda de YouTube cuesta cuota): se va de a una hasta tener suficientes aptos.
export function planDeConsultas(consulta) {
  const q = String(consulta || '').trim().replace(/\s+/g, ' ');
  if (!q) return [];
  if (TERMINOS_KARAOKE_EN_CONSULTA.test(normalizar(q))) return [q];
  return [`${q} karaoke`, `${q} karaoke version`, `${q} instrumental sing along`, `${q} backing track`, q];
}

// --------------------------------------------------------------------------------------
// Quita duplicados (mismo video, o misma version subida dos veces) y ordena por relevancia.
// items: [{ videoId, titulo, canal, ..., karaoke: {score,...} }]
export function deduplicarYOrdenar(items) {
  const porId = new Map();
  for (const it of items) {
    const previo = porId.get(it.videoId);
    if (!previo || it.karaoke.score > previo.karaoke.score) porId.set(it.videoId, it);
  }
  // misma "version" (titulo normalizado sin ruido + canal) -> se queda la de mejor puntaje
  const porVersion = new Map();
  for (const it of porId.values()) {
    const k = `${normalizar(it.titulo).replace(/\b(official|hd|4k|lyrics?|audio|video|version)\b/g, '').replace(/\s+/g, ' ').trim()}|${normalizar(it.canal)}`;
    const previo = porVersion.get(k);
    if (!previo || it.karaoke.score > previo.karaoke.score) porVersion.set(k, it);
  }
  return [...porVersion.values()].sort((a, b) => b.karaoke.score - a.karaoke.score);
}

// De los candidatos puntuados decide que mostrar SIN quedarse nunca con la lista vacia:
//   1. los que son karaoke (ordenados)
//   2. despues los dudosos que igual se pueden cantar (score >= MOSTRAR), marcados "sin confirmar"
//   3. si no hay nada de eso, lo mejor que haya (menos lo excluido de verdad)
export function seleccionarParaMostrar(items) {
  const ordenados = deduplicarYOrdenar(items.filter((i) => !i.karaoke.excluir));
  const karaoke = ordenados.filter((i) => i.karaoke.esKaraoke);
  const dudosos = ordenados.filter((i) => !i.karaoke.esKaraoke && i.karaoke.score >= UMBRAL.MOSTRAR);
  if (karaoke.length || dudosos.length) return [...karaoke, ...dudosos];
  return ordenados.slice(0, 10);
}
