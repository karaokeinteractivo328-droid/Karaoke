// Página del celu: anotarse a la fila con tu nombre + mandar reacciones
// mientras otro canta. Nada de gestos ni control de canción acá.

import { conectar } from './socket.js';

const $ = (s) => document.querySelector(s);
const socket = conectar('celu');

const params = new URLSearchParams(location.search);
const codigoUrl = (params.get('codigo') || '').toUpperCase();
if (codigoUrl) $('#inCodigo').value = codigoUrl;

let miId = null;
let salaActual = null;

socket.on('estado', (snap) => {
  salaActual = snap.sala || null;
  pintarEstado();
});

$('#formUnirse').addEventListener('submit', (e) => {
  e.preventDefault();
  const codigo = $('#inCodigo').value.trim().toUpperCase();
  const nombre = $('#inNombre').value.trim();
  if (!codigo || !nombre) return;
  $('#btnUnirse').disabled = true;
  $('#error').hidden = true;
  socket.emit('sala:unirse', { codigo, nombre }, (r) => {
    $('#btnUnirse').disabled = false;
    if (!r?.ok) {
      $('#error').hidden = false;
      $('#error').textContent = r?.error || 'No se pudo unir. Probá de nuevo.';
      return;
    }
    miId = r.id;
    localStorage.setItem('karaoke-mi-id', miId);
    localStorage.setItem('karaoke-mi-nombre', nombre);
    localStorage.setItem('karaoke-sala', codigo);
    $('#formUnirse').hidden = true;
    $('#pantallaEnFila').hidden = false;
    pintarEstado();
  });
});

// reacciones
document.querySelectorAll('#reacciones button').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('sala:reaccion', { emoji: btn.dataset.emoji });
    btn.classList.add('tocado');
    setTimeout(() => btn.classList.remove('tocado'), 260);
  });
});

$('#btnSalir')?.addEventListener('click', () => {
  if (miId) socket.emit('sala:salir', { id: miId });
  localStorage.removeItem('karaoke-mi-id');
  location.reload();
});

function pintarEstado() {
  if (!salaActual || $('#formUnirse').hidden === false) return;

  const soyElLlamado = salaActual.llamado && salaActual.llamado.id === miId;
  const soyElCantante = salaActual.cantando && salaActual.cantando.id === miId;
  const miPos = salaActual.fila.findIndex((p) => p.id === miId);

  let texto;
  if (soyElCantante) texto = '🎤 ¡Es tu turno! Mirá la pantalla y cantá fuerte';
  else if (soyElLlamado) texto = '👉 ¡Te están llamando! Acercate y levantá la mano';
  else if (miPos >= 0) texto = `Estás #${miPos + 1} en la fila`;
  else texto = salaActual.cantando ? `Cantando: ${salaActual.cantando.nombre}` : 'Esperando el próximo turno…';
  $('#estadoFila').textContent = texto;

  $('#reaccionesBox').hidden = !!soyElCantante; // si estás cantando no tenés el celu en la mano
}
