// Cliente de la YouTube Data API v3 (simulada): parametros, ahorro de cuota, verificacion de
// reproducibilidad, paginacion con nextPageToken, cache y errores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearYouTube, YouTubeError, esVideoId } from '../youtube.js';

const vid = (n) => String(n).padStart(11, 'a'); // ids de 11 caracteres validos

// API falsa. busquedas: { 'texto de consulta': [ {id,titulo,canal,desc?} ... ] o { items, next } }
// detalles: { id: { dur:'PT3M30S', embeddable:true, privacy:'public', region:{blocked:[]}, live:'none', edad:false } }
function api({ busquedas = {}, detalles = {}, errorBusqueda = null, key = 'CLAVE' } = {}) {
  const llamadas = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    llamadas.push({ ruta: u.pathname.split('/').pop(), params: Object.fromEntries(u.searchParams) });
    if (errorBusqueda) {
      if (errorBusqueda === 'red') throw new Error('ENOTFOUND');
      return { ok: false, status: errorBusqueda.status, json: async () => ({ error: { errors: [{ reason: errorBusqueda.reason }] } }) };
    }
    const ruta = u.pathname.split('/').pop();
    if (ruta === 'search') {
      const q = u.searchParams.get('q');
      const tk = u.searchParams.get('pageToken');
      const def = busquedas[tk ? `${q}#${tk}` : q] ?? { items: [] };
      const lista = Array.isArray(def) ? def : def.items;
      return {
        ok: true, status: 200,
        json: async () => ({
          nextPageToken: Array.isArray(def) ? undefined : def.next,
          items: lista.map((x) => ({ id: { videoId: x.id }, snippet: { title: x.titulo, channelTitle: x.canal || 'Canal', description: x.desc || '', thumbnails: { medium: { url: `https://i.ytimg.com/vi/${x.id}/mqdefault.jpg` } } } })),
        }),
      };
    }
    if (ruta === 'videos') {
      const ids = u.searchParams.get('id').split(',');
      return {
        ok: true, status: 200,
        json: async () => ({
          items: ids.filter((id) => detalles[id] !== null).map((id) => {
            const d = detalles[id] || {};
            return {
              id,
              snippet: { title: d.titulo || `video ${id}`, channelTitle: 'Canal', description: '', liveBroadcastContent: d.live || 'none', thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } } },
              contentDetails: { duration: d.dur || 'PT3M30S', regionRestriction: d.region, contentRating: d.edad ? { ytRating: 'ytAgeRestricted' } : {} },
              status: { embeddable: d.embeddable ?? true, privacyStatus: d.privacy || 'public', uploadStatus: 'processed' },
            };
          }),
        }),
      };
    }
    throw new Error(`ruta inesperada ${ruta}`);
  };
  const yt = crearYouTube({ apiKey: key, base: 'http://api.test/youtube/v3', fetchFn });
  return { yt, llamadas };
}

const K = (n, titulo = `Shape of You (Karaoke Version) ${n}`, canal = 'Sing King') => ({ id: vid(n), titulo, canal });

test('los pedidos usan la API oficial con los parametros que evitan videos no reproducibles', async () => {
  const { yt, llamadas } = api({ busquedas: { 'Shape of You karaoke': Array.from({ length: 6 }, (_, i) => K(i + 1)) } });
  await yt.buscar('Shape of You');
  const s = llamadas.find((l) => l.ruta === 'search').params;
  assert.equal(s.type, 'video');
  assert.equal(s.videoEmbeddable, 'true');
  assert.equal(s.videoSyndicated, 'true');
  assert.equal(s.q, 'Shape of You karaoke', 'la primera consulta agrega "karaoke"');
  assert.equal(s.key, 'CLAVE');
  assert.equal(s.regionCode, 'AR');
  assert.ok(llamadas.some((l) => l.ruta === 'videos' && l.params.part.includes('status')), 'y se verifica status.embeddable con videos.list');
});

test('ahorra cuota: con suficientes karaoke en la primera consulta no hace mas busquedas', async () => {
  const { yt, llamadas } = api({ busquedas: { 'Shape of You karaoke': Array.from({ length: 8 }, (_, i) => K(i + 1)) } });
  const r = await yt.buscar('Shape of You');
  assert.equal(llamadas.filter((l) => l.ruta === 'search').length, 1);
  assert.equal(r.cuota.usadas, 101, '1 busqueda (100) + 1 videos.list (1)');
  assert.equal(r.items.length, 8);
  assert.ok(r.items.every((i) => i.karaoke.esKaraoke && i.id === `yt-${i.videoId}`));
});

