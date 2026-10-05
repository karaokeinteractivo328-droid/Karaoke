// Puntuacion "apto para karaoke": ordena bien, no es demasiado estricta, nunca deja la lista vacia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { puntuarKaraoke, planDeConsultas, seleccionarParaMostrar, deduplicarYOrdenar, relevancia, UMBRAL } from '../karaoke.js';
import { duracionISO, decodificarHtml, normalizar } from '../texto.js';

const Q = 'Bohemian Rhapsody';
const item = (videoId, titulo, canal, duracion = 355, extra = {}) => ({ videoId, titulo, canal, duracion, ...extra });
const con = (it, q = Q) => ({ ...it, karaoke: puntuarKaraoke(it, q) });

test('una version karaoke puntua muy por encima de un videoclip oficial', () => {
  const kar = puntuarKaraoke(item('a', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King'), Q);
  const oficial = puntuarKaraoke(item('b', 'Queen - Bohemian Rhapsody (Official Video Remastered)', 'Queen Official'), Q);
  assert.ok(kar.score > oficial.score + 80, `karaoke ${kar.score} vs oficial ${oficial.score}`);
  assert.equal(kar.esKaraoke, true);
  assert.equal(oficial.esKaraoke, false);
});

test('las palabras de karaoke se reconocen (karaoke, instrumental, sing along, backing track, minus one)', () => {
  for (const t of ['Tema X (Karaoke)', 'Tema X Instrumental', 'Tema X - Sing Along', 'Tema X sing-along', 'Tema X Backing Track', 'Tema X (Minus One)', 'Tema X - Vocal Removal', 'Tema X versión karaoke']) {
    const r = puntuarKaraoke(item('x', t, 'canal'), 'Tema X');
    assert.equal(r.esKaraoke, true, t);
    assert.ok(r.motivos.some((m) => m.startsWith('+')), t);
  }
});

test('lo que normalmente no se puede cantar baja: video oficial, en vivo, concierto, cover, remix', () => {
  const base = puntuarKaraoke(item('x', 'Bohemian Rhapsody', 'Queen'), Q).score;
  for (const sufijo of ['(Official Music Video)', '(Live at Wembley)', 'Concierto', '(Cover)', '(Remix)', '(Nightcore)']) {
    const r = puntuarKaraoke(item('x', `Bohemian Rhapsody ${sufijo}`, 'Queen'), Q);
    assert.ok(r.score < base - 20, `${sufijo}: ${r.score} < ${base}`);
  }
});

test('si ya dice karaoke, "live" o "cover" casi no lo penalizan (es una version cantable)', () => {
  const normal = puntuarKaraoke(item('x', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King'), Q).score;
  const conLive = puntuarKaraoke(item('x', 'Bohemian Rhapsody (Karaoke Version) live style', 'Sing King'), Q);
  assert.ok(conLive.score > normal - 25);
  assert.equal(conLive.esKaraoke, true);
});

test('reaccion, album completo, tutorial: se EXCLUYEN (no sirven)', () => {
  for (const t of ['Bohemian Rhapsody REACTION', 'Queen Greatest Hits Full Album Bohemian Rhapsody', 'Bohemian Rhapsody Piano Tutorial']) {
    assert.equal(puntuarKaraoke(item('x', t, 'c'), Q).excluir, true, t);
  }
});

test('un karaoke de OTRA cancion se excluye: tiene que ser lo que pidio', () => {
  const otro = puntuarKaraoke(item('x', 'Hotel California (Karaoke Version)', 'Sing King'), Q);
  assert.equal(otro.excluir, true);
  assert.ok(otro.relevancia < UMBRAL.RELEVANCIA_MIN);
});

test('relevancia: ignora las palabras de karaoke y las vacias de la consulta', () => {
  assert.equal(relevancia('Bohemian Rhapsody karaoke', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King'), 1);
  assert.equal(relevancia('Soda Stereo De Música Ligera', 'De Musica Ligera - Soda Stereo (Karaoke)', ''), 1);
  assert.ok(relevancia('Shape of You', 'Otra Cosa Distinta (Karaoke)', '') < UMBRAL.RELEVANCIA_MIN);
});

test('canal dedicado al karaoke suma', () => {
  const sin = puntuarKaraoke(item('x', 'Bohemian Rhapsody', 'Un canal cualquiera'), Q).score;
  const con = puntuarKaraoke(item('x', 'Bohemian Rhapsody', 'Sing King'), Q).score;
  assert.ok(con >= sin + 30);
});

test('duracion: menos de un minuto o mas de 15 minutos (album) bajan', () => {
  const normal = puntuarKaraoke(item('x', 'Bohemian Rhapsody karaoke', 'c', 355), Q).score;
  assert.ok(puntuarKaraoke(item('x', 'Bohemian Rhapsody karaoke', 'c', 30), Q).score < normal);
  assert.ok(puntuarKaraoke(item('x', 'Bohemian Rhapsody karaoke', 'c', 3600), Q).score < normal - 50);
});

test('seleccion: karaoke primero, ordenado; videoclip oficial al fondo; lo excluido no aparece', () => {
  const items = [
    item('of', 'Queen - Bohemian Rhapsody (Official Video Remastered)', 'Queen Official'),
    item('k1', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King'),
    item('vivo', 'Queen - Bohemian Rhapsody (Live at Wembley)', 'Queen Official'),
    item('inst', 'Queen - Bohemian Rhapsody (Instrumental)', 'Backing Canal'),
    item('tuto', 'Bohemian Rhapsody Piano Tutorial', 'Pianista'),
    item('react', 'Bohemian Rhapsody REACTION', 'Reactor'),
    item('album', 'Queen Greatest Hits Full Album Bohemian Rhapsody', 'Mix', 5400),
    item('otro', 'Hotel California (Karaoke)', 'Sing King'),
  ].map((i) => con(i));
  const ids = seleccionarParaMostrar(items).map((i) => i.videoId);
  assert.deepEqual(ids.slice(0, 2).sort(), ['inst', 'k1'], 'los karaoke/instrumental van primero');
  assert.ok(!ids.includes('tuto') && !ids.includes('react') && !ids.includes('album') && !ids.includes('otro'), 'lo que claramente no sirve no aparece');
  assert.ok(ids.indexOf('of') > ids.indexOf('k1'), 'el videoclip oficial queda despues');
});

test('NUNCA deja la lista vacia: si no hay karaoke igual muestra lo mejor que haya', () => {
  const items = [
    item('of', 'Queen - Bohemian Rhapsody (Official Video Remastered)', 'Queen Official'),
    item('vivo', 'Queen - Bohemian Rhapsody (Live Aid 1985)', 'Queen Official'),
  ].map((i) => con(i));
  const r = seleccionarParaMostrar(items);
  assert.ok(r.length >= 1, 'sin karaoke igual hay candidatos');
  assert.ok(r.every((i) => !i.karaoke.esKaraoke), 'y no se los hace pasar por karaoke');
});

test('duplicados: el mismo video o la misma version subida dos veces se muestran una vez', () => {
  const items = [
    con(item('a', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King')),
    con(item('a', 'Bohemian Rhapsody (Karaoke Version)', 'Sing King')),
    con(item('b', 'Bohemian Rhapsody (Karaoke Version) HD', 'Sing King')),
    con(item('c', 'Bohemian Rhapsody karaoke', 'Otro canal')),
  ];
  const r = deduplicarYOrdenar(items);
  assert.equal(r.filter((i) => i.videoId === 'a').length, 1);
  assert.equal(r.length, 2, 'a/b son la misma version; c es de otro canal');
});

test('plan de consultas: karaoke primero y varias alternativas; si ya pidio karaoke, una sola', () => {
  const p = planDeConsultas('Shape of You');
  assert.equal(p[0], 'Shape of You karaoke');
  assert.ok(p.length >= 4 && p.includes('Shape of You instrumental sing along'));
  assert.deepEqual(planDeConsultas('Shape of You karaoke'), ['Shape of You karaoke']);
  assert.deepEqual(planDeConsultas('  '), []);
});

test('utilidades: duracion ISO 8601, entidades HTML y normalizar', () => {
  assert.equal(duracionISO('PT5M55S'), 355);
  assert.equal(duracionISO('PT1H2M3S'), 3723);
  assert.equal(duracionISO('PT45S'), 45);
  assert.equal(duracionISO('P0D'), 0);
  assert.equal(duracionISO('basura'), 0);
  assert.equal(decodificarHtml('Don&#39;t Stop &amp; Go &quot;ya&quot;'), 'Don\'t Stop & Go "ya"');
  assert.equal(normalizar('Tití Me Preguntó (Remix)'), 'titi me pregunto remix');
});

test('consultas reales del pedido: ningun karaoke bueno queda por debajo de un videoclip', () => {
  const casos = [
    ['Shape of You', 'Ed Sheeran - Shape of You (Karaoke Version)', 'Ed Sheeran - Shape of You (Official Music Video)'],
    ["Shakira Hips Don't Lie", "Shakira - Hips Don't Lie (Karaoke)", "Shakira - Hips Don't Lie ft. Wyclef Jean (Official Video)"],
    ['Soda Stereo De Música Ligera', 'Soda Stereo - De Música Ligera (Karaoke Instrumental)', 'Soda Stereo - De Música Ligera (Video Oficial)'],
    ['Bad Bunny Tití Me Preguntó', 'Bad Bunny - Tití Me Preguntó (Karaoke)', 'Bad Bunny - Tití Me Preguntó (Video Oficial)'],
  ];
  for (const [q, kar, oficial] of casos) {
    const a = puntuarKaraoke(item('k', kar, 'Karaoke Hits', 210), q);
    const b = puntuarKaraoke(item('o', oficial, 'Artista VEVO', 210), q);
    assert.ok(a.score > b.score + 60, `${q}: ${a.score} vs ${b.score}`);
    assert.equal(a.excluir, false, q);
  }
});
