import { conectar } from './socket.js';
import { parsearLRC, indiceActual } from './lrc.js';
import { crearReconocimiento } from './vision.js';
import { crearGestos } from './manos.js';
import { crearVoz } from './voz.js';
import { crearAudioBus } from './audioBus.js';
import { crearEscenario } from './escenario.js';
import { crearCamara } from './camaraCanvas.js';
import { crearGrabacion } from './grabacion.js';
import { crearGrabacionCanvas } from './grabacionCanvas.js';
import { repartirDuo } from './duo.js';
import { crearRetos } from './retos.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const video = $('#selfCam');
const audio = $('#pista');
const socket = conectar('pantalla');
const SOCKET_URL =
  import.meta.env.PUBLIC_SOCKET_URL ||
  (import.meta.env.DEV ? `http://${location.hostname}:3000` : location.origin);

let estadoActual = 'ESPERANDO';
let estadoPrevio = null;
let modoActual = 'solo';
let catalogo = [];
let catalogoFull = [];
let datosManos = null;
let salaActual = null;

// QR + código para sumarse a la sala desde el celu (se pide una sola vez).
fetch('/api/qr-sala')
  .then((r) => r.json())
  .then(({ dataUrl, codigo }) => {
    if (dataUrl) $('#qrSala').src = dataUrl;
    if (codigo) $('#salaCodigo').textContent = codigo;
  })
  .catch(() => {});

fetch('/api/canciones')
  .then((r) => r.json())
  .then((d) => (catalogoFull = d))
  .catch(() => {});

// --- Fondo + audio + manos ------------------------------------------
const escenario = crearEscenario($('#estrella-wrap'));
const audioBus = crearAudioBus(audio);
const camara = crearCamara($('#camara'), video);
const grabacion = crearGrabacion();
let camStream = null;

// canvas 1280x720 que se GRABA: camara + letra + marca de agua
let letraRec = { texto: '', hechas: 0, titulo: '' };
const recCanvas = crearGrabacionCanvas(video, { getLetra: () => letraRec });

const retos = crearRetos({
  onCartel: pintarReto,
  onResultado: ({ ok, puntos }) => {
    if (ok) flash('¡BIEN! +' + puntos);
  },
});

// Arranca directo, sin pantalla de "tocá para empezar". Intentamos
// desbloquear el audio apenas carga (funciona solo si el navegador corre con
// --autoplay-policy=no-user-gesture-required, ver README "Modo kiosco").
// Igual dejamos el intento silencioso: si en algún momento hay un click/tecla
// real, sirve como red de seguridad.
audioBus.desbloquear();

