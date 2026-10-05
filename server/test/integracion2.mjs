// Integracion de lo que cambio en esta ronda, con sockets REALES y un server
// que se reinicia de verdad:
//   - identidad por handshake (un intent no puede llegar antes que la sesion)
//   - reinicio del server: los celus reconectan solos y siguen funcionando
//   - QR general estable (y distinto del QR del video)
//   - reto de la palabra + retos de gestos con puntos reales en el resultado
//   - video: subida, conversion a mp4, estados, tokens independientes
//
//   node server/test/integracion2.mjs
import { spawn, execFile } from 'node:child_process';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ffmpegPath from 'ffmpeg-static';

const PORT = 3098;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));

const ENV = {
  ...process.env,
  PORT: String(PORT),
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ESCENARIO_CONFIG: JSON.stringify({
    LLAMADO_MS: 8000,
    LLAMADO_SIN_CANCION_MS: 8000,
    COUNTDOWN_S: 1,
    RESULT_MS: 3000,
    RESULT_INTERRUMPIDO_MS: 1500,
    CALLED_DESCONEXION_MS: 4000,
      AUDIO_REQUERIDO: false, // el audio real se prueba en integracion3.mjs
  }),
};

let server = null;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  OK  ' : ' FALLO'} ${msg}`);
  if (!cond) fallos++;
};

async function arrancar() {
  server = spawn(process.execPath, [join(dir, '..', 'server.js')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await espera(150);
  }
  throw new Error('el server no arranco');
}
async function parar() {
  const p = server;
  server = null;
  if (!p) return;
  const salio = new Promise((r) => p.once('exit', r));
  p.kill();
  await salio;
}

function cliente(rol, auth) {
  const s = io(BASE, { query: { rol }, auth, transports: ['websocket'], forceNew: true, reconnectionDelay: 200, reconnectionDelayMax: 500 });
  s.estado = null;
  s.yo = null;
  s.resultados = [];
  s.on('estado', (e) => { s.estado = e; });
  s.on('yo', (y) => { s.yo = y; });
  s.on('reto:resultado', (r) => s.resultados.push(r));
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
const tk = (n) => `integra2-${n}`.padEnd(24, 'x');

function crearWebm(destino) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-shortest', destino],
      { timeout: 60_000 },
      (err, _o, stderr) => (err ? reject(new Error(stderr.split('\n').slice(-5).join('\n'))) : resolve())
    );
  });
}

// lleva a `celu` (ya primero en la fila) a PLAYING usando el respaldo del celu
async function aPlaying(pantalla, celu, cancionId = 'corre') {
  await hasta(() => pantalla.estado?.etapa === 'CALLING', 3000, 'CALLING');
  await celu.emitAck('cancion:elegir', { cancionId, modo: 'solo' });
  const r = await celu.emitAck('turno:listo', {});
  if (!r.ok) return false;
  return hasta(() => pantalla.estado?.etapa === 'PLAYING', 5000, 'PLAYING');
}

