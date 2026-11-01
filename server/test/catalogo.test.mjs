// Catalogo: busqueda (biblioteca + LRCLIB), eleccion del video que calza con la letra, y audio local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearCatalogo, separarArtistaTema, parsearInfoFfmpeg, veredictoArchivo, motivoDe } from '../catalogo.js';
import { YouTubeError } from '../youtube.js';

const vid = (n) => String(n).padStart(11, 'a');
const LRC = '[00:10.00] linea uno\n[00:14.00] linea dos\n';

// ------------------------------------------------------------ funciones puras
test('separar artista y tema de un titulo de video de karaoke', () => {
  assert.deepEqual(separarArtistaTema('Queen - Bohemian Rhapsody (Karaoke Version)'), { artista: 'Queen', tema: 'Bohemian Rhapsody' });
  assert.deepEqual(separarArtistaTema('Bohemian Rhapsody (Karaoke Version)'), { artista: '', tema: 'Bohemian Rhapsody' });
  assert.deepEqual(separarArtistaTema('Soda Stereo - De Música Ligera [Instrumental] HD'), { artista: 'Soda Stereo', tema: 'De Música Ligera' });
});

test('validar archivo local: silencio, muy corto, sin audio o de otra duracion se rechazan', () => {
  const ok = parsearInfoFfmpeg('Duration: 00:03:31.05, start: 0\n Stream #0:0: Audio: aac\n mean_volume: -22.1 dB\n max_volume: -1.0 dB');
  assert.equal(ok.duracion, 211.05);
  assert.equal(veredictoArchivo(ok, 211), null);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:03:31.05\n Audio: aac\n mean_volume: -inf dB\n max_volume: -inf dB'), 211), /silencio/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:00:05.00\n Audio: aac\n mean_volume: -20 dB\n max_volume: -1 dB'), 211), /duracion/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:03:31.05\n Video: h264\n'), 211), /pista de audio/);
});

test('motivo del error: la causa real, no el comando que fallo', () => {
  const stderr = ['WARNING: algo', 'ERROR: [x] abc: HTTP Error 403', ''].join('\n');
  const e = Object.assign(new Error('Command failed: algo largo'), { stderr });
  assert.match(motivoDe(e), /HTTP Error 403/);
  assert.equal(motivoDe(new Error('boom\nsegunda')), 'boom');
});


// ---------------------------------------------------------------- escenario de prueba
// lrclib simulado: /search devuelve `pistas`, /get/<id> la pista pedida. YouTube simulado con funciones.
const pista = (id, dur, extra = {}) => ({ id, trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: dur, syncedLyrics: LRC, instrumental: false, ...extra });
const video = (n, dur, titulo = 'Queen - Bohemian Rhapsody (Official Audio)', canal = 'Queen Official') => ({ videoId: vid(n), titulo, canal, thumbnail: `https://i.ytimg.com/vi/${n}.jpg`, duracion: dur });

async function armar({ configurada = true, candidatos, buscarKaraoke, pistas, lrclibCae = false, offsets, elecciones, fallas = 0, config = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-cat-'));
  await mkdir(join(dir, 'cache'), { recursive: true });
  const eventos = [];
  const llamadas = { candidatos: [], karaoke: [], lrclib: [] };
  const canciones = [
    { id: 'corre', titulo: 'Corre', artista: 'Jesse & Joy', duracion: 306, audio: '/canciones/corre/corre.m4a' },
    { id: 'baby', titulo: 'Baby', artista: 'Justin Bieber', duracion: 237, audio: '/canciones/baby/baby.m4a' },
  ];
  const youtube = {
    configurada,
    cuota: () => ({ usadas: 1, limite: 9500 }),
    candidatos: async (q) => {
      llamadas.candidatos.push(q);
      if (candidatos instanceof Error) throw candidatos;
      return { items: candidatos ? candidatos(q) : [], nextPageToken: null };
    },
    buscar: async (q) => {
      llamadas.karaoke.push(q);
      return { items: buscarKaraoke ? buscarKaraoke(q) : [], nextPageToken: null };
    },
  };
  const lista = pistas ?? [pista(1, 355), pista(2, 354)];
  let fallasRestantes = fallas; // las primeras N respuestas de lrclib son 503 ("server busy")
  const fetchFn = async (url) => {
    const u = String(url);
    llamadas.lrclib.push(u);
    if (fallasRestantes > 0) { fallasRestantes--; return { ok: false, status: 503, headers: { get: () => '0' }, json: async () => ({ name: 'ServerOverloaded' }) }; }
    if (lrclibCae) return { ok: false, status: 503, json: async () => ({}) };
    const m = /\/get\/(\d+)/.exec(u);
    if (m) {
      const p = lista.find((x) => x.id === Number(m[1]));
      return p ? { ok: true, json: async () => p } : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, json: async () => lista };
  };
  const cat = crearCatalogo({ canciones, dirLocal: dir, dirCache: join(dir, 'cache'), youtube, offsets, elecciones, fetchFn, config: { ESPERA_REINTENTO_MS: 1, ...config }, ejecutar: async () => ({ stdout: '', stderr: '' }), onEstadoAudio: (id, e, m) => eventos.push([id, e, m]) });
  return { cat, canciones, llamadas, eventos, dir, fallar: (n) => { fallasRestantes = n; }, limpiar: () => rm(dir, { recursive: true, force: true }) };
}
const almacenEnMemoria = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m }; };