function frame() {
  escenario.latir(audioBus.tick());
  camara.dibujar(datosManos, estadoActual);
  if (grabacion.grabando) recCanvas.dibujar();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- MediaPipe + gestos + voz -----------------------------------
const HUD_ESTADOS = ['ESPERANDO', 'MODO', 'SELECCIONANDO'];
const gestos = crearGestos({
  getEstado: () => estadoActual,
  onGesto: enviarAccion,
  onManos: (d) => {
    datosManos = d;
    escenario.setModo(
      d?.corazon ? 'corazon' : d?.cantidadManos >= 2 ? 'dos' : d?.cantidadManos === 1 ? 'una' : ''
    );
    if (d?.corazon) flashCorazon();
    if (estadoActual === 'MODO') pintarModo(d);

    // HUD: qué está viendo la cámara
    const hud = $('#gestoHUD');
    if (HUD_ESTADOS.includes(estadoActual)) {
      hud.hidden = false;
      $('#gestoTxt').textContent = d?.gesto || 'mostrá la mano';
    } else {
      hud.hidden = true;
    }
  },
});

const MS_SIN_PERSONA = 10_000;
let ultimaPersona = performance.now();
let ultimoResultado = 0;
const ESTADOS_TIMEOUT = ['MODO', 'SELECCIONANDO', 'CONFIRMADA', 'COUNTDOWN', 'PLAYING'];

navigator.mediaDevices
  .getUserMedia({ video: { width: 1280, height: 720 }, audio: true })
  .then((stream) => {
    camStream = stream;
    video.srcObject = stream;
    audioBus.agregarMic(stream); // la voz entra a la grabación
    audioBus.desbloquear(); // otro intento: a veces el permiso de camara ya cuenta como interaccion
    return crearReconocimiento({
      video,
      numManos: 2,
      onResultado: ({ manos, hayPersona }) => {
        ultimoResultado = performance.now();
        gestos({ manos });
        if (hayPersona) ultimaPersona = performance.now();
      },
    });
  })
  .catch((err) => {
    console.warn('camara / MediaPipe:', err.message);
    aviso('Cámara no disponible (' + err.name + ')');
  });

setInterval(() => {
  if (!ESTADOS_TIMEOUT.includes(estadoActual)) return;
  const ahora = performance.now();
  if (ahora - ultimoResultado > 3000) return;
  if (ahora - ultimaPersona > MS_SIN_PERSONA) {
    ultimaPersona = ahora;
    console.log('[idle] 10s sin persona -> reset');
    enviarAccion({ tipo: 'reset' });
  }
}, 1000);

crearVoz({
  getEstado: () => estadoActual,
  getCatalogo: () => (catalogoFull.length ? catalogoFull : catalogo),
  onGesto: enviarAccion,
  onEstadoVoz: (txt) => ($('#vozStatus').textContent = txt),
});

function enviarAccion({ tipo, direccion, indice, valor }) {
  console.log('[accion] ->', tipo, direccion ?? valor ?? '');
  socket.emit('accion', { evento: tipo, direccion, indice, valor });
}
socket.on('accion-rechazada', (d) => console.warn('[accion RECHAZADA]', d));
socket.on('connect', () => console.log('[socket] conectado a', SOCKET_URL));
socket.on('connect_error', (e) => console.warn('[socket] error:', e.message));

// --- Estado global ---------------------------------------------
socket.on('estado', (snap) => {
  const cambio = snap.nombre !== estadoPrevio;
  estadoActual = snap.nombre;
  modoActual = snap.modo || 'solo';
  body.dataset.estado = snap.nombre;
  body.dataset.modo = modoActual;

  if (snap.canciones?.length && snap.canciones.length !== catalogo.length) {
    catalogo = snap.canciones;
    renderCatalogo();
  }

  if (snap.sala) {
    salaActual = snap.sala;
    pintarSala();
  }

  switch (snap.nombre) {
    case 'MODO':
      $('#modoSel')?.setAttribute('data-elegido', modoActual);
      break;
    case 'SELECCIONANDO':
      marcarActiva(snap.indiceCancion);
      break;
    case 'CONFIRMADA':
      $('#confTitulo').textContent = snap.cancion
        ? `${snap.cancion.titulo} · ${snap.cancion.artista}`
        : '';
      break;
    case 'COUNTDOWN':
      $('#cuenta').textContent = snap.countdown ?? 3;
      break;
    case 'PLAYING':
      if (cambio) arrancarCancion(snap.cancion);
      break;
    case 'RESULTADO':
      if (cambio) mostrarResultado(snap);
      break;
    case 'ESPERANDO':
      if (cambio) detenerCancion();
      break;
  }
  pintarCantando(); // se recalcula siempre: depende del estado + de la sala
  estadoPrevio = snap.nombre;
});

socket.on('feedback', ({ texto }) => flash(texto));

// --- Sala: fila de espera con turnos automáticos ------------------
function pintarSala() {
  if (!salaActual) return;
  const { fila, llamado, cantando } = salaActual;

  // ESPERANDO: si hay alguien llamado, mostramos "¡te toca!" en vez del
  // cartel genérico; si no, queda como estaba (cualquiera puede empezar).
  const hayLlamado = !!llamado;
  $('#turnoLlamado').hidden = !hayLlamado;
  $('#esperandoLibre').hidden = hayLlamado;
  if (hayLlamado) $('#turnoNombre').textContent = llamado.nombre;

  // fila visible (los que siguen después del llamado)
  const ul = $('#filaLista');
  ul.innerHTML = '';
  fila.slice(0, 6).forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${p.nombre}`;
    ul.appendChild(li);
  });

  pintarCantando();
}

// "🎤 Nombre" arriba de la pantalla mientras esa persona tiene el escenario.
function pintarCantando() {
  const el = $('#cantandoAhora');
  const nombre = salaActual?.cantando?.nombre;
  const mostrar = nombre && ['CONFIRMADA', 'COUNTDOWN', 'PLAYING'].includes(estadoActual);
  el.hidden = !mostrar;
  if (mostrar) el.querySelector('span').textContent = nombre;
}

// reacciones del celu -> emojis que flotan por la pantalla
socket.on('reaccion', ({ emoji }) => volarReaccion(emoji));
function volarReaccion(emoji) {
  const cont = $('#reacciones-vuelan');
  const span = document.createElement('span');
  span.textContent = emoji;
  const x = 8 + Math.random() * 84; // % del ancho
  const dur = 2.6 + Math.random() * 1.4;
  span.style.left = x + 'vw';
  span.style.setProperty('--dur', dur + 's');
  span.style.setProperty('--drift', (Math.random() * 2 - 1).toFixed(2));
  cont.appendChild(span);
  setTimeout(() => span.remove(), dur * 1000 + 200);
}

// --- MODO: elegir solo / dúo ------------------------------------
function pintarModo(d) {
  const el = $('#modoSel');
  if (!el) return;
  el.dataset.hover = d?.modoElegido || '';
  el.style.setProperty('--prog', (d?.modoProgreso || 0).toFixed(2));
}

// --- Catálogo -------------------------------------------------
function renderCatalogo() {
  const ul = $('#lista');
  ul.innerHTML = '';
  catalogo.forEach((c) => {
    const li = document.createElement('li');
    const duo = c.voces === 'duo' ? ' <b class="tag-duo">dúo</b>' : '';
    li.innerHTML = `${c.titulo} <span class="art">${c.artista}</span>${duo}`;
    ul.appendChild(li);
  });
}
function marcarActiva(i) {
  const ul = $('#lista');
  [...ul.children].forEach((li, k) => li.classList.toggle('activa', k === i));
  ul.children[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// --- PLAYING: audio + letra + retos --------------------------
let letras = [];
let voces = []; // 'p1'|'p2'|'both' por línea (modo dúo)
let idxLetra = -1;
let loopId = null;
let t0 = 0;
let fallback = true;
let finTimer = null;
let offsetLetra = 0;
let duracionCancion = 40;
let sesionActual = '';
let mandoFin = false;
const barra = $('#progreso');
const barraFill = barra.querySelector('span');

async function arrancarCancion(cancion) {
  const meta =
    catalogoFull.find((c) => c.id === cancion?.id) ||
    catalogo.find((c) => c.id === cancion?.id) ||
    cancion;
  letras = [];
  voces = [];
  idxLetra = -1;
  fallback = true;
  mandoFin = false;
  t0 = performance.now();
  offsetLetra = Number(meta?.offsetLetra) || 0;
  duracionCancion = Number(meta?.duracion) || 40;
  clearTimeout(finTimer);
  mostrarLinea(-1, true);
  barra.hidden = false;
  barraFill.style.width = '0%';
  retos.reset(performance.now());
  letraRec = { texto: '', hechas: 0, titulo: meta?.titulo || '' };
  // graba el canvas compuesto (camara + letra) + audio (cancion + voz)
  grabacion.iniciar(recCanvas.stream(30), audioBus.streamGrabacion());

  if (meta?.lrc) {
    try {
      letras = parsearLRC(await fetch(meta.lrc).then((r) => r.text()));
      if (modoActual === 'duo') voces = repartirDuo(letras);
    } catch (e) {
      console.warn('letra:', e.message);
    }
  }

  const dur = duracionCancion;
  if (meta?.audio) {
    audio.src = meta.audio;
    audio.currentTime = 0;
    audio.load();
    audio.play().catch(() => {});
    audio.addEventListener('playing', () => {
      fallback = false;
      clearTimeout(finTimer);
      finTimer = setTimeout(finDeCancion, (audio.duration || dur) * 1000 + 4000);
    }, { once: true });
    audio.addEventListener('ended', finDeCancion, { once: true });
    audio.addEventListener('error', () => { fallback = true; }, { once: true });
  }
  finTimer = setTimeout(() => { if (fallback) finDeCancion(); }, dur * 1000);

  clearInterval(loopId);
  loopId = setInterval(tickLetra, 60);
}

function relojBase() {
  return !fallback && !audio.paused ? audio.currentTime : (performance.now() - t0) / 1000;
}

function tickLetra() {
  const base = relojBase();
  const t = base - offsetLetra;
  barraFill.style.width =
    Math.max(0, Math.min(100, (base / duracionCancion) * 100)).toFixed(1) + '%';

  const nuevo = indiceActual(letras, t);
  if (nuevo !== idxLetra) {
    idxLetra = nuevo;
    mostrarLinea(nuevo);
  }
  pintarPalabras(t);
  retos.tick(performance.now(), datosManos);
}

function finDeCancion() {
  if (mandoFin) return;
  mandoFin = true;
  // puntaje = base por completar + bonus de retos
  const avance = Math.min(1, relojBase() / duracionCancion);
  const base = Math.round(45 + avance * 30);
  const valor = Math.min(100, base + retos.puntaje);
  socket.emit('puntaje', { valor });
}

// Ajuste fino de sincronía en vivo: [ y ]
addEventListener('keydown', (e) => {
  if (estadoActual !== 'PLAYING') return;
  if (e.key === '[') offsetLetra -= 0.2;
  else if (e.key === ']') offsetLetra += 0.2;
  else return;
  idxLetra = -2;
  $('#vozStatus').textContent = `offset ${offsetLetra.toFixed(1)}s`;
  console.log('[letra] offsetLetra =', offsetLetra.toFixed(2));
});

const elActual = $('#lineaActual');
const elSig = $('#lineaSiguiente');
let palabras = [];
let lineaRender = -99;

function mostrarLinea(idx, forzar = false) {
  let i = idx;
  while (letras[i] && !letras[i].texto) i++;
  if (!forzar && i === lineaRender && idx >= 0) return;
  lineaRender = i;

  elActual.innerHTML = '';
  palabras = [];
  const cur = letras[i];
  const sig = [letras[i + 1], letras[i + 2]].find((l) => l?.texto)?.texto || '';
  elSig.textContent = sig;

  // color por voz (modo dúo)
  const voz = voces[i] || 'p1';
  elActual.dataset.voz = modoActual === 'duo' ? voz : '';
  elSig.dataset.voz = modoActual === 'duo' ? (voces[i + 1] || voz) : '';

  if (!cur || !cur.texto) {
    elActual.hidden = true;
    letraRec = { ...letraRec, texto: '', hechas: 0 };
    return;
  }
  elActual.hidden = false;
  letraRec = { ...letraRec, texto: cur.texto, hechas: 0 };

  const trozos = cur.texto.split(/\s+/).filter(Boolean);
  const fin = letras[i + 1] ? letras[i + 1].tiempo : cur.tiempo + 4;
  const dur = Math.max(0.6, fin - cur.tiempo);
  const totalCh = trozos.reduce((s, w) => s + w.length, 0) || 1;
  let acc = 0;
  for (const w of trozos) {
    const span = document.createElement('span');
    span.textContent = w + ' ';
    elActual.appendChild(span);
    palabras.push({ span, t0: cur.tiempo + (acc / totalCh) * dur });
    acc += w.length;
  }
  elActual.classList.remove('entrando');
  void elActual.offsetWidth;
  elActual.classList.add('entrando');
  ajustarLetra();
}

function pintarPalabras(t) {
  if (!palabras.length) return;
  let actual = -1;
  for (let i = 0; i < palabras.length; i++) if (palabras[i].t0 <= t) actual = i;
  for (let i = 0; i < palabras.length; i++) {
    const c = palabras[i].span.classList;
    c.toggle('dicha', i < actual);
    c.toggle('actual', i === actual);
  }
  if (letraRec.hechas !== actual + 1) letraRec = { ...letraRec, hechas: actual + 1 };
}

function ajustarLetra() {
  if (!elActual.textContent) return;
  const maxH = innerHeight * 0.4;
  const maxW = $('#letra').clientWidth;
  let size = Math.min(innerWidth * 0.09, innerHeight * 0.13);
  elActual.style.fontSize = size + 'px';
  let guard = 40;
  while (guard-- > 0 && (elActual.scrollHeight > maxH || elActual.scrollWidth > maxW) && size > 16) {
    size *= 0.93;
    elActual.style.fontSize = size + 'px';
  }
}
addEventListener('resize', ajustarLetra);

function detenerCancion() {
  clearInterval(loopId);
  loopId = null;
  clearTimeout(finTimer);
  mostrarLinea(-1, true);
  barra.hidden = true;
  pintarReto(null);
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {}
}

// --- Retos: cartel ------------------------------------------
function pintarReto(reto) {
  const el = $('#reto');
  if (!el) return;
  if (!reto) { el.hidden = true; return; }
  el.hidden = false;
  $('#retoIcono').textContent = reto.icono;
  $('#retoTexto').textContent = reto.texto;
  el.style.setProperty('--resto', (reto.resto ?? 1).toFixed(2));
}

// --- RESULTADO ---------------------------------------------
function mostrarResultado(snap) {
  detenerCancion();
  sesionActual = snap.sesionId || '';
  const el = $('#score');
  let v = 0;
  const meta = snap.puntaje ?? 0;
  clearInterval(el._t);
  el._t = setInterval(() => {
    v = Math.min(meta, v + Math.max(1, Math.round(meta / 40)));
    el.textContent = v;
    if (v >= meta) clearInterval(el._t);
  }, 25);

  fetch('/api/qr-resultado?sesion=' + encodeURIComponent(sesionActual))
    .then((r) => r.json())
    .then(({ dataUrl }) => { if (dataUrl) $('#qrResultado').src = dataUrl; })
    .catch(() => {});

  // cerrar la grabación y subirla: el server la pasa a .mp4 con ffmpeg
  const bajar = $('#bajarVideo');
  bajar.hidden = true;
  bajar.textContent = '⏳ preparando tu video…';
  grabacion.detener().then(async (blob) => {
    if (!blob || !blob.size || !sesionActual) return;
    bajar.hidden = false;
    try {
      await fetch(`${SOCKET_URL}/api/video/${sesionActual}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/webm' },
        body: blob,
      });
    } catch (e) {
      console.warn('subida de video:', e.message);
    }
    // esperar a que el mp4 esté listo (el server convierte en segundo plano)
    const mp4 = `${SOCKET_URL}/video/${sesionActual}.mp4`;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await fetch(mp4);
        if (r.ok) {
          bajar.href = URL.createObjectURL(await r.blob());
          bajar.download = `karaoke-${sesionActual}.mp4`;
          bajar.textContent = '↓ descargar mi video (mp4)';
          return;
        }
      } catch {}
    }
    bajar.href = URL.createObjectURL(blob);
    bajar.download = `karaoke-${sesionActual}.webm`;
    bajar.textContent = '↓ descargar mi video';
  });
}

// --- helpers UI ------------------------------------------
let ultimoCorazon = 0;
function flashCorazon() {
  if (performance.now() - ultimoCorazon < 2500) return;
  ultimoCorazon = performance.now();
  flash('♥');
}
function flash(texto) {
  const el = $('#feedbackFlash');
  el.textContent = texto;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1100);
}
function aviso(txt) {
  const a = document.createElement('div');
  a.className = 'aviso';
  a.textContent = txt;
  body.appendChild(a);
}