test('si la primera consulta no trae karaoke prueba alternativas y combina sin duplicados', async () => {
  const { yt, llamadas } = api({
    busquedas: {
      'Shape of You karaoke': [{ id: vid(1), titulo: 'Ed Sheeran - Shape of You (Official Music Video)', canal: 'Ed Sheeran' }],
      'Shape of You karaoke version': [K(2), { id: vid(1), titulo: 'Ed Sheeran - Shape of You (Official Music Video)', canal: 'Ed Sheeran' }],
      'Shape of You instrumental sing along': [K(3, 'Shape of You (Instrumental Sing Along)', 'Backing'), K(4)],
    },
  });
  const r = await yt.buscar('Shape of You');
  const consultas = llamadas.filter((l) => l.ruta === 'search').map((l) => l.params.q);
  assert.deepEqual(consultas, ['Shape of You karaoke', 'Shape of You karaoke version', 'Shape of You instrumental sing along'], 'tope de 3 busquedas por pedido');
  const ids = r.items.map((i) => i.videoId);
  assert.equal(new Set(ids).size, ids.length, 'sin duplicados');
  assert.ok(ids.includes(vid(2)) && ids.includes(vid(3)) && ids.includes(vid(4)));
  assert.ok(ids.indexOf(vid(1)) === -1 || ids.indexOf(vid(1)) > ids.indexOf(vid(2)), 'el videoclip oficial, si aparece, va despues');
});

test('NUNCA devuelve vacio si YouTube trajo algo: sin karaoke igual muestra lo mejor', async () => {
  const oficial = { id: vid(1), titulo: 'Ed Sheeran - Shape of You (Official Music Video)', canal: 'Ed Sheeran' };
  const { yt } = api({ busquedas: { 'Shape of You karaoke': [oficial], 'Shape of You karaoke version': [oficial], 'Shape of You instrumental sing along': [oficial] } });
  const r = await yt.buscar('Shape of You');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].karaoke.esKaraoke, false, 'y no se hace pasar por karaoke');
});

test('descarta lo que no se puede reproducir: no embebible, privado, en vivo, +18, region bloqueada, borrado', async () => {
  const lista = Array.from({ length: 8 }, (_, i) => K(i + 1));
  const { yt } = api({
    busquedas: { 'Shape of You karaoke': lista },
    detalles: {
      [vid(1)]: { embeddable: false },
      [vid(2)]: { privacy: 'private' },
      [vid(3)]: { live: 'live' },
      [vid(4)]: { edad: true },
      [vid(5)]: { region: { blocked: ['AR'] } },
      [vid(6)]: null, // YouTube no lo devuelve: ya no existe
      [vid(7)]: { region: { allowed: ['US'] } },
      // el 8 es normal
    },
  });
  const r = await yt.buscar('Shape of You');
  assert.deepEqual(r.items.map((i) => i.videoId), [vid(8)]);
});

