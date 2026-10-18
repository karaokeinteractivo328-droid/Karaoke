// Desfase de la letra por cancion: se guarda, se limita y sobrevive a un reinicio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearOffsets, normalizarOffset } from '../offsets.js';

test('normalizar: redondea a 0,1 s y limita a +-60 s; lo que no es numero se rechaza', () => {
  assert.equal(normalizarOffset(12.34), 12.3);
  assert.equal(normalizarOffset(-999), -60);
  assert.equal(normalizarOffset(999), 60);
  assert.equal(normalizarOffset('abc'), null);
  assert.equal(normalizarOffset(undefined), null);
});

test('se guarda en el archivo y otro arranque lo recupera', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-off-'));
  const archivo = join(dir, 'sub', 'offsets.json');
  const a = crearOffsets({ archivo, demoraMs: 5 });
  assert.equal(a.get('yt-abcdefghijk'), null);
  assert.equal(a.set('yt-abcdefghijk', 11.96), 12);
  a.guardarAhora();
  assert.equal(JSON.parse(await readFile(archivo, 'utf8'))['yt-abcdefghijk'], 12);
  const b = crearOffsets({ archivo });
  assert.equal(b.get('yt-abcdefghijk'), 12, 'despues de reiniciar el server sigue');
  await rm(dir, { recursive: true, force: true });
});

test('ids raros y valores invalidos no se guardan; un archivo roto no tumba el arranque', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'karaoke-off-'));
  const archivo = join(dir, 'offsets.json');
  const o = crearOffsets({ archivo, demoraMs: 5 });
  assert.equal(o.set('../../etc', 3), null);
  assert.equal(o.set('yt-ok', 'x'), null);
  assert.deepEqual(o.todos(), {});
  const { writeFile } = await import('node:fs/promises');
  await writeFile(archivo, '{no es json');
  assert.deepEqual(crearOffsets({ archivo }).todos(), {});
  await rm(dir, { recursive: true, force: true });
});
