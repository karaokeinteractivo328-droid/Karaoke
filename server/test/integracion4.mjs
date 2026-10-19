// Videos que NUNCA terminaban de "procesarse": lo que queda a medias antes de un reinicio del server
// (grabacion subida pero conversion sin terminar) se retoma solo al arrancar, y los estados reales
// (procesando con progreso, listo, error) se informan bien.
//
//   node server/test/integracion4.mjs
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import ffmpegPath from 'ffmpeg-static';

const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const dir = dirname(fileURLToPath(import.meta.url));
const GRAB = join(dir, '..', 'grabaciones');
await mkdir(GRAB, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (c, m) => { console.log(`${c ? '  OK  ' : ' FALLO'} ${m}`); if (!c) fallos++; };
const tok = () => randomBytes(16).toString('hex');
const existe = (f) => access(f).then(() => true, () => false);

function ffmpeg(args) {
  return new Promise((resolve, reject) => execFile(ffmpegPath, ['-y', '-v', 'error', ...args], { timeout: 60_000 }, (e, _o, se) => (e ? reject(new Error(se)) : resolve())));
}
const T_MP4 = tok(); // grabacion MP4 de Chrome que quedo sin empaquetar
const T_WEBM = tok(); // grabacion webm (navegador viejo) que quedo sin recodificar
const T_ROTO = tok(); // un archivo que no es un video
const T_TMP = tok(); // conversion que se corto a mitad: un .tmp.mp4 huerfano
const tmpMp4 = join(tmpdir(), `i4-${Date.now()}.mp4`);
const tmpWebm = join(tmpdir(), `i4-${Date.now()}.webm`);
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', tmpMp4]);
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-shortest', tmpWebm]);
await writeFile(join(GRAB, `${T_MP4}.rec.mp4`), await readFile(tmpMp4));
await writeFile(join(GRAB, `${T_WEBM}.webm`), await readFile(tmpWebm));
await writeFile(join(GRAB, `${T_ROTO}.rec.mp4`), Buffer.from('esto no es un video, es basura'.repeat(2000)));
await writeFile(join(GRAB, `${T_TMP}.tmp.mp4`), Buffer.from('a medio escribir'));

let server = null;
const limpiar = async () => { for (const t of [T_MP4, T_WEBM, T_ROTO, T_TMP]) for (const f of ['rec.mp4', 'webm', 'mp4', 'tmp.mp4']) await rm(join(GRAB, `${t}.${f}`), { force: true }); await rm(tmpMp4, { force: true }); await rm(tmpWebm, { force: true }); };
const estado = async (t) => (await fetch(`${BASE}/api/video/${t}/estado`)).json();
async function hasta(fn, ms = 60_000) { const f = Date.now() + ms; while (Date.now() < f) { const v = await fn(); if (v) return v; await dormir(150); } return null; }

try {
  console.log('\n== Un server que arranca con grabaciones a medias las retoma solo (antes quedaban en "procesando" para siempre)');
  const t0 = Date.now();
  server = spawn(process.execPath, [join(dir, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', YOUTUBE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {} await dormir(150); }

  ok(!(await existe(join(GRAB, `${T_TMP}.tmp.mp4`))), 'el .tmp.mp4 huerfano (conversion cortada) se limpia al arrancar');
  ok(/retomando la conversion/.test(log), 'el server avisa que retoma las conversiones');

  const fin = {};
  await hasta(async () => {
    for (const t of [T_MP4, T_WEBM, T_ROTO]) if (!fin[t]) { const e = await estado(t); if (['listo', 'error'].includes(e.estado)) fin[t] = e; }
    return Object.keys(fin).length === 3;
  });
  ok(fin[T_MP4]?.estado === 'listo', `la grabacion MP4 quedo LISTA tras el reinicio (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  ok(fin[T_WEBM]?.estado === 'listo', 'la grabacion webm tambien (se recodifica)');
  ok(fin[T_ROTO]?.estado === 'error' && !!fin[T_ROTO].crudo, 'un archivo roto da un ERROR claro (no queda "procesando" para siempre) y ofrece abrir lo que haya');

  for (const t of [T_MP4, T_WEBM]) {
    const r = await fetch(`${BASE}/video/${t}.mp4`);
    const b = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && b.subarray(4, 8).toString() === 'ftyp', `el mp4 de ${t.slice(0, 6)} se descarga y es valido (${(b.length / 1000).toFixed(0)} KB)`);
  }
  ok(!(await existe(join(GRAB, `${T_MP4}.rec.mp4`))) && !(await existe(join(GRAB, `${T_WEBM}.webm`))), 'las grabaciones crudas se borran al terminar');
  const pag = await (await fetch(`${BASE}/video/${T_MP4}`)).text();
  ok(pag.includes('Tu video está listo'), 'la pagina del link muestra "Tu video está listo"');
  const pagRoto = await (await fetch(`${BASE}/video/${T_ROTO}`)).text();
  ok(/Tu video|No pudimos/.test(pagRoto), 'y la del archivo roto explica que paso');
  console.log('\n== Un archivo crudo SUELTO (sin conversion en curso) tambien se retoma cuando alguien consulta el estado');
  const T_SUELTO = tok();
  await writeFile(join(GRAB, `${T_SUELTO}.rec.mp4`), await readFile(tmpMp4));
  const e0 = await estado(T_SUELTO);
  ok(e0.estado === 'procesando' || e0.estado === 'listo', `consultar el estado dispara la conversion (${e0.estado})`);
  const e1 = await hasta(async () => { const e = await estado(T_SUELTO); return e.estado === 'listo' ? e : null; }, 30_000);
  ok(!!e1, 'y termina');
  await rm(join(GRAB, `${T_SUELTO}.mp4`), { force: true });
} catch (e) {
  console.error('ERROR en la prueba:', e);
  fallos++;
} finally {
  if (server) { const s = new Promise((r) => server.once('exit', r)); server.kill(); await s; }
  await limpiar();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
process.exit(fallos ? 1 : 0);
