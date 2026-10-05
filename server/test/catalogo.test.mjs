// Catalogo, busqueda y preparacion del audio (sin red: fetch y yt-dlp/ffmpeg simulados).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearCatalogo, elegirCandidato, parsearInfoFfmpeg, veredictoArchivo, normalizar, limpiarTitulo, motivoDe } from '../catalogo.js';

// ------------------------------------------------------------ funciones puras
test('normalizar: sin acentos, sin parentesis ni signos', () => {
  assert.equal(normalizar('  De Música Ligera (Remasterizado 2007) '), 'de musica ligera');
});

test('elegir version: la que dura lo mismo que la letra, no la mas famosa', () => {
  const c = [
    { id: 'a', title: 'Artista - Tema (Official Audio)', duration: 213, channel: 'Artista' },
    { id: 'b', title: 'Artista - Tema (en vivo)', duration: 289, channel: 'Artista' },
    { id: 'c', title: 'Tema (cover)', duration: 211, channel: 'otro' },
    { id: 'd', title: 'Tema - karaoke', duration: 212, channel: 'k' },
  ];
  const e = elegirCandidato(c, { titulo: 'Tema', artista: 'Artista', duracion: 211 });
  assert.equal(e.id, 'a');
  assert.equal(e.desfaseProbable, false);
});

test('elegir version: si nada coincide justo, acepta una cercana pero avisa que la letra puede salir corrida', () => {
  const e = elegirCandidato([{ id: 'x', title: 'Tema', duration: 220, channel: 'A' }], { titulo: 'Tema', artista: 'A', duracion: 211 });
  assert.equal(e.id, 'x');
  assert.equal(e.desfaseProbable, true);
});

test('elegir version: si ninguna se parece, no inventa (devuelve null)', () => {
  assert.equal(elegirCandidato([{ id: 'x', title: 'Tema', duration: 400, channel: 'A' }], { titulo: 'Tema', artista: 'A', duracion: 211 }), null);
  assert.equal(elegirCandidato([], { titulo: 'T', artista: 'A', duracion: 100 }), null);
});

test('validar archivo: silencio, muy corto, sin audio o de otra duracion se rechazan', () => {
  const ok = parsearInfoFfmpeg('Duration: 00:03:31.05, start: 0\n Stream #0:0: Audio: aac\n mean_volume: -22.1 dB\n max_volume: -1.0 dB');
  assert.equal(ok.duracion, 211.05);
  assert.equal(veredictoArchivo(ok, 211), null);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:03:31.05\n Audio: aac\n mean_volume: -inf dB\n max_volume: -inf dB'), 211), /silencio/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:03:31.05\n Audio: aac\n mean_volume: -75 dB\n max_volume: -60 dB'), 211), /silencio/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:00:05.00\n Audio: aac\n mean_volume: -20 dB\n max_volume: -1 dB'), 211), /duracion/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:03:31.05\n Video: h264\n'), 211), /pista de audio/);
  assert.match(veredictoArchivo(parsearInfoFfmpeg('Duration: 00:10:00.00\n Audio: aac\n mean_volume: -20 dB\n max_volume: -1 dB'), 211), /deberia durar/);
});

test('limpiar titulo: saca el "Artista - " repetido que trae lrclib', () => {
  assert.equal(limpiarTitulo('Soda Stereo - De Música Ligera', 'Soda Stereo'), 'De Música Ligera');
  assert.equal(limpiarTitulo('De Música Ligera', 'Soda Stereo'), 'De Música Ligera');
});

test('motivo del error: la causa real, no el comando que fallo', () => {
  const stderr = ['WARNING: algo', 'ERROR: [youtube] abc: Sign in to confirm you are not a bot', ''].join('\n');
  const e = Object.assign(new Error('Command failed: yt-dlp -f bestaudio --no-playlist https://...'), { stderr });
  assert.match(motivoDe(e), /Sign in to confirm/);
  assert.doesNotMatch(motivoDe(e), /Command failed/);
  assert.equal(motivoDe(new Error('boom\nsegunda linea')), 'boom');
});

// ---------------------------------------------------------------- escenario
const LRC = '[00:10.00] linea uno\n[00:14.00] linea dos\n';

function crudo(id, artista, titulo, dur, extra = {}) {
  return { id, trackName: titulo, artistName: artista, duration: dur, syncedLyrics: LRC, instrumental: false, ...extra };
}

