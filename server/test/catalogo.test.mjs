// Catalogo: busqueda (biblioteca + YouTube), registro de la cancion elegida, letra y audio local.
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
async function armar({ configurada = true, busqueda, detalle, lrclib } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-cat-'));
  await mkdir(join(dir, 'cache'), { recursive: true });
  const eventos = [];
  const llamadas = { buscar: [], detalle: [], lrclib: [] };
  const canciones = [
    { id: 'corre', titulo: 'Corre', artista: 'Jesse & Joy', duracion: 306, audio: '/canciones/corre/corre.m4a' },
    { id: 'baby', titulo: 'Baby', artista: 'Justin Bieber', duracion: 237, audio: '/canciones/baby/baby.m4a' },
  ];
  const youtube = {
    configurada,
    cuota: () => ({ usadas: 1, limite: 9500 }),
    buscar: async (q, token) => {
      llamadas.buscar.push([q, token]);
      if (busqueda instanceof Error) throw busqueda;
      return busqueda ? busqueda(q, token) : { items: [], nextPageToken: null };
    },
    detalle: async (id) => {
      llamadas.detalle.push(id);
      if (detalle instanceof Error) throw detalle;
      return detalle ? detalle(id) : { videoId: id, titulo: 'Queen - Bohemian Rhapsody (Karaoke Version)', canal: 'Sing King', thumbnail: 'https://i.ytimg.com/vi/x/mq.jpg', duracion: 355 };
    },
  };
  const fetchFn = async (url) => {
    llamadas.lrclib.push(String(url));
    return { ok: true, json: async () => lrclib ?? [] };
  };
  const cat = crearCatalogo({ canciones, dirLocal: dir, dirCache: join(dir, 'cache'), youtube, fetchFn, ejecutar: async () => ({ stdout: '', stderr: '' }), onEstadoAudio: (id, e, m) => eventos.push([id, e, m]) });
  return { cat, canciones, llamadas, eventos, dir, limpiar: () => rm(dir, { recursive: true, force: true }) };
}

const itemYT = (n, titulo = `Tema ${n} (Karaoke)`) => ({ id: `yt-${vid(n)}`, videoId: vid(n), titulo, canal: 'Sing King', thumbnail: 't', duracion: 200, karaoke: { score: 80, esKaraoke: true, motivos: [] }, fuente: 'youtube', lista: false });

// --------------------------------------------------------------------------- busqueda
test('buscar: la biblioteca local primero y despues YouTube (con thumbnail, canal, duracion y puntaje karaoke)', async () => {
  const x = await armar({ busqueda: () => ({ items: [itemYT(1), itemYT(2)], nextPageToken: 'T1', cuota: { usadas: 101 } }) });
  const r = await x.cat.buscar('corre');
  assert.equal(r.items[0].id, 'corre');
  assert.equal(r.items[0].fuente, 'local');
  assert.deepEqual(r.items.slice(1).map((i) => i.id), [`yt-${vid(1)}`, `yt-${vid(2)}`]);
  assert.equal(r.items[1].karaoke.esKaraoke, true);
  assert.equal(r.nextPageToken, 'T1', 'el nextPageToken de YouTube viaja tal cual');
  assert.equal(r.remoto, true);
  assert.deepEqual(x.llamadas.buscar[0], ['corre', null]);
  await x.limpiar();
});

test('buscar: consulta vacia = biblioteca local, sin tocar YouTube (no gasta cuota)', async () => {
  const x = await armar();
  const r = await x.cat.buscar('');
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((i) => i.fuente === 'local' && i.lista));
  assert.equal(x.llamadas.buscar.length, 0);
  await x.limpiar();
});

test('buscar: las paginas siguientes son solo de YouTube y usan el pageToken', async () => {
  const x = await armar({ busqueda: (q, t) => ({ items: [itemYT(t === 'T1' ? 11 : 1)], nextPageToken: t === 'T1' ? null : 'T1' }) });
  const p1 = await x.cat.buscar('corre');
  const p2 = await x.cat.buscar('corre', p1.nextPageToken);
  assert.ok(p1.items.some((i) => i.fuente === 'local'));
  assert.ok(p2.items.every((i) => i.fuente === 'youtube'), 'la biblioteca no se repite en la pagina 2');
  assert.deepEqual(x.llamadas.buscar[1], ['corre', 'T1']);
  assert.equal(p2.nextPageToken, null);
  await x.limpiar();
});