// --------------------------------------------------------------------------- busqueda
test('buscar: biblioteca local + temas de LRCLIB (todos con letra), sin gastar nada de cuota de YouTube', async () => {
  const x = await armar({ pistas: [pista(1, 355), pista(2, 354), pista(3, 355, { trackName: 'Bohemian Rhapsody (Live)' }), pista(4, 200, { trackName: 'Otro Tema', artistName: 'Otra' })] });
  const r = await x.cat.buscar('corre');
  assert.equal(r.items[0].id, 'corre');
  assert.equal(r.items[0].fuente, 'local');
  const lr = r.items.filter((i) => i.fuente === 'lrclib');
  assert.deepEqual(lr.map((i) => i.titulo), ['Bohemian Rhapsody', 'Otro Tema'], 'agrupa las versiones y descarta la grabacion en vivo');
  assert.ok(lr.every((i) => i.letra === true && /^lr-\d+$/.test(i.id) && i.duracion > 0), 'todas con letra');
  assert.equal(x.llamadas.candidatos.length + x.llamadas.karaoke.length, 0, 'buscar NO toca YouTube (la cuota se gasta recien al elegir)');
  assert.equal(r.nextPageToken, null);
  await x.limpiar();
});

test('buscar: consulta vacia = biblioteca local, sin tocar LRCLIB ni YouTube', async () => {
  const x = await armar();
  const r = await x.cat.buscar('');
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((i) => i.fuente === 'local' && i.lista));
  assert.equal(x.llamadas.lrclib.length, 0);
  await x.limpiar();
});

test('buscar: sin clave de YouTube solo se ofrece la biblioteca local (nunca temas que no se pueden reproducir)', async () => {
  const x = await armar({ configurada: false });
  const r = await x.cat.buscar('queen');
  assert.ok(r.items.every((i) => i.fuente === 'local'));
  assert.equal(r.error.codigo, 'sin_clave');
  assert.equal(r.remoto, false);
  assert.equal(x.llamadas.lrclib.length, 0);
  await x.limpiar();
});

test('buscar: si LRCLIB no responde se informa claro y la biblioteca local sigue disponible', async () => {
  const x = await armar({ lrclibCae: true });
  const r = await x.cat.buscar('corre');
  assert.equal(r.error.codigo, 'lrclib_ocupado');
  assert.match(r.error.mensaje, /saturado/);
  assert.equal(r.items[0].id, 'corre');
  await x.limpiar();
});

test('buscar: LRCLIB saturado (503) se reintenta y la busqueda sale igual (antes: "no aparece nada")', async () => {
  const x = await armar({ fallas: 3 });
  const r = await x.cat.buscar('queen');
  assert.equal(r.error, null, 'despues de 3 intentos fallidos el 4to anduvo');
  assert.ok(r.items.some((i) => i.fuente === 'lrclib'));
  assert.equal(x.llamadas.lrclib.length, 4);
  await x.limpiar();
});

test('buscar: si LRCLIB sigue caido despues de varios intentos, error claro "saturado" (y la biblioteca local sigue)', async () => {
  const x = await armar({ fallas: 99 });
  const r = await x.cat.buscar('corre');
  assert.equal(r.error.codigo, 'lrclib_ocupado');
  assert.equal(x.llamadas.lrclib.length, 8, 'probo 8 veces antes de rendirse');
  assert.equal(r.items[0].id, 'corre');
  await x.limpiar();
});