async function armar({ ytdlp = true, candidatos, descarga = true, ffmpegStderr, resultadosLrclib, lrclibFalla = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-cat-'));
  const llamadas = { fetch: [], cmd: [] };
  const eventos = [];
  const canciones = [{ id: 'local1', titulo: 'Corre', artista: 'Jesse & Joy', duracion: 306, audio: '/canciones/local1/local1.m4a', lrc: '/canciones/local1/local1.lrc' }];
  const fetchFn = async (url, { signal } = {}) => {
    llamadas.fetch.push(String(url));
    if (lrclibFalla) throw new Error('sin red');
    if (String(url).includes('/search')) return { ok: true, json: async () => resultadosLrclib ?? [] };
    const m = /\/get\/(\d+)/.exec(String(url));
    if (m) return { ok: true, json: async () => crudo(Number(m[1]), 'Soda Stereo', 'De Musica Ligera', 211) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const ejecutar = async (cmd, args) => {
    const a = args.join(' ');
    llamadas.cmd.push(`${cmd} ${a}`);
    if (a.includes('--version')) {
      if (!ytdlp) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { stdout: '2026.08.19\n', stderr: '' };
    }
    if (a.includes('--dump-json')) return { stdout: (candidatos || []).map((c) => JSON.stringify(c)).join('\n'), stderr: '' };
    if (a.includes('youtube.com/watch')) {
      if (!descarga) throw new Error('HTTP 403');
      const salida = args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a');
      await writeFile(salida, 'datos-de-audio');
      return { stdout: '', stderr: '' };
    }
    if (a.includes('volumedetect')) return { stdout: '', stderr: ffmpegStderr ?? 'Duration: 00:03:31.05\n Stream #0:0: Audio: aac\n mean_volume: -20.0 dB\n max_volume: -1.0 dB' };
    throw new Error(`comando inesperado: ${cmd} ${a}`);
  };
  const cat = crearCatalogo({
    canciones,
    dirLocal: dir,
    dirCache: join(dir, 'cache'),
    ffmpeg: 'ffmpeg',
    fetchFn,
    ejecutar,
    onEstadoAudio: (id, estado, motivo) => eventos.push([id, estado, motivo]),
    config: { MAX_ARCHIVOS: 3 },
  });
  await (await import('node:fs/promises')).mkdir(join(dir, 'cache'), { recursive: true });
  await cat.detectar();
  return { cat, canciones, llamadas, eventos, dir, limpiar: () => rm(dir, { recursive: true, force: true }) };
}

const SODA = [
  crudo(1, 'Soda Stereo', 'De Musica Ligera', 211),
  crudo(2, 'Soda Stereo', 'De Música Ligera', 213),
  crudo(3, 'Soda Stereo', 'De musica ligera', 289),
  crudo(4, 'Otro', 'Sin sincronizar', 200, { syncedLyrics: '' }),
  crudo(5, 'Otro', 'Instrumental', 200, { instrumental: true }),
  crudo(6, 'Otro', 'Muy corta', 30),
  crudo(7, 'Gustavo Cerati', 'Crimen', 240),
];

// --------------------------------------------------------------- busqueda
test('buscar: devuelve solo lo reproducible, sin duplicados y con la biblioteca local primero', async () => {
  const x = await armar({ resultadosLrclib: SODA });
  const r = await x.cat.buscar('cor');
  assert.equal(r.items[0].fuente, 'local');
  const r2 = await x.cat.buscar('soda stereo');
  const titulos = r2.items.map((i) => `${i.artista} - ${i.titulo}`);
  assert.equal(titulos.filter((t) => /Soda Stereo/.test(t)).length, 1, 'las 3 versiones del mismo tema quedan en 1');
  assert.ok(!titulos.some((t) => /Sin sincronizar|Instrumental|Muy corta/.test(t)), 'sin letra sincronizada / instrumental / demasiado corta no sirven');
  assert.ok(r2.items.every((i) => i.id.startsWith('lrclib-') || i.fuente === 'local'));
  assert.equal(r2.remoto, true);
  await x.limpiar();
});

test('buscar: sin yt-dlp solo ofrece canciones que realmente se pueden reproducir (no metadata sin audio)', async () => {
  const x = await armar({ ytdlp: false, resultadosLrclib: SODA });
  const r = await x.cat.buscar('soda');
  assert.equal(r.remoto, false);
  assert.ok(r.items.every((i) => i.fuente === 'local'), 'nada online si no hay como bajarlo');
  assert.equal(x.llamadas.fetch.length, 0, 'ni siquiera consulta lrclib');
  assert.match(x.cat.motivoCapacidad, /no esta instalado/);
  await x.limpiar();
});

test('buscar: consulta vacia = biblioteca local completa; resultados se cachean', async () => {
  const x = await armar({ resultadosLrclib: SODA });
  const vacia = await x.cat.buscar('');
  assert.equal(vacia.items.length, 1);
  await x.cat.buscar('soda stereo');
  await x.cat.buscar('Soda  Stereo');
  assert.equal(x.llamadas.fetch.filter((u) => u.includes('/search')).length, 1, 'la misma busqueda no vuelve a pegarle a lrclib');
  await x.limpiar();
});

test('buscar: si lrclib falla igual devuelve lo local y avisa el error (para el boton Reintentar)', async () => {
  const x = await armar({ lrclibFalla: true });
  const r = await x.cat.buscar('corre');
  assert.ok(r.items.length >= 1);
  assert.match(r.error, /catálogo online|tardó/);
  await x.limpiar();
});

test('buscar: paginacion', async () => {
  const muchos = Array.from({ length: 25 }, (_, i) => crudo(100 + i, `Artista ${i}`, `Tema ${i}`, 200 + i));
  const x = await armar({ resultadosLrclib: muchos });
  const p0 = await x.cat.buscar('tema', 0);
  const p1 = await x.cat.buscar('tema', 1);
  const p2 = await x.cat.buscar('tema', 2);
  assert.equal(p0.items.length, 10);
  assert.equal(p0.hayMas, true);
  assert.equal(p2.hayMas, false);
  assert.equal(new Set([...p0.items, ...p1.items, ...p2.items].map((i) => i.id)).size, p0.items.length + p1.items.length + p2.items.length, 'sin repetidos entre paginas');
  await x.limpiar();
});

// ---------------------------------------------------------------- resolver
test('resolver: registra la cancion online en el catalogo compartido y guarda la letra', async () => {
  const x = await armar();
  const meta = await x.cat.resolver('lrclib-77');
  assert.equal(meta.titulo, 'De Musica Ligera');
  assert.ok(x.canciones.find((c) => c.id === 'lrclib-77'), 'queda en el array que usa el escenario');
  assert.equal(await readFile(join(x.dir, 'cache', 'lrclib-77.lrc'), 'utf8'), LRC);
  assert.equal((await x.cat.resolver('lrclib-77')).id, 'lrclib-77', 'idempotente');
  assert.equal(x.canciones.filter((c) => c.id === 'lrclib-77').length, 1);
  await x.limpiar();
});

test('resolver: ids invalidos o inventados se rechazan', async () => {
  const x = await armar();
  await assert.rejects(() => x.cat.resolver('../../etc/passwd'), /invalido/);
  await assert.rejects(() => x.cat.resolver('cualquier-cosa'), /desconocida/);
  await assert.rejects(() => x.cat.resolver('lrclib-abc'), /desconocida/);
  await x.limpiar();
});

// -------------------------------------------------------------------- audio
test('audio remoto: busca la version correcta, baja, VALIDA y recien ahi queda lista', async () => {
  const x = await armar({
    candidatos: [
      { id: 'vivo', title: 'Soda Stereo - De Musica Ligera (en vivo)', duration: 289, channel: 'Soda Stereo' },
      { id: 'estudio', title: 'Soda Stereo - De Musica Ligera (Official Audio)', duration: 212, channel: 'Soda Stereo' },
    ],
  });
  await x.cat.resolver('lrclib-77');
  const p = x.cat.asegurarAudio('lrclib-77');
  assert.equal(x.cat.estadoAudio('lrclib-77').estado, 'preparando', 'mientras baja NO figura lista');
  await p;
  assert.equal(x.cat.estadoAudio('lrclib-77').estado, 'lista');
  assert.deepEqual(x.eventos.map((e) => e[1]), ['preparando', 'preparando', 'lista']);
  assert.ok(x.llamadas.cmd.some((c) => c.includes('watch?v=estudio')), 'eligio la version de estudio, no el vivo');
  assert.ok(!x.llamadas.cmd.some((c) => c.includes('watch?v=vivo')));
  assert.ok(existsSync(join(x.dir, 'cache', 'lrclib-77.m4a')));
  await x.limpiar();
});

test('audio remoto: si no hay una version que coincida, error con motivo (nunca "lista")', async () => {
  const x = await armar({ candidatos: [{ id: 'z', title: 'Otra cosa', duration: 500, channel: 'x' }] });
  await x.cat.resolver('lrclib-77');
  await x.cat.asegurarAudio('lrclib-77');
  const e = x.cat.estadoAudio('lrclib-77');
  assert.equal(e.estado, 'error');
  assert.match(e.motivo, /duracion/);
  assert.equal(x.eventos.at(-1)[1], 'error');
  await x.limpiar();
});

test('audio remoto: la descarga falla -> error; reintentar vuelve a intentar', async () => {
  const x = await armar({ descarga: false, candidatos: [{ id: 'estudio', title: 'Soda Stereo - De Musica Ligera', duration: 211, channel: 'Soda Stereo' }] });
  await x.cat.resolver('lrclib-77');
  await x.cat.asegurarAudio('lrclib-77');
  assert.equal(x.cat.estadoAudio('lrclib-77').estado, 'error');
  assert.match(x.cat.estadoAudio('lrclib-77').motivo, /403/);
  const antes = x.llamadas.cmd.length;
  await x.cat.reintentar('lrclib-77');
  assert.ok(x.llamadas.cmd.length > antes, 'reintentar vuelve a ejecutar la descarga');
  await x.limpiar();
});

test('audio remoto: un archivo que es silencio o esta roto se descarta y NO queda lista', async () => {
  const x = await armar({
    candidatos: [{ id: 'estudio', title: 'Soda Stereo - De Musica Ligera', duration: 211, channel: 'Soda Stereo' }],
    ffmpegStderr: 'Duration: 00:03:31.05\n Audio: aac\n mean_volume: -inf dB\n max_volume: -inf dB',
  });
  await x.cat.resolver('lrclib-77');
  await x.cat.asegurarAudio('lrclib-77');
  assert.equal(x.cat.estadoAudio('lrclib-77').estado, 'error');
  assert.match(x.cat.estadoAudio('lrclib-77').motivo, /silencio/);
  assert.equal(existsSync(join(x.dir, 'cache', 'lrclib-77.m4a')), false, 'el archivo malo se borra');
  await x.limpiar();
});

test('audio: es idempotente (muchos pedidos = una sola preparacion)', async () => {
  const x = await armar({ candidatos: [{ id: 'estudio', title: 'Soda Stereo - De Musica Ligera', duration: 211, channel: 'Soda Stereo' }] });
  await x.cat.resolver('lrclib-77');
  await Promise.all([x.cat.asegurarAudio('lrclib-77'), x.cat.asegurarAudio('lrclib-77'), x.cat.asegurarAudio('lrclib-77')]);
  assert.equal(x.llamadas.cmd.filter((c) => c.includes('watch?v=')).length, 1);
  await x.cat.asegurarAudio('lrclib-77'); // ya lista: no hace nada
  assert.equal(x.llamadas.cmd.filter((c) => c.includes('watch?v=')).length, 1);
  await x.limpiar();
});

test('audio local: sin archivo en este equipo y sin copia remota -> error claro', async () => {
  const x = await armar();
  await x.cat.asegurarAudio('local1');
  assert.equal(x.cat.estadoAudio('local1').estado, 'error');
  assert.match(x.cat.estadoAudio('local1').motivo, /falta el archivo/);
  await x.limpiar();
});

test('audio local: con archivo valido queda lista', async () => {
  const x = await armar();
  const carpeta = join(x.dir, 'canciones', 'local1');
  await (await import('node:fs/promises')).mkdir(carpeta, { recursive: true });
  await writeFile(join(carpeta, 'local1.m4a'), 'x');
  await x.cat.asegurarAudio('local1');
  assert.equal(x.cat.estadoAudio('local1').estado, 'lista');
  await x.limpiar();
});

test('meta publica: trae lo que la pantalla necesita para reproducir y el estado real del audio', async () => {
  const x = await armar({ candidatos: [{ id: 'estudio', title: 'Soda Stereo - De Musica Ligera', duration: 211, channel: 'Soda Stereo' }] });
  await x.cat.resolver('lrclib-77');
  assert.equal(x.cat.metaPublica('lrclib-77').audioEstado, 'sin_preparar');
  await x.cat.asegurarAudio('lrclib-77');
  const m = x.cat.metaPublica('lrclib-77');
  assert.equal(m.audioEstado, 'lista');
  assert.equal(m.audio, '/cache-audio/lrclib-77.m4a');
  assert.equal(m.lrc, '/cache-audio/lrclib-77.lrc');
  assert.equal(x.cat.metaPublica('nada'), null);
  await x.limpiar();
});
