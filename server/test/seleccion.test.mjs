// Seleccion de cancion + video: LRCLIB manda, YouTube se adapta (logica pura, sin red).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tituloLimpio, mismoTema, agruparTemas, mejorVariante, puntuarVideo, elegirVideo, consultasDe } from '../seleccion.js';

const LRC = '[00:05.00] hola\n';
const r = (id, artista, titulo, dur, extra = {}) => ({ id, artistName: artista, trackName: titulo, duration: dur, syncedLyrics: LRC, instrumental: false, ...extra });
const v = (id, titulo, dur, canal = 'Canal') => ({ videoId: id.padEnd(11, 'x'), titulo, canal, duracion: dur });

test('titulo limpio: sin parentesis, sin "artista - " delante', () => {
  assert.equal(tituloLimpio('TINI, Maria Becerra - Miénteme (Video Oficial)'), 'Miénteme');
  assert.equal(tituloLimpio('De Música Ligera'), 'De Música Ligera');
  assert.equal(tituloLimpio("Hips Don't Lie [Remastered]"), "Hips Don't Lie");
});

test('mismo tema: "TINI" y "TINI, Maria Becerra" lo son; distinto artista o distinto titulo, no', () => {
  assert.equal(mismoTema('TINI', 'Miénteme', 'TINI, Maria Becerra', 'TINI, Maria Becerra - Miénteme (Video Oficial)'), true);
  assert.equal(mismoTema('Queen', 'Bohemian Rhapsody', 'Queen', 'Radio Ga Ga'), false);
  assert.equal(mismoTema('Queen', 'Despacito', 'Luis Fonsi', 'Despacito'), false, 'dos artistas con un tema del mismo nombre');
  assert.equal(mismoTema('Jesse & Joy', 'Corre', 'Jesse y Joy', '¡Corre!'), true, 'tildes, signos y conectores no cuentan');
});

test('agrupar: un tema con muchas versiones es UNO solo; en vivo, remix, karaoke e instrumental se descartan', () => {
  const crudo = [
    r(1, 'TINI', 'TINI, Maria Becerra - Miénteme (Video Oficial)', 183),
    r(2, 'TINI, Maria Becerra', 'Miénteme', 183),
    r(3, 'TINI', 'Miénteme', 165),
    r(4, 'TINI', 'Miénteme (Live)', 200),
    r(5, 'TINI', 'Miénteme - Remix', 190),
    r(6, 'TINI', 'Miénteme (Karaoke Version)', 183),
    r(7, 'Queen', 'Radio Ga Ga', 343),
    r(8, 'Queen', 'Sin letra', 200, { syncedLyrics: null }),
    r(9, 'Queen', 'Instrumental', 200, { instrumental: true }),
    r(10, 'Queen', 'Muy corta', 20),
  ];
  const t = agruparTemas(crudo);
  assert.deepEqual(t.map((x) => x.titulo), ['Miénteme', 'Radio Ga Ga']);
  const mien = t[0];
  assert.equal(mien.duracion, 183, 'la duracion de estudio es la que mas versiones tiene');
  assert.deepEqual(mien.variantes.map((x) => x.id).sort(), [1, 2, 3], 'todas las versiones de estudio, con su duracion');
  assert.ok([1, 2].includes(mien.id), 'el representante es de la version principal (183 s), no de la recortada');
});

test('agrupar: respeta el maximo y tolera basura', () => {
  const crudo = Array.from({ length: 30 }, (_, i) => r(i + 1, `Artista ${i}`, `Tema numero ${i}`, 200));
  assert.equal(agruparTemas(crudo, { max: 15 }).length, 15);
  assert.deepEqual(agruparTemas(null), []);
  assert.deepEqual(agruparTemas([null, {}, 5]), []);
});

test('mejor variante: la version de la letra de duracion mas parecida', () => {
  const vars = [{ id: 1, duracion: 183 }, { id: 2, duracion: 165 }];
  assert.equal(mejorVariante(164, vars).variante.id, 2);
  assert.equal(mejorVariante(184, vars).dif, 1);
  assert.equal(mejorVariante(100, []), null);
});

const tema = { artista: 'Queen', titulo: 'Bohemian Rhapsody', variantes: [{ id: 1, duracion: 355 }, { id: 2, duracion: 289 }] };