try {
  await arrancar();

  // ------------------------------------------------------------- A. handshake
  console.log('\n== A. La identidad viaja en el handshake (sin carrera con "hola")');
  const pantalla = cliente('pantalla');
  await hasta(() => pantalla.estado, 3000, 'estado pantalla');
  const rapido = cliente('celu', { token: tk(1), nombre: 'Rápida' });
  // NO se manda "hola": el primer intent ya tiene que encontrar la sesion
  const r0 = await rapido.emitAck('fila:entrar', { nombre: 'Rápida' });
  ok(r0.ok === true, 'fila:entrar justo al conectar funciona (antes: "Sin sesion: recarga la pagina")');
  await hasta(() => rapido.yo, 2000, 'yo');
  ok(rapido.yo?.estado === 'CALLED', 'queda registrada y llamada');
  const sinToken = cliente('celu');
  const r1 = await sinToken.emitAck('fila:entrar', { nombre: 'X' });
  ok(r1.ok === false, 'sin token no se puede nada');
  sinToken.close();

  // ---- acciones SIN callback (el boton de reacciones del celu no espera respuesta)
  console.log('\n== A2. Acciones sin callback (reacciones del celu)');
  const espia = cliente('celu', { token: tk(9), nombre: 'Espía' });
  await espia.emitAck('hola', { token: tk(9), nombre: 'Espía' });
  const fanA = cliente('celu', { token: tk(8), nombre: 'FanA' });
  await fanA.emitAck('hola', { token: tk(8), nombre: 'FanA' });
  let vista = null;
  espia.on('reaccion', (r) => { vista = r; });
  fanA.emit('reaccion', { tipo: 'corazon' }); // SIN callback, como el boton del celu
  await hasta(() => vista, 1500, 'reaccion sin callback');
  ok(vista?.tipo === 'corazon' && vista?.nombre === 'FanA', 'una reaccion mandada sin callback llega a todos (la pantalla las dibuja)');
  fanA.emit('modo:elegir', { modo: 'duo' });
  await espera(200);
  ok(true, 'acciones sin callback no rompen al server');
  fanA.close();
  espia.close();

  // -------------------------------------------------------------------- B. QR
  console.log('\n== B. QR general vs QR del video');
  const qA = await (await fetch(`${BASE}/api/qr`)).json();
  const qV = await (await fetch(`${BASE}/api/qr-resultado?token=abcdef0123456789abcdef0123456789`)).json();
  ok(qA.url.endsWith('/sala') && !qA.url.includes('codigo') && !qA.url.includes('token'), `QR general: ${qA.url}`);
  ok(qV.url?.includes('/video/') && qV.dataUrl !== qA.dataUrl, 'el QR del video es otro y apunta a /video/<token>');

  // ------------------------------------------------- C. retos + palabra + puntos
  console.log('\n== C. Retos con puntos reales y reto de la palabra');
  const fan = cliente('celu', { token: tk(2), nombre: 'Fan' });
  await fan.emitAck('hola', { token: tk(2), nombre: 'Fan' });
  ok(await aPlaying(pantalla, rapido), 'Rápida llega a PLAYING');

  const ack = await pantalla.emitAck('pantalla:retoPalabra', { id: 'pw1', opciones: ['amor', 'noche', 'fuego'], correcta: 2, dur: 8 });
  ok(ack?.ok === true, 'la pantalla publica el reto de la palabra');
  await hasta(() => fan.estado?.actual?.retoPalabra, 2000, 'reto en el estado');
  const pub = fan.estado?.actual?.retoPalabra;
  ok(pub?.opciones?.length === 3, 'todos ven las opciones');
  ok(!JSON.stringify(fan.estado).includes('"correcta"'), 'pero NUNCA cual es la correcta');
  const noPuede = await fan.emitAck('reto:responder', { id: 'pw1', opcion: 2 });
  ok(noPuede.ok === false, 'el público no puede contestar por el cantante');
  const mala = await rapido.emitAck('reto:responder', { id: 'pw1', opcion: 0 });
  ok(mala.ok === true && mala.acierto === false && mala.palabra === 'fuego', 'respuesta equivocada: el server compara y dice cual era');
  await hasta(() => pantalla.resultados.length >= 1, 1500, 'reto:resultado');
  ok(pantalla.resultados[0]?.acierto === false && pantalla.resultados[0]?.palabra === 'fuego', 'la pantalla recibe el resultado (error) para mostrarlo');
  ok(pantalla.estado?.actual?.retosPuntos === 0, 'error = 0 puntos');

  await pantalla.emitAck('pantalla:retoPalabra', { id: 'pw2', opciones: ['luz', 'mar', 'sol'], correcta: 1, dur: 8 });
  // simula la mano: pantalla responde la opcion 1 (pellizco sostenido en esa opcion)
  pantalla.emit('pantalla:retoResponder', { id: 'pw2', opcion: 1 });
  await hasta(() => pantalla.resultados.length >= 2, 1500, 'segundo resultado');
  ok(pantalla.resultados[1]?.acierto === true && pantalla.resultados[1]?.puntos === 10, 'acierto con la mano: +10');
  ok(pantalla.estado?.actual?.retosPuntos === 10, 'el server suma los 10');

  pantalla.emit('pantalla:retoCumplido', { id: 'g1', tipo: 'dos', puntos: 10 });
  for (let i = 0; i < 6; i++) pantalla.emit('pantalla:retoCumplido', { id: 'g1', tipo: 'dos', puntos: 10 }); // gesto sostenido: se reenvia
  await hasta(() => pantalla.estado?.actual?.retosPuntos === 20, 1500, 'retos 20');
  await espera(300);
  ok(pantalla.estado?.actual?.retosPuntos === 20, 'RETOS: 20/30 (el gesto repetido no suma otra vez)');

  // reaccion del público antes del fin
  for (let i = 0; i < 3; i++) { await fan.emitAck('reaccion', { tipo: 'fuego' }); await espera(300); }

  // -------------------------------------------------------------------- D. video
  console.log('\n== D. Video: subida, conversion y estados');
  pantalla.emit('pantalla:fin', { progreso: 1 });
  await hasta(() => pantalla.estado?.etapa === 'RESULT', 3000, 'RESULT');
  const res = pantalla.estado?.actual?.resultado;
  ok(res?.desglose?.retos === 20 && res?.desglose?.cancion === 40, `desglose del resultado: cancion ${res?.desglose?.cancion} · retos ${res?.desglose?.retos} · publico ${res?.desglose?.publico}`);
  ok(res?.total === 40 + 20 + res?.desglose?.publico, `TOTAL ${res?.total} = suma de las partes`);
  await hasta(() => rapido.yo?.videoToken, 2000, 'videoToken del cantante');
  const tokA = rapido.yo?.videoToken;
  ok(/^[0-9a-f]{32}$/.test(tokA || ''), 'el cantante recibe el token de SU video');
  ok(pantalla.estado?.privado?.videoToken === tokA, 'la pantalla primaria tiene el mismo token (para subirlo y armar el QR)');
  ok(fan.yo?.videoToken == null, 'el resto del público no lo ve');

  let est = await (await fetch(`${BASE}/api/video/${tokA}/estado`)).json();
  ok(est.estado === 'esperando', `antes de la subida: "${est.estado}"`);
  const malo = await fetch(`${BASE}/api/video/${'f'.repeat(32)}`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.from('x') });
  ok(malo.status === 403, 'token que el server no emitio: subida rechazada (403)');
  est = await (await fetch(`${BASE}/api/video/${'f'.repeat(32)}/estado`)).json();
  ok(est.estado === 'desconocido', 'token ajeno: "desconocido"');
  const noPage = await fetch(`${BASE}/video/${'f'.repeat(32)}`);
  ok(noPage.status === 404, 'pagina de un video que no existe: 404');

  const webm = join(tmpdir(), `karaoke-test-${Date.now()}.webm`);
  await crearWebm(webm);
  const cuerpo = await readFile(webm);
  const sube = await fetch(`${BASE}/api/video/${tokA}`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: cuerpo });
  ok(sube.ok, `la pantalla sube el webm (${(cuerpo.length / 1000).toFixed(0)} KB)`);
  const otra = await fetch(`${BASE}/api/video/${tokA}`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: cuerpo });
  ok(otra.status === 409, 'una segunda subida del mismo video: 409');
  est = await (await fetch(`${BASE}/api/video/${tokA}/estado`)).json();
  ok(est.estado === 'procesando' || est.estado === 'listo', `despues de subir: "${est.estado}"`);
  const pag = await (await fetch(`${BASE}/video/${tokA}`)).text();
  ok(pag.includes('Procesando') || pag.includes('listo'), 'la pagina del celu explica el estado (no queda en blanco)');
  let listo = false;
  for (let i = 0; i < 120 && !listo; i++) {
    est = await (await fetch(`${BASE}/api/video/${tokA}/estado`)).json();
    listo = est.estado === 'listo';
    if (!listo) await espera(500);
  }
  ok(listo, 'el mp4 queda LISTO');
  const mp4 = await fetch(`${BASE}/video/${tokA}.mp4`);
  const buf = Buffer.from(await mp4.arrayBuffer());
  ok(mp4.status === 200 && /video\/mp4/.test(mp4.headers.get('content-type') || '') && buf.length > 10_000, `el mp4 se descarga (${(buf.length / 1000).toFixed(0)} KB, ${mp4.headers.get('content-type')})`);
  ok(buf.subarray(4, 8).toString() === 'ftyp', 'es un mp4 real (cabecera ftyp)');
  // el mp4 tiene que ser reproducible en cualquier lado: cuadros constantes y rango de color estandar
  const mp4Path = join(tmpdir(), `karaoke-test-${Date.now()}.mp4`);
  await (await import('node:fs/promises')).writeFile(mp4Path, buf);
  const info = await new Promise((res) => execFile(ffmpegPath, ['-hide_banner', '-i', mp4Path], (_e, _o, err) => res(err)));
  ok(/30 fps/.test(info) && /yuv420p\(tv/.test(info), 'mp4 a 30 fps constantes y rango de color estandar (no 3,75 fps variables ni yuvj)');
  ok(/Audio: aac/.test(info) && /Video: h264/.test(info), 'trae video h264 y audio aac');
  await rm(mp4Path, { force: true });
  const pagListo = await (await fetch(`${BASE}/video/${tokA}`)).text();
  ok(pagListo.includes('Tu video está listo') && pagListo.includes(`/video/${tokA}.mp4`), 'la pagina muestra "Tu video está listo" con VER y DESCARGAR');
  await rm(webm, { force: true });

  // ---------- el video de OTRA performance no se confunde con este
  console.log('\n== E. Otra performance, otro video');
  const rocio = cliente('celu', { token: tk(3), nombre: 'Rocío' });
  await rocio.emitAck('fila:entrar', { nombre: 'Rocío' });
  ok(await aPlaying(pantalla, rocio, 'baby'), 'Rocío canta a continuacion (flujo continuo)');
  pantalla.emit('pantalla:fin', { progreso: 1 });
  await hasta(() => pantalla.estado?.etapa === 'RESULT', 3000, 'RESULT 2');
  await hasta(() => rocio.yo?.videoToken, 2000, 'token de Rocío');
  const tokB = rocio.yo?.videoToken;
  ok(tokB && tokB !== tokA, 'cada performance tiene su propio token');
  const ajeno = await fetch(`${BASE}/video/${tokB}.mp4`);
  ok(ajeno.status === 404, 'el video de A no aparece en el link de B (B todavia no subio nada)');
  est = await (await fetch(`${BASE}/api/video/${tokB}/estado`)).json();
  ok(est.estado === 'esperando', 'B: esperando su propia subida');
  pantalla.emit('pantalla:videoError', { token: tokB });
  await espera(200);
  est = await (await fetch(`${BASE}/api/video/${tokB}/estado`)).json();
  ok(est.estado === 'error', 'si la pantalla no puede subir, el celu ve un error claro (no espera para siempre)');

  // ------------------------------------------------------ F. reinicio del server
  console.log('\n== F. Reinicio del server: los celus vuelven y todo sigue andando');
  await hasta(() => pantalla.estado?.etapa === 'STANDBY', 6000, 'vuelve a STANDBY');
  // un celu "recuerda" lo que estaba haciendo (como el localStorage del navegador)
  const memoria = { token: tk(4), nombre: 'Yazmín', intencion: undefined };
  const yaz = cliente('celu', (cb) => cb({ ...memoria }));
  // para que haya fila: alguien canta mientras Yazmín espera con su cancion elegida
  const cantante = cliente('celu', { token: tk(5), nombre: 'Cantante' });
  await cantante.emitAck('fila:entrar', { nombre: 'Cantante' });
  await hasta(() => pantalla.estado?.etapa === 'CALLING', 3000, 'CALLING');
  await yaz.emitAck('fila:entrar', { nombre: 'Yazmín' });
  await yaz.emitAck('cancion:elegir', { cancionId: 'flores-amarillas', modo: 'duo' });
  await hasta(() => yaz.yo?.estado === 'QUEUED' && yaz.yo?.cancionId === 'flores-amarillas', 2000, 'Yazmín en fila');
  memoria.intencion = { enFila: true, cancionId: yaz.yo.cancionId, modo: yaz.yo.modo };
  const qAntes = (await (await fetch(`${BASE}/api/qr`)).json()).url;

  await parar();
  await espera(500);
  await arrancar();

  ok(await hasta(() => yaz.connected && yaz.yo?.nombre === 'Yazmín', 8000, 'Yazmín reconecta'), 'el celu reconecta solo');
  ok(yaz.yo?.estado === 'CALLED' || yaz.yo?.estado === 'QUEUED', `y sigue en la sala (${yaz.yo?.estado})`);
  ok(yaz.yo?.cancionId === 'flores-amarillas' && yaz.yo?.modo === 'duo', 'con su cancion y su modo elegidos');
  ok(await hasta(() => pantalla.connected && pantalla.estado?.etapa, 8000, 'pantalla reconecta'), 'la pantalla reconecta sola');
  const qDespues = (await (await fetch(`${BASE}/api/qr`)).json()).url;
  ok(qAntes === qDespues, `el QR general NO cambia despues de reiniciar (${qDespues})`);
  // el usuario vuelve a pulsar "Quiero cantar" / "Empezar" apenas reconecta
  const de = await yaz.emitAck('fila:entrar', { nombre: 'Yazmín' });
  ok(de.ok === true, 'despues del reinicio "Quiero cantar" funciona');
  ok(await hasta(() => pantalla.estado?.etapa === 'CALLING' && pantalla.estado?.actual?.nombre === 'Yazmín', 4000, 'llaman a Yazmín'), 'la pantalla la llama');
  const emp = await yaz.emitAck('turno:listo', {});
  ok(emp.ok === true, 'y "Empezar" desde el celu funciona (esto era lo que dejaba de andar)');
  ok(await hasta(() => pantalla.estado?.etapa === 'PLAYING', 5000, 'PLAYING'), 'arranca la cancion');

  // un celu NUEVO (pagina recargada despues del reinicio) tambien anda de entrada
  const nuevo = cliente('celu', { token: tk(6), nombre: 'Nueva' });
  const rn = await nuevo.emitAck('fila:entrar', { nombre: 'Nueva' });
  ok(rn.ok === true, 'un celu que abre la pagina despues del reinicio entra a la fila al toque');
  ok(pantalla.estado?.etapa === 'PLAYING', 'sin interrumpir a quien canta');

  for (const c of [pantalla, rapido, fan, rocio, yaz, cantante, nuevo]) c.close();
} catch (e) {
  console.error('ERROR en la prueba:', e);
  fallos++;
} finally {
  await parar();
}

console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
process.exit(fallos ? 1 : 0);
