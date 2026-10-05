// Prueba end-to-end con sockets reales: levanta el server en otro puerto con
// tiempos cortos y simula una pantalla + varios celus.  Uso:
//   node server/test/integracion.mjs
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));

const server = spawn(process.execPath, [join(dir, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    ESCENARIO_CONFIG: JSON.stringify({
      LLAMADO_MS: 4000,
      LLAMADO_SIN_CANCION_MS: 4000,
      COUNTDOWN_S: 1,
      RESULT_MS: 2000,
      RESULT_INTERRUMPIDO_MS: 1500,
      CALLED_DESCONEXION_MS: 1500,
      AUDIO_REQUERIDO: false, // el audio real se prueba en integracion3.mjs
        }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(d));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  OK  ' : ' FALLO'} ${msg}`);
  if (!cond) fallos++;
};

function cliente(rol) {
  const s = io(BASE, { query: { rol }, transports: ['websocket'], forceNew: true });
  s.estado = null;
  s.yo = null;
  s.reacciones = [];
  s.on('estado', (e) => { s.estado = e; });
  s.on('yo', (y) => { s.yo = y; });
  s.on('reaccion', (r) => s.reacciones.push(r));
  s.emitAck = (ev, datos) => new Promise((res) => s.emit(ev, datos, res));
  return s;
}
async function hasta(fn, ms = 6000, msg = 'condicion') {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (fn()) return true;
    await espera(50);
  }
  console.log(`   (timeout esperando: ${msg})`);
  return false;
}
const tk = (n) => `integracion-${n}`.padEnd(24, 'x');

try {
  // esperar a que el server escuche
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch {}
    await espera(200);
  }

  console.log('\n== Infra');
  const h = await (await fetch(`${BASE}/healthz`)).json();
  ok(h.ok && h.etapa === 'STANDBY', '/healthz responde y arranca en STANDBY');
  const q1 = await (await fetch(`${BASE}/api/qr`)).json();
  const q2 = await (await fetch(`${BASE}/api/qr`)).json();
  ok(q1.url.endsWith('/sala') && q1.url === q2.url && !q1.url.includes('codigo'), `QR unico y estable (${q1.url})`);

  const pantalla = cliente('pantalla');
  await hasta(() => pantalla.estado, 3000, 'estado pantalla');
  ok(pantalla.estado?.etapa === 'STANDBY', 'pantalla ve STANDBY');

  console.log('\n== Caso 1: llego y nadie canta');
  const iara = cliente('celu');
  await iara.emitAck('hola', { token: tk(1), nombre: 'Iara' });
  const r1 = await iara.emitAck('fila:entrar', { nombre: 'Iara' });
  ok(r1.ok, 'Iara entra a la fila');
  await hasta(() => pantalla.estado?.etapa === 'CALLING', 2000, 'CALLING');
  ok(pantalla.estado.actual?.nombre === 'Iara', 'la pantalla llama a Iara');
  ok(iara.yo?.estado === 'CALLED', 'su celu pasa a CALLED');
  const el = await iara.emitAck('cancion:elegir', { cancionId: 'corre', modo: 'solo' });
  ok(el.ok, 'elige canción');
  ok(pantalla.estado.actual?.preparada === true, 'la pantalla sabe que dejó una canción preparada');
  const hand = await iara.emitAck('turno:listo', {});
  ok(hand.ok, 'sin cámara sana, el celu puede empezar (respaldo)');
  // (el LISTO es siempre del celu: la pantalla no elige ni confirma canciones)
  await hasta(() => pantalla.estado?.etapa === 'PLAYING', 4000, 'PLAYING');
  ok(pantalla.estado?.etapa === 'PLAYING', 'COUNTDOWN -> PLAYING solo');
  ok(!!pantalla.estado?.privado, 'la pantalla primaria recibe datos privados');

  console.log('\n== Caso 2/3: llegan mientras canta');
  const yaz = cliente('celu');
  const roc = cliente('celu');
  await yaz.emitAck('hola', { token: tk(2), nombre: 'Yazmín' });
  await roc.emitAck('hola', { token: tk(3), nombre: 'Rocío' });
  ok(yaz.yo?.estado === 'PUBLIC' && pantalla.estado.etapa === 'PLAYING', 'entran como público sin interrumpir');
  for (let i = 0; i < 4; i++) { await yaz.emitAck('reaccion', { tipo: 'corazon' }); await espera(300); }
  ok(pantalla.reacciones.length >= 4 && pantalla.reacciones.at(-1).totales.corazon >= 3, 'las reacciones llegan con totales del server');
  ok(pantalla.reacciones[0].nombre === 'Yazmín', 'la reacción trae el nombre de quien la mandó');
  // dos personas piden el turno "a la vez": manda el orden de llegada
  const [a, b] = await Promise.all([
    yaz.emitAck('fila:entrar', { nombre: 'Yazmín' }),
    roc.emitAck('fila:entrar', { nombre: 'Rocío' }),
  ]);
  ok(a.ok && b.ok, 'ambas entran a la fila');
  await hasta(() => pantalla.estado?.filaTotal === 2, 2000, 'fila de 2');
  const orden = pantalla.estado.fila.map((x) => x.nombre);
  ok(orden.length === 2 && new Set(orden).size === 2, `orden determinado por el server (${orden.join(' > ')})`);
  const primera = orden[0] === 'Yazmín' ? yaz : roc;
  const segunda = primera === yaz ? roc : yaz;
  await primera.emitAck('cancion:elegir', { cancionId: 'baby', modo: 'duo' });
  ok(primera.yo?.posicion === 1 && segunda.yo?.posicion === 2, 'posiciones 1 y 2 en los celus');
  ok(typeof primera.yo?.etaSeg === 'number', 'cada celu sabe cuánto falta (ETA)');
  ok(pantalla.estado.siguiente?.nombre === orden[0], 'la pantalla solo muestra "SIGUE: ' + orden[0] + '"');

  console.log('\n== Autorización');
  yaz.emit('pantalla:fin', { progreso: 1 }); // un celu intentando cerrar la canción
  await espera(300);
  ok(pantalla.estado.etapa === 'PLAYING', 'un celu NO puede terminar la canción de otro');
  const noEsMio = await primera.emitAck('turno:listo', {});
  ok(!noEsMio.ok, 'LISTO fuera de turno es rechazado');
  const sinSesion = cliente('celu');
  const rs = await sinSesion.emitAck('fila:entrar', { nombre: 'X' });
  ok(!rs.ok, 'sin token no se puede hacer nada');
  sinSesion.disconnect();

  console.log('\n== Fin de canción -> RESULT -> siguiente automático');
  pantalla.emit('pantalla:retoCumplido', { id: 'int1', tipo: 'una', puntos: 10 });
  pantalla.emit('pantalla:fin', { progreso: 1 });
  await hasta(() => pantalla.estado?.etapa === 'RESULT', 2000, 'RESULT');
  const res = pantalla.estado.actual.resultado;
  ok(res && res.total > 0 && res.desglose.retos === 10, `resultado con desglose (${res?.total} pts: ${JSON.stringify(res?.desglose)})`);
  ok(res.reacciones.corazon >= 3, 'las reacciones suman al resultado');
  ok(pantalla.estado.siguiente?.nombre === orden[0], 'durante el resultado ya se sabe quién sigue');
  ok(iara.yo?.estado === 'DONE' && !!iara.yo?.videoToken, 'Iara ve su resultado y tiene su link de video privado');
  await hasta(() => pantalla.estado?.etapa === 'CALLING', 4000, 'siguiente llamado');
  ok(pantalla.estado.actual?.nombre === orden[0], 'pasa automáticamente al siguiente (ya tenía canción)');
  ok(pantalla.estado.actual.preparada === true && pantalla.estado.actual.cancion?.id === 'baby', 'su canción ya estaba preparada (solo toca LISTO)');
  const siguienteCelu = orden[0] === 'Yazmín' ? yaz : roc;
  const listoSig = await siguienteCelu.emitAck('turno:listo', {});
  ok(listoSig.ok, 'el celu del siguiente toca LISTO');
  await hasta(() => ['COUNTDOWN', 'PLAYING'].includes(pantalla.estado?.etapa), 2000, 'arranca');
  ok(['COUNTDOWN', 'PLAYING'].includes(pantalla.estado.etapa), 'arranca la performance siguiente sin volver a STANDBY');
  await hasta(() => pantalla.estado?.etapa === 'PLAYING', 3000, 'PLAYING 2');
  pantalla.emit('pantalla:fin', { progreso: 1 });
  await hasta(() => pantalla.estado?.etapa === 'RESULT', 2000, 'RESULT 2');
  await hasta(() => pantalla.estado?.etapa === 'CALLING', 4000, 'CALLING con el tercero');

  console.log('\n== Caso 4/8: el llamado pierde la conexión -> se libera y sigue el que espera');
  ok(pantalla.estado.actual?.nombre === orden[1], 'el tercero de la fila ya fue llamado tras la 2da performance');
  segunda.disconnect();
  await hasta(() => pantalla.estado?.etapa === 'STANDBY', 6000, 'STANDBY tras perder al llamado');
  ok(pantalla.estado?.etapa === 'STANDBY', 'se saltea al desconectado (nadie más espera: STANDBY)');

  console.log('\n== Caso 7: nadie responde -> vuelve a STANDBY');
  await hasta(() => pantalla.estado?.etapa === 'STANDBY', 8000, 'STANDBY');
  ok(pantalla.estado?.etapa === 'STANDBY', 'sin nadie esperando vuelve a STANDBY');

  console.log('\n== Video privado');
  const sinPermiso = await fetch(`${BASE}/api/video/${'a'.repeat(32)}`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.from('xxxx'),
  });
  ok(sinPermiso.status === 403, 'subir con un token inventado es rechazado (403)');
  const conPermiso = await fetch(`${BASE}/api/video/${iara.yo.videoToken}`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(2000, 1),
  });
  ok(conPermiso.status === 200, 'el token real de una performance sí puede subir');
  const otraVez = await fetch(`${BASE}/api/video/${iara.yo.videoToken}`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(2000, 1),
  });
  ok(otraVez.status === 409, 'y solo una vez (409)');
  const inexistente = await fetch(`${BASE}/video/${'b'.repeat(32)}`);
  ok(inexistente.status === 404, 'una página de video inexistente da 404');

  console.log('\n== Pantalla espejo');
  const pantalla2 = cliente('pantalla');
  let espejo = false;
  pantalla.on('pantalla:espejo', () => { espejo = true; });
  await espera(500);
  ok(espejo, 'la pantalla anterior queda como espejo cuando se conecta otra');
  pantalla2.disconnect();
  pantalla.disconnect();
} catch (e) {
  console.error('ERROR en la prueba:', e);
  fallos++;
} finally {
  server.kill();
  console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
}
