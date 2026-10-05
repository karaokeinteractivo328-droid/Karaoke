// yt-dlp de mentira para las pruebas (sin Internet). Modo por variable FAKE_YTDLP:
//   ok      (default)  busca, baja un m4a real generado con ffmpeg
//   ninguno            la busqueda no devuelve ninguna version que coincida
//   silencio           baja un archivo que es silencio
//   cae                la descarga falla
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const args = process.argv.slice(2);
// el modo se lee de un archivo en cada llamada: asi la prueba lo cambia sin reiniciar el server
const modo = (process.env.FAKE_MODO_ARCHIVO && existsSync(process.env.FAKE_MODO_ARCHIVO) ? readFileSync(process.env.FAKE_MODO_ARCHIVO, 'utf8').trim() : process.env.FAKE_YTDLP) || 'ok';
const j = args.join(' ');
if (args.includes('--version')) { console.log('2099.01.01-fake'); process.exit(0); }
if (j.includes('--dump-json')) {
  const q = args.at(-1);
  const dur = Number(process.env.FAKE_DURACION || 60);
  if (modo === 'ninguno') process.exit(0);
  console.log(JSON.stringify({ id: 'fake123', title: `${q.replace('ytsearch8:', '')}`, duration: dur, channel: 'Artista' }));
  process.exit(0);
}
if (j.includes('youtube.com/watch')) {
  if (modo === 'cae') { console.error('ERROR: HTTP Error 403'); process.exit(1); }
  const salida = args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a');
  const dur = Number(process.env.FAKE_DURACION || 60);
  const fuente = modo === 'silencio' ? 'anullsrc=r=44100:cl=stereo' : 'sine=frequency=330:sample_rate=44100';
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', fuente, '-t', String(dur), '-c:a', 'aac', salida], { stdio: 'ignore' });
  process.exit(0);
}
process.exit(0);