test('buscar: si LRCLIB se cae, se usa la copia guardada (aunque ya este vencida) de esa misma busqueda', async () => {
  const x = await armar({ config: { CACHE_LRCLIB_MS: 1 } }); // la copia "vence" enseguida
  const r1 = await x.cat.buscar('queen');
  assert.equal(r1.error, null);
  await new Promise((r) => setTimeout(r, 10));
  x.fallar(99); // y ahora LRCLIB se satura
  const r2 = await x.cat.buscar('queen');
  assert.equal(r2.error, null, 'sin error: se uso la copia guardada');
  assert.deepEqual(r2.items.map((i) => i.id), r1.items.map((i) => i.id), 'los mismos resultados que antes');
  await x.limpiar();
});

test('buscando un ARTISTA salen primero sus canciones y despues las que solo lo nombran', async () => {
  const pistas = [
    pista(11, 200, { trackName: 'Toni y Tini', artistName: 'Varrosi' }),
    pista(12, 183, { trackName: 'Miénteme', artistName: 'TINI' }),
    pista(13, 210, { trackName: 'Princesa', artistName: 'TINI, KAROL G' }),
    pista(14, 190, { trackName: 'Tini-dal', artistName: 'Neoton' }),
  ];
  const x = await armar({ pistas });
  const r = await x.cat.buscar('tini');
  const lr = r.items.filter((i) => i.fuente === 'lrclib');
  assert.deepEqual(lr.slice(0, 2).map((i) => i.artista.startsWith('TINI')), [true, true], 'primero las de TINI');
  assert.ok(lr.length === 4);
  await x.limpiar();
});

test('elegir una cancion que aparecio en la busqueda NO vuelve a pedirle nada a LRCLIB (antes fallaba con 503 al elegir)', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)], buscarKaraoke: () => [] });
  await x.cat.buscar('queen');
  const antes = x.llamadas.lrclib.length;
  // a partir de ahora LRCLIB esta caido: igual se puede elegir
  const y = x; // mismo catalogo
  const m = await y.cat.resolver('lr-1-o');
  assert.equal(m.videoId, vid(2));
  assert.equal(x.llamadas.lrclib.length, antes, 'cero pedidos a LRCLIB al elegir');
  await x.limpiar();
});

test('elegir sin haberla visto en esta sesion y con LRCLIB saturado: error claro (no "no se pudo cargar")', async () => {
  const x = await armar({ fallas: 99, candidatos: () => [video(2, 355)] });
  await assert.rejects(() => x.cat.resolver('lr-1-o'), (e) => e.codigo === 'lrclib_ocupado' && /saturado/.test(e.message));
  await x.limpiar();
});

test('elegir con LRCLIB saturado se recupera apenas vuelve (reintenta dentro del mismo pedido)', async () => {
  const x = await armar({ fallas: 2, candidatos: () => [video(2, 355)] });
  const m = await x.cat.resolver('lr-1-o');
  assert.equal(m.videoId, vid(2));
  await x.limpiar();
});

test('tras un reinicio, una cancion ya elegida se registra desde el disco (ni LRCLIB ni YouTube)', async () => {
  const elecciones = almacenEnMemoria();
  const x = await armar({ elecciones, candidatos: () => [video(2, 355)] });
  await x.cat.resolver('lr-1-o');
  // otro "arranque" del server (comparte disco y elecciones) con LRCLIB y YouTube caidos
  const { crearCatalogo: crear } = await import('../catalogo.js');
  const canciones2 = [];
  const cat2 = crear({
    canciones: canciones2, dirLocal: x.dir, dirCache: join(x.dir, 'cache'), elecciones,
    youtube: { configurada: true, cuota: () => ({}), candidatos: async () => { throw new Error('no deberia ir a YouTube'); }, buscar: async () => { throw new Error('no deberia ir a YouTube'); } },
    fetchFn: async () => ({ ok: false, status: 503, headers: { get: () => '0' }, json: async () => ({}) }),
    config: { ESPERA_REINTENTO_MS: 1 }, ejecutar: async () => ({ stdout: '', stderr: '' }),
  });
  const m = await cat2.resolver('lr-1-o');
  assert.equal(m.videoId, vid(2));
  assert.equal(m.titulo, 'Bohemian Rhapsody');
  assert.equal(cat2.metaPublica('lr-1-o').letraConfiable, true);
  await x.limpiar();
});