test('buscar: errores de YouTube se informan claro y la biblioteca local sigue disponible', async () => {
  const casos = [
    [new YouTubeError('cuota_agotada', 'Se agotó la cuota diaria'), 'cuota_agotada', /cuota/],
    [new YouTubeError('sin_clave', 'falta YOUTUBE_API_KEY'), 'sin_clave', /YOUTUBE_API_KEY/],
    [Object.assign(new Error('x'), { codigo: 'red' }), 'red', /conectar/],
    [new Error('algo raro'), 'desconocido', /No se pudo buscar/],
  ];
  for (const [err, codigo, patron] of casos) {
    const x = await armar({ busqueda: err });
    const r = await x.cat.buscar('corre');
    assert.equal(r.error.codigo, codigo);
    assert.match(r.error.mensaje, patron);
    assert.ok(r.items.some((i) => i.id === 'corre'), 'lo local igual aparece');
    await x.limpiar();
  }
});

test('buscar: sin clave de YouTube solo se ofrece la biblioteca local (nunca resultados que no se pueden reproducir)', async () => {
  const x = await armar({ configurada: false, busqueda: new YouTubeError('sin_clave', 'falta YOUTUBE_API_KEY') });
  const r = await x.cat.buscar('corre');
  assert.equal(r.remoto, false);
  assert.ok(r.items.every((i) => i.fuente === 'local'));
  assert.match(x.cat.motivoCapacidad, /YOUTUBE_API_KEY/);
  await x.limpiar();
});

// ---------------------------------------------------------------- resolver / eleccion
test('resolver: registra la cancion de YouTube con videoId, titulo, canal, thumbnail, duracion, consulta y puntaje', async () => {
  const x = await armar();
  const m = await x.cat.resolver(`yt-${vid(7)}`, { busqueda: 'Bohemian Rhapsody' });
  assert.equal(m.origen, 'youtube');
  assert.equal(m.videoId, vid(7));
  assert.equal(m.titulo, 'Queen - Bohemian Rhapsody (Karaoke Version)');
  assert.equal(m.canal, 'Sing King');
  assert.equal(m.thumbnail, 'https://i.ytimg.com/vi/x/mq.jpg');
  assert.equal(m.duracion, 355);
  assert.equal(m.searchQuery, 'Bohemian Rhapsody');
  assert.ok(m.karaokeScore > 40 && m.esKaraoke, `puntaje karaoke ${m.karaokeScore}`);
  assert.ok(x.canciones.find((c) => c.id === `yt-${vid(7)}`), 'queda en el catalogo compartido con el escenario');
  await x.limpiar();
});

test('resolver: es idempotente y no verifica dos veces en paralelo', async () => {
  const x = await armar();
  await Promise.all([x.cat.resolver(`yt-${vid(7)}`), x.cat.resolver(`yt-${vid(7)}`)]);
  await x.cat.resolver(`yt-${vid(7)}`);
  assert.equal(x.llamadas.detalle.length, 1);
  assert.equal(x.canciones.filter((c) => c.id === `yt-${vid(7)}`).length, 1);
  await x.limpiar();
});

test('resolver: un video que no se puede reproducir NO se acepta como cancion', async () => {
  const x = await armar({ detalle: new YouTubeError('no_reproducible', 'Ese video no se puede reproducir: el dueño no permite reproducirlo fuera de YouTube.') });
  await assert.rejects(() => x.cat.resolver(`yt-${vid(8)}`), (e) => e.codigo === 'no_reproducible');
  assert.equal(x.canciones.some((c) => c.id === `yt-${vid(8)}`), false);
  await x.limpiar();
});

