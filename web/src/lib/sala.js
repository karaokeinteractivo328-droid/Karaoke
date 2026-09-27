// Página del celu: anotarse a la fila con tu nombre + mandar reacciones
// mientras otro canta. Nada de gestos ni control de canción acá.

import { conectar, SOCKET_URL } from './socket.js';

const $ = (s) => document.querySelector(s);
const socket = conectar('celu');

const params = new URLSearchParams(location.search);
const codigoUrl = (params.get('codigo') || '').toUpperCase();
if (codigoUrl) $('#inCodigo').value = codigoUrl;

let miId = null;
let salaActual = null;
let catalogo = [];
let catalogoPedido = false;

socket.on('estado', (snap) => {
  salaActual = snap.sala || null;
  pintarEstado();
});

// Link de copiloto (viene del QR que aparece junto al cantante): salta el
// formulario de siempre y reclama el puesto directo con la clave de la URL.
const rolUrl = params.get('rol');
const claveUrl = params.get('clave');
if (rolUrl === 'copiloto' && codigoUrl && claveUrl) {
  $('#formUnirse').hidden = true;
  $('#pantallaEnFila').hidden = true;
  $('#pantallaCopiloto').hidden = false;
  socket.emit('sala:copiloto', { codigo: codigoUrl, clave: claveUrl }, (r) => {
    if (!r?.ok) {
      $('#copilotoError').hidden = false;
      $('#copilotoError').textContent = r?.error || 'No se pudo conectar como copiloto.';
    }
  });
}

socket.on('letra-actual', ({ actual, siguiente } = {}) => {
  if ($('#pantallaCopiloto').hidden) return;
  $('#copilotoActual').textContent = actual || 'Esperando que arranque la canción…';
  $('#copilotoSiguiente').textContent = siguiente || '';
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
    socket.emit('sala:reaccion', { emoji: btn.dataset.emoji, id: miId });
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
  else if (soyElLlamado) texto = '👉 ¡Te están llamando! Elegí tu canción y levantá la mano';
  else if (miPos >= 0) texto = `Estás #${miPos + 1} en la fila`;
  else texto = salaActual.cantando ? `Cantando: ${salaActual.cantando.nombre}` : 'Esperando el próximo turno…';
  $('#estadoFila').textContent = texto;

  // mientras te toca elegir o ya estas cantando, no tiene sentido reaccionar
  $('#reaccionesBox').hidden = !!(soyElCantante || soyElLlamado);
  $('#cancionesBox').hidden = !soyElLlamado;
  if (soyElLlamado) {
    if (!catalogoPedido) pedirCatalogo();
    else pintarCanciones(salaActual.llamado.preseleccion);
  }
}

function pedirCatalogo() {
  catalogoPedido = true;
  fetch(`${SOCKET_URL}/api/canciones`)
    .then((r) => r.json())
    .then((d) => {
      catalogo = d;
      pintarCanciones(salaActual?.llamado?.preseleccion);
    })
    .catch(() => { catalogoPedido = false; });
}

function pintarCanciones(indiceElegido) {
  const ul = $('#cancionesLista');
  if (!ul) return;
  ul.innerHTML = '';
  catalogo.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `${c.titulo}<span class="art">${c.artista}</span>`;
    li.classList.toggle('elegida', i === indiceElegido);
    li.addEventListener('click', () => {
      socket.emit('sala:preseleccionar', { id: miId, indice: i });
      [...ul.children].forEach((el, k) => el.classList.toggle('elegida', k === i));
    });
    ul.appendChild(li);
  });
}