test('buscar: la misma consulta se cachea (no se vuelve a pedir a LRCLIB)', async () => {
  const x = await armar();
  await x.cat.buscar('queen');
  const n = x.llamadas.lrclib.length;
  await x.cat.buscar('queen');
  assert.equal(x.llamadas.lrclib.length, n);
  await x.limpiar();
});

// -------------------------------------------------------------------------- resolver
test('resolver ORIGINAL: elige el audio de duracion igual a la letra, guarda la letra y queda confiable (sin tocar nada)', async () => {
  const x = await armar({ candidatos: () => [video(1, 330, 'Queen - Bohemian Rhapsody (Live)'), video(2, 355), video(3, 372, 'Queen - Bohemian Rhapsody (Official Video)')] });
  const m = await x.cat.resolver('lr-1-o', { busqueda: 'queen' });
  assert.equal(m.videoId, vid(2), 'el de 355 s (igual a la letra de 355 s)');
  assert.equal(m.titulo, 'Bohemian Rhapsody');
  assert.equal(m.artista, 'Queen');
  assert.equal(m.tipo, 'original');
  assert.equal(m.searchQuery, 'queen');
  assert.equal(m.letraNivel, 'exacta');
  assert.equal(await readFile(join(x.dir, 'cache', 'lr-1-o.lrc'), 'utf8'), LRC, 'la letra de LRCLIB queda guardada');
  const pub = x.cat.metaPublica('lr-1-o');
  assert.equal(pub.letraConfiable, true, 'audio original de duracion igual: la letra cae sola, no hay que alinear');
  assert.equal(pub.lrc, '/cache-audio/lr-1-o.lrc');
  assert.equal(pub.videoId, vid(2));
  assert.ok(m.thumbnail && m.canal);
  await x.limpiar();
});

test('resolver ORIGINAL: busca primero "official audio" y, si no hay uno exacto, prueba la consulta sin adornos', async () => {
  const x = await armar({ candidatos: (q) => (/official audio/.test(q) ? [video(1, 380)] : [video(2, 355)]) });
  const m = await x.cat.resolver('lr-1-o');
  assert.equal(m.videoId, vid(2));
  assert.equal(x.llamadas.candidatos.length, 2);
  assert.match(x.llamadas.candidatos[0], /Queen Bohemian Rhapsody official audio/);
  await x.limpiar();
});

test('resolver ORIGINAL: sin ningun audio que dure como la letra no se inventa: error claro que sugiere el karaoke', async () => {
  const x = await armar({ candidatos: () => [video(1, 420), video(2, 300)] });
  await assert.rejects(() => x.cat.resolver('lr-1-o'), (e) => e.codigo === 'sin_version' && /karaoke/.test(e.message));
  assert.equal(x.canciones.find((c) => c.id === 'lr-1-o'), undefined, 'no queda registrada');
  await x.limpiar();
});

test('resolver KARAOKE: usa el filtro karaoke y NUNCA se marca confiable (un karaoke puede durar igual y tener intro)', async () => {
  const k = { ...video(5, 355, 'Queen - Bohemian Rhapsody (Karaoke Version)', 'Sing King'), karaoke: { score: 120, esKaraoke: true, excluir: false, motivos: [] } };
  const x = await armar({ buscarKaraoke: () => [k, { ...video(6, 340, 'Bohemian Rhapsody karaoke'), karaoke: { score: 90, esKaraoke: true, excluir: false, motivos: [] } }] });
  const m = await x.cat.resolver('lr-1-k');
  assert.equal(m.videoId, vid(5), 'el de duracion igual gana a igualdad de karaoke');
  assert.equal(m.tipo, 'karaoke');
  assert.equal(m.karaokeScore, 120);
  const pub = x.cat.metaPublica('lr-1-k');
  assert.equal(pub.letraConfiable, false, 'aunque dure igual: se avisa que puede salir corrida');
  assert.match(x.llamadas.karaoke[0], /karaoke$/);
  assert.equal(x.llamadas.candidatos.length, 0);
  await x.limpiar();
});