test('resolver: ids invalidos o inventados se rechazan; sin clave no registra canciones de YouTube', async () => {
  const x = await armar();
  await assert.rejects(() => x.cat.resolver('../../etc/passwd'), /invalido/);
  await assert.rejects(() => x.cat.resolver('cualquier-cosa'), /desconocida/);
  await assert.rejects(() => x.cat.resolver('yt-corto'), /desconocida/);
  assert.equal((await x.cat.resolver('corre')).id, 'corre', 'las locales se resuelven siempre');
  const y = await armar({ configurada: false });
  await assert.rejects(() => y.cat.resolver(`yt-${vid(1)}`), /no está configurada/);
  await x.limpiar();
  await y.limpiar();
});

// ------------------------------------------------------------------------------ audio
test('audio de YouTube: queda "lista" tras la verificacion con la API (que cargue en el reproductor lo confirma la pantalla)', async () => {
  const x = await armar();
  await x.cat.resolver(`yt-${vid(7)}`);
  await x.cat.asegurarAudio(`yt-${vid(7)}`);
  assert.equal(x.cat.estadoAudio(`yt-${vid(7)}`).estado, 'lista');
  assert.deepEqual(x.eventos.map((e) => e[1]), ['preparando', 'lista']);
  await x.limpiar();
});

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

// ------------------------------------------------------------------------------ letra
test('letra: se acepta la de lrclib solo si dura parecido al video; se guarda como .lrc', async () => {
  const x = await armar({
    lrclib: [
      { id: 1, trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: 600, syncedLyrics: 'otra version', instrumental: false },
      { id: 2, trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: 354, syncedLyrics: LRC, instrumental: false },
    ],
  });
  const m = await x.cat.resolver(`yt-${vid(7)}`);
  await x.cat.buscarLetra(x.canciones.find((c) => c.id === m.id));
  const c = x.canciones.find((c) => c.id === m.id);
  assert.equal(c.lrc, `/cache-audio/yt-${vid(7)}.lrc`);
  assert.equal(c.letraEstado, 'ok');
  assert.equal(await readFile(join(x.dir, 'cache', `yt-${vid(7)}.lrc`), 'utf8'), LRC);
  assert.equal(x.cat.metaPublica(m.id).letraEstado, 'ok');
  await x.limpiar();
});

test('letra: si no hay una compatible no se inventa (el video karaoke ya trae la suya)', async () => {
  const x = await armar({ lrclib: [{ id: 1, trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: 500, syncedLyrics: LRC, instrumental: false }] });
  const m = await x.cat.resolver(`yt-${vid(7)}`);
  const c = x.canciones.find((c) => c.id === m.id);
  await x.cat.buscarLetra(c);
  assert.equal(c.lrc, null);
  assert.equal(c.letraEstado, 'sin_letra');
  await x.limpiar();
});

test('letra: el audio de YouTube figura "lista" recien cuando la letra de lrclib ya esta (la pantalla la necesita al precargar)', async () => {
  const x = await armar({ lrclib: [{ id: 2, trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: 354, syncedLyrics: LRC, instrumental: false }] });
  const m = await x.cat.resolver(`yt-${vid(8)}`);
  await x.cat.asegurarAudio(m.id);
  assert.equal(x.cat.estadoAudio(m.id).estado, 'lista');
  assert.equal(x.cat.metaPublica(m.id).lrc, `/cache-audio/${m.id}.lrc`, 'la meta que baja la pantalla ya trae la letra');
  assert.equal(x.llamadas.lrclib.length >= 1, true);
  await x.limpiar();
});

test('meta publica: trae lo que la pantalla necesita (videoId, thumbnail, consulta, puntaje, estado del audio)', async () => {
  const x = await armar();
  await x.cat.resolver(`yt-${vid(7)}`, { busqueda: 'queen bohemian' });
  assert.equal(x.cat.metaPublica(`yt-${vid(7)}`).audioEstado, 'sin_preparar');
  await x.cat.asegurarAudio(`yt-${vid(7)}`);
  const m = x.cat.metaPublica(`yt-${vid(7)}`);
  assert.equal(m.audioEstado, 'lista');
  assert.equal(m.videoId, vid(7));
  assert.equal(m.searchQuery, 'queen bohemian');
  assert.ok(m.karaokeScore > 0);
  assert.equal(x.cat.metaPublica('nada'), null);
  await x.limpiar();
});
