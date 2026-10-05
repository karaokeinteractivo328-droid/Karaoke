// Cliente de la YouTube Data API v3 (API OFICIAL). Solo BUSCA y VERIFICA: no descarga ni extrae
// audio ni video de YouTube; la reproduccion es el reproductor embebido de YouTube (IFrame API).
//
//   search.list  (100 unidades) : type=video + videoEmbeddable=true + videoSyndicated=true, para que
//                                  no aparezcan videos que no se pueden reproducir en la web
//   videos.list  (1 unidad)     : duracion + status.embeddable / privacyStatus / restricciones
//
// COSTO: la cuota gratuita es 10.000 unidades por dia: ~100 busquedas. Por eso:
//   - cada pedido hace las MENOS consultas posibles (karaoke primero; alternativas solo si hace falta)
//   - los resultados se cachean 6 h y los pedidos iguales simultaneos se unifican
//   - se lleva la cuenta y, al agotarse, se avisa claro en vez de fallar en silencio

import { puntuarKaraoke, planDeConsultas, seleccionarParaMostrar, UMBRAL } from './karaoke.js';
import { duracionISO, decodificarHtml, normalizar } from './texto.js';

export class YouTubeError extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.codigo = codigo;
  }
}

const COSTO = { search: 100, videos: 1 };
const ID_VIDEO = /^[A-Za-z0-9_-]{11}$/;
export const esVideoId = (s) => ID_VIDEO.test(String(s || ''));

// la cuota se renueva a medianoche de California (Pacific); alcanza con una aproximacion estable
const diaCuota = (ms) => new Date(ms - 8 * 3600_000).toISOString().slice(0, 10);

const codificar = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decodificar(t) {
  try {
    const o = JSON.parse(Buffer.from(String(t), 'base64url').toString('utf8'));
    return o && typeof o.q === 'string' && o.c && typeof o.c === 'object' ? o : null;
  } catch {
    return null;
  }
}