test('resolver: es idempotente y dos pedidos a la vez comparten la misma busqueda en YouTube', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)] });
  const [a, b] = await Promise.all([x.cat.resolver('lr-1-o'), x.cat.resolver('lr-1-o')]);
  assert.equal(a.videoId, b.videoId);
  await x.cat.resolver('lr-1-o');
  assert.equal(x.llamadas.candidatos.length, 1, 'una sola busqueda (cuesta cuota)');
  assert.equal(x.canciones.filter((c) => c.id === 'lr-1-o').length, 1);
  await x.limpiar();
});

test('resolver: ids invalidos o inventados se rechazan; sin clave de YouTube no registra nada', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)] });
  await assert.rejects(() => x.cat.resolver('../etc/passwd'));
  await assert.rejects(() => x.cat.resolver('yt-' + 'a'.repeat(11)), /desconocida/);
  await assert.rejects(() => x.cat.resolver('lr-1-x'), /desconocida/);
  const sin = await armar({ configurada: false });
  await assert.rejects(() => sin.cat.resolver('lr-1-o'), /no está configurada/);
  assert.equal(sin.canciones.length, 2);
  assert.equal((await x.cat.resolver('corre')).id, 'corre', 'las locales se resuelven siempre');
  await x.limpiar(); await sin.limpiar();
});

test('resolver: una pista de LRCLIB sin letra sincronizada no se acepta', async () => {
  const x = await armar({ pistas: [pista(9, 355, { syncedLyrics: null })], candidatos: () => [video(2, 355)] });
  await assert.rejects(() => x.cat.resolver('lr-9-o'), (e) => e.codigo === 'sin_letra');
  await x.limpiar();
});

test('elecciones: el video elegido se recuerda (un reinicio no vuelve a gastar cuota de YouTube)', async () => {
  const elecciones = almacenEnMemoria();
  const x = await armar({ elecciones, candidatos: () => [video(2, 355)] });
  await x.cat.resolver('lr-1-o');
  assert.equal(x.llamadas.candidatos.length, 1);
  const y = await armar({ elecciones, candidatos: () => { throw new Error('no deberia buscar'); } });
  const m = await y.cat.resolver('lr-1-o');
  assert.equal(m.videoId, vid(2));
  assert.equal(y.llamadas.candidatos.length, 0);
  assert.equal(y.cat.metaPublica('lr-1-o').letraConfiable, true, 'y sigue siendo confiable');
  await x.limpiar(); await y.limpiar();
});

test('reintentar: el video que fallo se descarta y se elige el siguiente mejor', async () => {
  const elecciones = almacenEnMemoria();
  const x = await armar({ elecciones, candidatos: () => [video(2, 355), video(3, 356, 'Queen - Bohemian Rhapsody (Audio Oficial)')] });
  const primero = await x.cat.resolver('lr-1-o');
  await x.cat.asegurarAudio('lr-1-o');
  await x.cat.reintentar('lr-1-o');
  const despues = x.cat.metaPublica('lr-1-o');
  assert.notEqual(despues.videoId, primero.videoId, 'no vuelve a elegir el que fallo');
  assert.equal(x.cat.estadoAudio('lr-1-o').estado, 'lista');
  await x.limpiar();
});

test('reintentar: si ya no queda ningun otro video el error es claro', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)] });
  await x.cat.resolver('lr-1-o');
  await x.cat.reintentar('lr-1-o');
  assert.equal(x.cat.estadoAudio('lr-1-o').estado, 'error');
  assert.match(x.cat.estadoAudio('lr-1-o').motivo, /karaoke|audio original/);
  await x.limpiar();
});

test('audio de YouTube: queda "lista" al elegirlo (que cargue en el reproductor lo confirma la pantalla)', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)] });
  await x.cat.resolver('lr-1-o');
  await x.cat.asegurarAudio('lr-1-o');
  assert.equal(x.cat.estadoAudio('lr-1-o').estado, 'lista');
  assert.deepEqual(x.eventos.map((e) => e[1]), ['preparando', 'lista']);
  await x.limpiar();
});

