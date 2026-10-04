import { io } from 'socket.io-client';

// El "cerebro" (Socket.IO) es un proceso Node aparte, en el puerto 3000.
// - dev: astro corre en :4321, asi que apuntamos al :3000 del mismo host.
// - build servido por el propio server Node: mismo origen.
// Se puede forzar con PUBLIC_SOCKET_URL en un archivo .env.
const explicita = import.meta.env.PUBLIC_SOCKET_URL;
const URL =
  explicita ||
  (import.meta.env.DEV
    ? `http://${location.hostname}:3000`
    : location.origin);

export function conectar(rol, extra = {}) {
  return io(URL, { query: { rol, ...extra }, transports: ['websocket', 'polling'] });
}

export const SOCKET_URL = URL;

export const ESTADOS = [
  'ESPERANDO',
  'SELECCIONANDO',
  'CONFIRMADA',
  'COUNTDOWN',
  'PLAYING',
  'RESULTADO',
];