export function crearYouTube({
  apiKey = process.env.YOUTUBE_API_KEY,
  base = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3',
  fetchFn = (...a) => globalThis.fetch(...a),
  ahora = () => Date.now(),
  log = () => {},
  config = {},
} = {}) {
  const C = {
    LIMITE_DIARIO: 9_500, // margen sobre las 10.000 gratuitas
    MAX_BUSQUEDAS_POR_PEDIDO: 3,
    POR_CONSULTA: 25,
    CACHE_MS: 6 * 3600_000,
    TIMEOUT_MS: 10_000,
    REGION: 'AR',
    IDIOMA: 'es',
    ...config,
  };

  // ---- cuota ----
  let cuota = { dia: diaCuota(ahora()), usadas: 0, agotadaAPI: false };
  function revisarDia() {
    const d = diaCuota(ahora());
    if (d !== cuota.dia) cuota = { dia: d, usadas: 0, agotadaAPI: false };
  }
  function gastar(costo) {
    revisarDia();
    if (cuota.agotadaAPI || cuota.usadas + costo > C.LIMITE_DIARIO) {
      throw new YouTubeError('cuota_agotada', 'Se agotó la cuota diaria de búsquedas de YouTube. Probá mañana o elegí una de las canciones disponibles.');
    }
    cuota.usadas += costo;
  }

  async function llamar(ruta, params, costo) {
    if (!apiKey) throw new YouTubeError('sin_clave', 'La búsqueda de YouTube no está configurada (falta YOUTUBE_API_KEY en el server).');
    gastar(costo);
    const url = new URL(`${base}/${ruta}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    url.searchParams.set('key', apiKey);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), C.TIMEOUT_MS);
    let r;
    try {
      r = await fetchFn(url, { signal: ctl.signal });
    } catch (e) {
      throw new YouTubeError('red', e.name === 'AbortError' ? 'YouTube tardó demasiado en responder.' : 'No se pudo conectar con YouTube.');
    } finally {
      clearTimeout(t);
    }
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const motivo = j?.error?.errors?.[0]?.reason || j?.error?.status || String(r.status);
      log(`[youtube] ${ruta} fallo: ${r.status} ${motivo}`);
      if (/quota/i.test(motivo) || /rateLimit/i.test(motivo)) {
        cuota.agotadaAPI = true;
        throw new YouTubeError('cuota_agotada', 'Se agotó la cuota diaria de búsquedas de YouTube. Probá mañana o elegí una de las canciones disponibles.');
      }
      if (r.status === 400 || r.status === 401 || /keyInvalid|API_KEY|forbidden|accessNotConfigured/i.test(motivo)) {
        throw new YouTubeError('clave_invalida', 'La clave de la API de YouTube no es válida o no tiene habilitada la YouTube Data API v3.');
      }
      throw new YouTubeError('api', `YouTube respondió con un error (${motivo}).`);
    }
    return j;
  }

  // ---- search.list ----
  async function buscarVideos(texto, pageToken) {
    const j = await llamar(
      'search',
      {
        part: 'snippet',
        type: 'video',
        q: texto,
        maxResults: C.POR_CONSULTA,
        videoEmbeddable: 'true', // solo videos que se pueden incrustar en nuestra pagina
        videoSyndicated: 'true', // solo los que se pueden reproducir fuera de youtube.com
        regionCode: C.REGION,
        relevanceLanguage: C.IDIOMA,
        safeSearch: 'none',
        pageToken,
        fields: 'nextPageToken,items(id/videoId,snippet(title,channelTitle,description,thumbnails))',
      },
      COSTO.search
    );
    const items = (j.items || [])
      .map((it) => ({
        videoId: it.id?.videoId,
        titulo: decodificarHtml(it.snippet?.title),
        canal: decodificarHtml(it.snippet?.channelTitle),
        descripcion: decodificarHtml(it.snippet?.description),
        thumbnail: elegirThumbnail(it.snippet?.thumbnails),
      }))
      .filter((x) => esVideoId(x.videoId));
    return { items, nextPageToken: j.nextPageToken || null };
  }

  const elegirThumbnail = (t) => t?.medium?.url || t?.high?.url || t?.default?.url || t?.standard?.url || null;

  // ---- videos.list: duracion + "se puede reproducir?" ----
  // Devuelve Map(videoId -> { duracion, embebible, motivo }) ; motivo = por que NO sirve
  async function verificar(ids) {
    const out = new Map();
    const unicos = [...new Set(ids.filter(esVideoId))];
    for (let i = 0; i < unicos.length; i += 50) {
      const lote = unicos.slice(i, i + 50);
      const j = await llamar(
        'videos',
        {
          part: 'snippet,contentDetails,status',
          id: lote.join(','),
          fields: 'items(id,snippet(title,channelTitle,description,thumbnails,liveBroadcastContent),contentDetails(duration,regionRestriction,contentRating),status(embeddable,privacyStatus,uploadStatus))',
        },
        COSTO.videos
      );
      for (const v of j.items || []) {
        const rr = v.contentDetails?.regionRestriction;
        let motivo = null;
        if (v.status?.embeddable === false) motivo = 'el dueño no permite reproducirlo fuera de YouTube';
        else if (v.status?.privacyStatus && v.status.privacyStatus !== 'public') motivo = 'el video no es público';
        else if (v.status?.uploadStatus && v.status.uploadStatus !== 'processed') motivo = 'el video todavía se está procesando';
        else if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') motivo = 'es una transmisión en vivo';
        else if (v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') motivo = 'tiene restricción de edad (no se puede incrustar)';
        else if (rr?.blocked?.includes(C.REGION) || (rr?.allowed && !rr.allowed.includes(C.REGION))) motivo = `no está disponible en ${C.REGION}`;
        out.set(v.id, {
          videoId: v.id,
          titulo: decodificarHtml(v.snippet?.title),
          canal: decodificarHtml(v.snippet?.channelTitle),
          descripcion: decodificarHtml(v.snippet?.description),
          thumbnail: elegirThumbnail(v.snippet?.thumbnails),
          duracion: duracionISO(v.contentDetails?.duration),
          embebible: !motivo,
          motivo,
        });
      }
      // los ids que YouTube no devolvio ya no existen (borrados / privados)
      for (const id of lote) if (!out.has(id)) out.set(id, { videoId: id, embebible: false, motivo: 'el video ya no existe o es privado' });
    }
    return out;
  }

  // ---- busqueda con filtro karaoke ----
  const cache = new Map(); // clave -> { t, data }
  const enVuelo = new Map();

  async function buscarKaraoke(consulta, pageToken) {
    const estado = pageToken ? decodificar(pageToken) : null;
    const q = String(estado?.q ?? consulta ?? '').trim().slice(0, 100);
    if (q.length < 2) return { q, items: [], nextPageToken: null, cuota: info() };
    const clave = `${normalizar(q)}|${pageToken || ''}`;
    const hit = cache.get(clave);
    if (hit && ahora() - hit.t < C.CACHE_MS) return { ...hit.data, cuota: info(), cache: true };
    if (enVuelo.has(clave)) return enVuelo.get(clave);
    const p = ejecutar(q, estado?.c || {}).then((data) => {
      cache.set(clave, { t: ahora(), data });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return { ...data, cuota: info() };
    }).finally(() => enVuelo.delete(clave));
    enVuelo.set(clave, p);
    return p;
  }

  async function ejecutar(q, tokens) {
    const plan = planDeConsultas(q);
    const candidatos = new Map(); // videoId -> candidato
    const siguientes = {}; // idxConsulta -> nextPageToken
    let busquedas = 0;
    const idxUsados = new Set(Object.keys(tokens).map(Number));

    async function correr(idx, pageToken) {
      busquedas++;
      const r = await buscarVideos(plan[idx], pageToken);
      for (const it of r.items) if (!candidatos.has(it.videoId)) candidatos.set(it.videoId, it);
      if (r.nextPageToken) siguientes[idx] = r.nextPageToken;
      idxUsados.add(idx);
    }

    // aptos = candidatos que ya se ven como karaoke (con lo que se sabe antes de verificar)
    const aptos = () => [...candidatos.values()].filter((c) => {
      const k = puntuarKaraoke({ ...c, duracion: 0 }, q);
      return !k.excluir && k.esKaraoke;
    }).length;

    // 1) lo que ya se estaba paginando
    for (const [idx, tk] of Object.entries(tokens)) {
      if (busquedas >= C.MAX_BUSQUEDAS_POR_PEDIDO) break;
      if (plan[Number(idx)]) await correr(Number(idx), tk);
    }
    // 2) primera pagina: karaoke primero; alternativas solo mientras falten aptos
    let i = 0;
    while (busquedas < C.MAX_BUSQUEDAS_POR_PEDIDO && i < plan.length && aptos() < UMBRAL.CUOTA_MIN_APTOS) {
      if (!idxUsados.has(i)) await correr(i);
      i++;
    }

    // 3) se verifica que se puedan reproducir y se obtiene la duracion
    const det = await verificar([...candidatos.keys()]);
    const puntuados = [];
    for (const c of candidatos.values()) {
      const d = det.get(c.videoId);
      if (!d?.embebible) continue;
      const item = { ...c, duracion: d.duracion, thumbnail: d.thumbnail || c.thumbnail };
      puntuados.push({ ...item, karaoke: puntuarKaraoke(item, q) });
    }
    const elegidos = seleccionarParaMostrar(puntuados);
    const items = elegidos.map((e) => ({
      id: `yt-${e.videoId}`,
      videoId: e.videoId,
      titulo: e.titulo,
      canal: e.canal,
      thumbnail: e.thumbnail,
      duracion: e.duracion,
      karaoke: { score: e.karaoke.score, esKaraoke: e.karaoke.esKaraoke, motivos: e.karaoke.motivos },
      fuente: 'youtube',
      lista: false,
    }));
    log(`[youtube] "${q}": ${candidatos.size} candidatos, ${items.length} para mostrar (${items.filter((x) => x.karaoke.esKaraoke).length} karaoke), cuota ${cuota.usadas}/${C.LIMITE_DIARIO}`);
    return { q, items, nextPageToken: Object.keys(siguientes).length ? codificar({ q, c: siguientes }) : null };
  }

  // Un video concreto (para registrar la cancion elegida o re-registrarla tras un reinicio)
  async function detalle(videoId) {
    if (!esVideoId(videoId)) throw new YouTubeError('id_invalido', 'Ese video no es válido.');
    const d = (await verificar([videoId])).get(videoId);
    if (!d?.embebible) throw new YouTubeError('no_reproducible', `Ese video no se puede reproducir: ${d?.motivo || 'no disponible'}.`);
    return d;
  }

  const info = () => {
    revisarDia();
    return { usadas: cuota.usadas, limite: C.LIMITE_DIARIO, restantes: Math.max(0, C.LIMITE_DIARIO - cuota.usadas), agotada: cuota.agotadaAPI };
  };

  return {
    buscar: buscarKaraoke,
    detalle,
    verificar,
    cuota: info,
    get configurada() {
      return !!apiKey;
    },
  };
}