test('desfase de la letra: se fija por cancion, se recuerda y la proxima vez la cancion ya viene ajustada', async () => {
  const guardados = new Map();
  const offsets = { get: (id) => (guardados.has(id) ? guardados.get(id) : null), set: (id, v) => { guardados.set(id, Math.round(Number(v) * 10) / 10); return guardados.get(id); } };
  const k = { ...video(5, 355, 'Queen - Bohemian Rhapsody (Karaoke Version)', 'Sing King'), karaoke: { score: 120, esKaraoke: true, excluir: false, motivos: [] } };
  const x = await armar({ offsets, buscarKaraoke: () => [k] });
  const m = await x.cat.resolver('lr-1-k');
  assert.equal(x.cat.metaPublica(m.id).offsetLetra, 0, 'la primera vez no hay ajuste');
  assert.equal(x.cat.metaPublica(m.id).letraConfiable, false);
  assert.equal(x.cat.fijarOffset(m.id, 12.04), 12);
  assert.equal(x.cat.metaPublica(m.id).offsetLetra, 12, 'la pantalla que baje la meta lo recibe');
  assert.equal(x.cat.metaPublica(m.id).letraConfiable, true, 'ya alineada a mano: se puede confiar');
  assert.equal(x.cat.fijarOffset('lr-9-k', 3), null, 'de una cancion desconocida no se guarda nada');
  const y = await armar({ offsets, buscarKaraoke: () => [k] });
  const m2 = await y.cat.resolver('lr-1-k');
  assert.equal(y.cat.metaPublica(m2.id).offsetLetra, 12, 'tras un reinicio la cancion ya viene ajustada');
  await x.limpiar(); await y.limpiar();
});

test('meta publica: trae lo que la pantalla necesita (videoId, thumbnail, consulta, tipo, letra, estado del audio)', async () => {
  const x = await armar({ candidatos: () => [video(2, 355)] });
  const m = await x.cat.resolver('lr-1-o', { busqueda: 'queen' });
  const pub = x.cat.metaPublica(m.id);
  assert.equal(pub.origen, 'youtube');
  assert.equal(pub.videoId, vid(2));
  assert.ok(pub.thumbnail && pub.canal);
  assert.equal(pub.searchQuery, 'queen');
  assert.equal(pub.tipo, 'original');
  assert.equal(pub.audioEstado, 'sin_preparar');
  assert.equal(pub.audio, undefined, 'ninguna url de audio: se reproduce embebido');
  assert.equal(x.cat.metaPublica('no-existe'), null);
  await x.limpiar();
});

// ------------------------------------------------------------ audio de la biblioteca local
test('audio local: sin archivo en este equipo y sin copia remota -> error claro; con archivo valido -> lista', async () => {
  const x = await armar();
  await x.cat.asegurarAudio('corre');
  assert.equal(x.cat.estadoAudio('corre').estado, 'error');
  assert.match(x.cat.estadoAudio('corre').motivo, /falta el archivo/);
  const carpeta = join(x.dir, 'canciones', 'baby');
  await mkdir(carpeta, { recursive: true });
  await writeFile(join(carpeta, 'baby.m4a'), 'x');
  const y = crearCatalogo({
    canciones: [{ id: 'baby', titulo: 'Baby', artista: 'JB', duracion: 237, audio: '/canciones/baby/baby.m4a' }],
    dirLocal: x.dir, dirCache: join(x.dir, 'cache'),
    ejecutar: async () => ({ stdout: '', stderr: 'Duration: 00:03:57.00\n Stream #0:0: Audio: aac\n mean_volume: -20.0 dB\n max_volume: -1.0 dB' }),
  });
  await y.asegurarAudio('baby');
  assert.equal(y.estadoAudio('baby').estado, 'lista');
  await x.limpiar();
});

test('audio local: un archivo que es silencio no queda "lista"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-cat-'));
  await mkdir(join(dir, 'canciones', 'a'), { recursive: true });
  await writeFile(join(dir, 'canciones', 'a', 'a.m4a'), 'x');
  const cat = crearCatalogo({
    canciones: [{ id: 'a', titulo: 'A', artista: 'B', duracion: 100, audio: '/canciones/a/a.m4a' }], dirLocal: dir, dirCache: dir,
    ejecutar: async () => ({ stdout: '', stderr: 'Duration: 00:01:40.00\n Audio: aac\n mean_volume: -inf dB\n max_volume: -inf dB' }),
  });
  await cat.asegurarAudio('a');
  assert.equal(cat.estadoAudio('a').estado, 'error');
  assert.match(cat.estadoAudio('a').motivo, /silencio/);
  await rm(dir, { recursive: true, force: true });
});