test('ORIGINAL: audio de duracion igual a la letra = "exacta" y confiable; el audio oficial gana al resto', () => {
  const a = puntuarVideo(v('a', 'Queen - Bohemian Rhapsody (Official Audio)', 355, 'Queen Official'), tema, 'original');
  const b = puntuarVideo(v('b', 'Queen - Bohemian Rhapsody (Official Video)', 355), tema, 'original');
  const c = puntuarVideo(v('c', 'Queen - Bohemian Rhapsody', 355), tema, 'original');
  assert.equal(a.nivel, 'exacta');
  assert.equal(a.confiable, true);
  assert.ok(a.score > b.score && b.score > c.score, 'audio oficial > video oficial > cualquier subida');
});

test('ORIGINAL: usa la version de la letra que mas se le parece (el audio de 289 s va con la letra de 289 s)', () => {
  const p = puntuarVideo(v('a', 'Queen - Bohemian Rhapsody (Official Audio)', 290), tema, 'original');
  assert.equal(p.variante.id, 2);
  assert.equal(p.nivel, 'exacta');
});

test('ORIGINAL: descarta karaoke, en vivo, covers y videos que duran muy distinto a la letra', () => {
  for (const t of ['Queen - Bohemian Rhapsody (Karaoke Version)', 'Bohemian Rhapsody instrumental', 'Queen - Bohemian Rhapsody (Live at Wembley)', 'Bohemian Rhapsody cover by Fulano', 'Bohemian Rhapsody Slowed + Reverb']) {
    assert.equal(puntuarVideo(v('a', t, 355), tema, 'original').excluir, true, t);
  }
  assert.equal(puntuarVideo(v('a', 'Queen - Bohemian Rhapsody (Official Audio)', 400), tema, 'original').excluir, true, 'dura 45 s de mas: otra edicion');
});

test('ORIGINAL: 3 a 6 s de diferencia se acepta pero NO queda confiable (se avisa para alinear)', () => {
  const p = puntuarVideo(v('a', 'Queen - Bohemian Rhapsody (Official Audio)', 360), tema, 'original');
  assert.equal(p.excluir, false);
  assert.equal(p.nivel, 'media');
  assert.equal(p.confiable, false);
});

test('KARAOKE: nunca confiable (un karaoke puede durar igual y tener 25 s de intro), pero la duracion igual suma', () => {
  const k = { score: 100, esKaraoke: true, excluir: false };
  const igual = puntuarVideo({ ...v('a', 'Queen - Bohemian Rhapsody (Karaoke)', 355), karaoke: k }, tema, 'karaoke');
  const lejos = puntuarVideo({ ...v('b', 'Queen - Bohemian Rhapsody (Karaoke)', 400), karaoke: k }, tema, 'karaoke');
  assert.equal(igual.confiable, false);
  assert.equal(igual.nivel, 'aproximada');
  assert.ok(igual.score > lejos.score);
  assert.equal(puntuarVideo({ ...v('c', 'x', 355), karaoke: { score: 5, esKaraoke: false, excluir: true } }, tema, 'karaoke').excluir, true);
});

test('KARAOKE: un video que no es karaoke baja mucho frente a uno que si lo es', () => {
  const es = puntuarVideo({ ...v('a', 'x', 355), karaoke: { score: 80, esKaraoke: true, excluir: false } }, tema, 'karaoke');
  const no = puntuarVideo({ ...v('b', 'x', 355), karaoke: { score: 80, esKaraoke: false, excluir: false } }, tema, 'karaoke');
  assert.ok(es.score - no.score >= 50);
});

test('elegir video: el mejor de la lista, o null si ninguno sirve', () => {
  const lista = [v('a', 'Queen - Bohemian Rhapsody (Karaoke)', 355), v('b', 'Queen - Bohemian Rhapsody (Live)', 355), v('c', 'Queen - Bohemian Rhapsody (Official Audio)', 356), v('d', 'Queen - Bohemian Rhapsody', 354)];
  assert.equal(elegirVideo(lista, tema, 'original').video.videoId.startsWith('c'), true);
  assert.equal(elegirVideo([v('a', 'Bohemian Rhapsody (Karaoke)', 355)], tema, 'original'), null);
  assert.equal(elegirVideo([], tema, 'karaoke'), null);
});

test('consultas: original = "official audio" y despues sin adornos; karaoke = "karaoke"', () => {
  assert.deepEqual(consultasDe(tema, 'original'), ['Queen Bohemian Rhapsody official audio', 'Queen Bohemian Rhapsody']);
  assert.deepEqual(consultasDe(tema, 'karaoke'), ['Queen Bohemian Rhapsody karaoke']);
});
