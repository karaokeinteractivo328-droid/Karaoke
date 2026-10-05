// Buscador del celu: debounce, cancelacion, estados, paginacion, reintento.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearBuscador } from '../src/lib/buscador.js';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function item(i) {
  return { id: `x${i}`, titulo: `Tema ${i}`, artista: 'A', duracion: 200, fuente: 'lrclib', lista: false };
}

// API simulada: `respuestas` es una funcion (q, pagina) => objeto | Error
function armar(respuestas, { debounceMs = 15 } = {}) {
  const pedidos = [];
  const cambios = [];
  const fetchFn = async (url, { signal } = {}) => {
    const u = new URL(url, 'http://x');
    const q = u.searchParams.get('q');
    const pagina = Number(u.searchParams.get('pagina'));
    pedidos.push({ q, pagina });
    await espera(5);
    if (signal?.aborted) throw Object.assign(new Error('abortado'), { name: 'AbortError' });
    const r = respuestas(q, pagina);
    if (r instanceof Error) throw r;
    if (r.status) return { ok: false, status: r.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  const b = crearBuscador({ base: 'http://srv', fetchFn, debounceMs, onCambio: (e) => cambios.push(e) });
  return { b, pedidos, cambios };
}

const pag = (items, { pagina = 0, hayMas = false, total = items.length, error = null, remoto = true } = {}) => ({ q: '', pagina, items, hayMas, total, remoto, error });

test('debounce: escribir "soda" letra por letra hace UN solo pedido, no cuatro', async () => {
  const { b, pedidos } = armar(() => pag([item(1)]));
  b.iniciar();
  await espera(30);
  pedidos.length = 0;
  for (const t of ['so', 'sod', 'soda']) {
    b.consultar(t);
    await espera(4);
  }
  await espera(60);
  assert.deepEqual(pedidos.map((p) => p.q), ['soda']);
});

test('una sola letra no consulta la red; la misma consulta no se repite', async () => {
  const { b, pedidos } = armar(() => pag([item(1)]));
  b.iniciar();
  await espera(30);
  pedidos.length = 0;
  b.consultar('s');
  await espera(40);
  assert.equal(pedidos.length, 0);
  b.consultar('soda');
  await espera(50);
  b.consultar('soda');
  b.consultar('  soda ');
  await espera(50);
  assert.equal(pedidos.length, 1);
});

test('estados: cargando -> ok con resultados', async () => {
  const { b, cambios } = armar(() => pag([item(1), item(2)]));
  b.consultar('abc');
  assert.equal(b.estado.estado, 'cargando');
  await espera(60);
  assert.equal(b.estado.estado, 'ok');
  assert.equal(b.estado.items.length, 2);
  assert.ok(cambios.some((c) => c.estado === 'cargando'), 'la interfaz vio el loading');
});

test('estado vacio cuando no hay nada', async () => {
  const { b } = armar(() => pag([]));
  b.consultar('zzzz');
  await espera(60);
  assert.equal(b.estado.estado, 'vacio');
});

test('error de red -> estado error con mensaje, y reintentar funciona', async () => {
  let falla = true;
  const { b } = armar(() => (falla ? new Error('sin red') : pag([item(1)])));
  b.consultar('soda');
  await espera(60);
  assert.equal(b.estado.estado, 'error');
  assert.match(b.estado.error, /sin red/);
  falla = false;
  await b.reintentar();
  assert.equal(b.estado.estado, 'ok');
  assert.equal(b.estado.error, null);
});

test('429 (demasiados pedidos) y 500 se muestran como error, no se cuelga', async () => {
  const { b } = armar(() => ({ status: 429 }));
  b.consultar('soda');
  await espera(60);
  assert.equal(b.estado.estado, 'error');
  assert.match(b.estado.error, /seguidas/);
});

test('error parcial: hay resultados locales pero lo online fallo -> se ven y se avisa', async () => {
  const { b } = armar(() => pag([item(1)], { error: 'No se pudo consultar el catálogo online' }));
  b.consultar('soda');
  await espera(60);
  assert.equal(b.estado.estado, 'ok');
  assert.match(b.estado.error, /catálogo online/);
});

test('un resultado viejo que llega tarde NO pisa a la consulta mas nueva', async () => {
  const { b } = armar((q) => pag([{ ...item(1), titulo: `resultado de ${q}` }]));
  b.consultar('aaa');
  await espera(20); // sale el pedido de "aaa"
  b.consultar('bbb');
  await espera(80);
  assert.equal(b.estado.items[0].titulo, 'resultado de bbb');
});

test('paginacion: ver mas agrega la pagina siguiente sin repetir ni pisar', async () => {
  const todas = Array.from({ length: 25 }, (_, i) => item(i));
  const { b, pedidos } = armar((q, p) => pag(todas.slice(p * 10, p * 10 + 10), { pagina: p, hayMas: p < 2, total: 25 }));
  b.consultar('tema');
  await espera(60);
  assert.equal(b.estado.items.length, 10);
  assert.equal(b.estado.hayMas, true);
  await b.masResultados();
  assert.equal(b.estado.items.length, 20);
  await b.masResultados();
  assert.equal(b.estado.items.length, 25);
  assert.equal(b.estado.hayMas, false);
  assert.equal(b.masResultados(), undefined, 'no hay mas: no pide');
  assert.deepEqual(pedidos.map((p) => p.pagina), [0, 1, 2]);
  assert.equal(new Set(b.estado.items.map((i) => i.id)).size, 25);
});

test('consulta vacia = biblioteca local (se pide con q vacia)', async () => {
  const { b, pedidos } = armar(() => pag([item(1)], { remoto: false }));
  b.iniciar();
  await espera(40);
  assert.equal(pedidos[0].q, '');
  assert.equal(b.estado.estado, 'ok');
  assert.equal(b.estado.remoto, false, 'la interfaz sabe que no hay catalogo online');
});