test('la duracion viene de videos.list (ISO 8601) y se devuelve en segundos con thumbnail', async () => {
  const { yt } = api({ busquedas: { 'Shape of You karaoke': Array.from({ length: 5 }, (_, i) => K(i + 1)) }, detalles: { [vid(1)]: { dur: 'PT5M55S' } } });
  const r = await yt.buscar('Shape of You');
  const x = r.items.find((i) => i.videoId === vid(1));
  assert.equal(x.duracion, 355);
  assert.match(x.thumbnail, /^https:\/\/i\.ytimg\.com\//);
  assert.ok(x.titulo && x.canal);
});

test('paginacion: nextPageToken viaja opaco y el siguiente pedido continua esa busqueda', async () => {
  const p1 = Array.from({ length: 6 }, (_, i) => K(i + 1));
  const p2 = Array.from({ length: 6 }, (_, i) => K(i + 11));
  const { yt, llamadas } = api({ busquedas: { 'Shape of You karaoke': { items: p1, next: 'YTTOK1' }, 'Shape of You karaoke#YTTOK1': { items: p2 } } });
  const a = await yt.buscar('Shape of You');
  assert.equal(a.items.length, 6);
  assert.ok(a.nextPageToken, 'hay mas');
  const b = await yt.buscar('ignorado', a.nextPageToken);
  assert.deepEqual(b.items.map((i) => i.videoId), p2.map((x) => x.id), 'la pagina 2 son los resultados siguientes');
  assert.equal(b.nextPageToken, null, 'y ahi se acaba');
  const s2 = llamadas.filter((l) => l.ruta === 'search').at(-1).params;
  assert.equal(s2.pageToken, 'YTTOK1');
  assert.equal(s2.q, 'Shape of You karaoke');
});

test('un token de paginacion roto se ignora sin romper', async () => {
  const { yt } = api({ busquedas: { 'Shape of You karaoke': Array.from({ length: 5 }, (_, i) => K(i + 1)) } });
  const r = await yt.buscar('Shape of You', 'basura-que-no-es-un-token');
  assert.equal(r.items.length, 5);
});

test('cache + unificacion: la misma busqueda no vuelve a gastar cuota, ni en paralelo', async () => {
  const { yt, llamadas } = api({ busquedas: { 'Shape of You karaoke': Array.from({ length: 5 }, (_, i) => K(i + 1)) } });
  const [a, b] = await Promise.all([yt.buscar('Shape of You'), yt.buscar('shape of you ')]);
  await yt.buscar('Shape of You');
  assert.equal(llamadas.filter((l) => l.ruta === 'search').length, 1);
  assert.equal(a.items.length, b.items.length);
});

test('consulta muy corta no consulta la API', async () => {
  const { yt, llamadas } = api();
  assert.deepEqual((await yt.buscar('a')).items, []);
  assert.equal(llamadas.length, 0);
});

test('titulos con entidades HTML se decodifican', async () => {
  const { yt } = api({ busquedas: { 'dont stop karaoke': Array.from({ length: 5 }, (_, i) => ({ id: vid(i + 1), titulo: 'Don&#39;t Stop Me Now &amp; Go (Karaoke)', canal: 'Sing King' })) } });
  const r = await yt.buscar("dont stop");
  assert.equal(r.items[0].titulo, "Don't Stop Me Now & Go (Karaoke)");
});

// ------------------------------------------------------------------------- errores y cuota
test('sin clave: error claro (no se rompe ni se inventan resultados)', async () => {
  const { yt } = api({ key: '' });
  assert.equal(yt.configurada, false);
  await assert.rejects(() => yt.buscar('Shape of You'), (e) => e instanceof YouTubeError && e.codigo === 'sin_clave' && /YOUTUBE_API_KEY/.test(e.message));
});

test('cuota agotada segun YouTube (403 quotaExceeded) -> error claro y no insiste', async () => {
  const { yt, llamadas } = api({ errorBusqueda: { status: 403, reason: 'quotaExceeded' } });
  await assert.rejects(() => yt.buscar('Shape of You'), (e) => e.codigo === 'cuota_agotada');
  const n = llamadas.length;
  await assert.rejects(() => yt.buscar('otra cosa'), (e) => e.codigo === 'cuota_agotada');
  assert.equal(llamadas.length, n, 'una vez agotada no vuelve a pegarle a la API');
  assert.equal(yt.cuota().agotada, true);
});

test('cuota propia: se frena antes del limite diario y se renueva al dia siguiente', async () => {
  let t = Date.UTC(2026, 9, 5, 12);
  const llamadas = [];
  const fetchFn = async (url) => {
    const ruta = new URL(url).pathname.split('/').pop();
    llamadas.push(ruta);
    if (ruta === 'search') return { ok: true, json: async () => ({ items: Array.from({ length: 6 }, (_, i) => ({ id: { videoId: vid(i + 1) }, snippet: { title: `Tema (Karaoke) ${i}`, channelTitle: 'Sing King', thumbnails: {} } })) }) };
    return { ok: true, json: async () => ({ items: Array.from({ length: 6 }, (_, i) => ({ id: vid(i + 1), snippet: {}, contentDetails: { duration: 'PT3M' }, status: { embeddable: true, privacyStatus: 'public' } })) }) };
  };
  const yt = crearYouTube({ apiKey: 'K', base: 'http://x', fetchFn, ahora: () => t, config: { LIMITE_DIARIO: 250 } });
  await yt.buscar('tema uno');
  await yt.buscar('tema dos');
  await assert.rejects(() => yt.buscar('tema tres'), (e) => e.codigo === 'cuota_agotada');
  t += 24 * 3600_000; // otro dia
  const r = await yt.buscar('tema cuatro');
  assert.ok(r.items.length > 0, 'a la medianoche se renueva');
  assert.ok(r.cuota.usadas <= 101);
});

test('clave invalida y error de red se distinguen', async () => {
  await assert.rejects(() => api({ errorBusqueda: { status: 400, reason: 'keyInvalid' } }).yt.buscar('Shape of You'), (e) => e.codigo === 'clave_invalida');
  await assert.rejects(() => api({ errorBusqueda: 'red' }).yt.buscar('Shape of You'), (e) => e.codigo === 'red');
});

// ------------------------------------------------------------------------------- detalle()
test('detalle: un video concreto se verifica antes de aceptarlo como cancion', async () => {
  const { yt } = api({ detalles: { [vid(1)]: { dur: 'PT4M10S' }, [vid(2)]: { embeddable: false }, [vid(3)]: null } });
  const ok = await yt.detalle(vid(1));
  assert.equal(ok.duracion, 250);
  await assert.rejects(() => yt.detalle(vid(2)), (e) => e.codigo === 'no_reproducible' && /fuera de YouTube/.test(e.message));
  await assert.rejects(() => yt.detalle(vid(3)), (e) => e.codigo === 'no_reproducible');
  await assert.rejects(() => yt.detalle('../../x'), (e) => e.codigo === 'id_invalido');
  assert.equal(esVideoId(vid(1)), true);
  assert.equal(esVideoId('corto'), false);
});
