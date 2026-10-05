// Diagnostico del audio: cada paso deja una linea en la consola con una etiqueta fija
// ([SONG] / [AUDIO] / [AUDIO ERROR]) y queda en un buffer para poder verlo despues
// (window.__karaoke.diagnostico()). Los errores NUNCA se esconden: van a console.error.

const buffer = [];

export function logAudio(msg, extra) {
  registrar('AUDIO', msg, extra);
}
export function logCancion(msg, extra) {
  registrar('SONG', msg, extra);
}
export function errorAudio(msg, extra) {
  registrar('AUDIO ERROR', msg, extra);
}

function registrar(tag, msg, extra) {
  const linea = `[${tag}] ${msg}`;
  buffer.push({ t: Date.now(), tag, msg, extra });
  if (buffer.length > 300) buffer.shift();
  const fn = tag === 'AUDIO ERROR' ? console.error : console.log;
  if (extra !== undefined) fn(linea, extra);
  else fn(linea);
}

export const diagnostico = () => buffer.slice();
