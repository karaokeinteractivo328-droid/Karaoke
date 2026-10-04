// La pantalla grande: un ESCENARIO. Muestra siempre lo mismo, sea quien sea el
// que cante, y se maneja desde los celulares. La camara solo alimenta los
// retos de gestos (y, opcionalmente, ve que alguien llego al escenario).
//
// El estado manda el servidor (server/escenario.js):
//   STANDBY -> CALLING -> COUNTDOWN -> PLAYING -> RESULT -> (CALLING | STANDBY)
// Esta pagina reproduce la cancion y la letra, graba el video y le avisa al
// server cuando termino y como le fue con los retos.

import { conectar, SOCKET_URL } from './socket.js';
import { parsearLRC, indiceActual } from './lrc.js';
import { crearReconocimiento } from './vision.js';
import { crearGestos } from './manos.js';
import { crearAudioBus } from './audioBus.js';
import { crearEscenario as crearFondo } from './escenario.js';
import { crearCamara } from './camaraCanvas.js';
import { crearGrabacion } from './grabacion.js';
import { crearGrabacionCanvas } from './grabacionCanvas.js';
import { repartirDuo } from './duo.js';
import { crearRetos } from './retos.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const video = $('#selfCam');
const audio = $('#pista');
// el audio puede venir de otro origen (Supabase Storage) y se conecta al Web
// Audio API (analizador + grabacion): sin esto el navegador lo trata como
// opaco y silencia la salida, aunque el archivo tenga CORS habilitado.
audio.crossOrigin = 'anonymous';

// id de esta carga de pagina: si el socket se corta y vuelve, el server sabe
// que es la misma pantalla (no interrumpe la cancion); si se recarga, es otra.
const PID = crypto.randomUUID?.() || String(Math.random()).slice(2);
const socket = conectar('pantalla', { pid: PID });

const EMOJI = { corazon: '❤️', fuego: '🔥', aplauso: '👏' };

let snap = null;
let etapaActual = 'STANDBY';
let etapaPrevia = null;
let modoActual = 'solo';
let offsetServidor = 0; // serverNow - Date.now(): para las barras de tiempo
let espejo = false; // otra pantalla tomo el control: esta solo muestra
let catalogoFull = [];
let datosManos = null;
let totales = { corazon: 0, fuego: 0, aplauso: 0 };
const ahoraServidor = () => Date.now() + offsetServidor;

// --- Datos de apoyo (siempre contra el backend, no contra el origen del front) ---
async function cargarCatalogo() {
  try {
    catalogoFull = await fetch(`${SOCKET_URL}/api/canciones`).then((r) => r.json());
  } catch {}
  return catalogoFull;
}
cargarCatalogo();

// EL QR de la instalacion: siempre el mismo (apunta a /sala).
function cargarQr() {
  fetch(`${SOCKET_URL}/api/qr`)
    .then((r) => r.json())
    .then(({ dataUrl, url }) => {
      if (dataUrl) $('#qrSala').src = dataUrl;
      if (url) $('#qrUrl').textContent = url.replace(/^https?:\/\//, '');
    })
    .catch(() => setTimeout(cargarQr, 3000));
}
cargarQr();

// --- Fondo + audio + camara ------------------------------------------
const fondo = crearFondo($('#estrella-wrap'));
const audioBus = crearAudioBus(audio);
const camara = crearCamara($('#camara'), video);
const grabacion = crearGrabacion();

// canvas 1280x720 que se GRABA: camara + letra + marca de agua
let letraRec = { texto: '', hechas: 0, titulo: '' };
const recCanvas = crearGrabacionCanvas(video, { getLetra: () => letraRec });

const retos = crearRetos({
  onCartel: (reto) => {
    pintarReto(reto);
    if (reto?.tipo === 'palabra') taparPalabraProxima();
    if (!reto) destaparPalabra();
  },
  onResultado: ({ ok, puntos }) => {
    if (ok) {
      flash('¡BIEN! +' + puntos);
      if (!espejo) socket.emit('pantalla:retos', { puntos: retos.puntaje });
    }
    destaparPalabra();
  },
});

// Arranca directo. Intentamos desbloquear el audio apenas carga (funciona solo
// si el navegador corre con --autoplay-policy=no-user-gesture-required, ver
// README "Modo kiosco"); si no, aparece un chip discreto y un clic lo destraba.
audioBus.desbloquear();

function frame() {
  fondo.latir(audioBus.tick());
  camara.dibujar(datosManos);
  if (grabacion.grabando) recCanvas.dibujar();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Camara, microfono y deteccion (todo opcional: el show sigue sin ellos) ---
let camaraOk = null; // null = todavia pidiendo permiso
let micOk = null;
let deteccionOk = false; // MediaPipe cargo y esta dando resultados
let ultimaPresenciaEmit = 0;

const gestos = crearGestos({
  onManos: (d) => {
    datosManos = d;
    fondo.setModo(
      d?.corazon ? 'corazon' : d?.cantidadManos >= 2 ? 'dos' : d?.cantidadManos === 1 ? 'una' : ''
    );
    if (d?.corazon) flashCorazon();
  },
});

async function pedirMedios() {
  const gum = (c) => navigator.mediaDevices.getUserMedia(c);
  const v = { width: 1280, height: 720 };
  try {
    return await gum({ video: v, audio: true });
  } catch (e) {
    // si falla uno de los dos, seguimos con el que si tengamos
    try { return await gum({ video: v }); } catch {}
    try { return await gum({ audio: true }); } catch {}
    throw e;
  }
}

pedirMedios()
  .then((stream) => {
    camaraOk = stream.getVideoTracks().length > 0;
    micOk = stream.getAudioTracks().length > 0;
    if (micOk) audioBus.agregarMic(stream); // la voz entra a la grabacion
    audioBus.desbloquear(); // a veces el permiso ya cuenta como interaccion
    if (!camaraOk) return null;
    video.srcObject = stream;
    return crearReconocimiento({
      video,
      numManos: 4, // cantante + copiloto, hasta 2 manos cada uno
      onResultado: ({ manos, hayPersona }) => {
        deteccionOk = true;
        gestos({ manos });
        const t = performance.now();
        if (!espejo && t - ultimaPresenciaEmit > 1000) {
          ultimaPresenciaEmit = t;
          socket.emit('pantalla:presencia', { hay: !!hayPersona });
        }
      },
    });
  })
  .catch((err) => {
    console.warn('camara / microfono:', err.message);
    if (camaraOk == null) camaraOk = false;
    if (micOk == null) micOk = false;
  });

// Salud de la instalacion: se informa al server y se muestran chips solo si
// algo falla (el escenario no se llena de avisos mientras todo anda).
let saludPrevia = '';
function salud() {
  const audioOk = audioBus.contexto ? audioBus.contexto.state === 'running' : false;
  const s = { camara: camaraOk !== false, mic: micOk !== false, audio: audioOk };
  $('#chipCamara').hidden = s.camara;
  $('#chipMic').hidden = s.mic;
  $('#chipAudio').hidden = s.audio;
  const k = JSON.stringify(s);
  if (k !== saludPrevia && socket.connected && !espejo) {
    saludPrevia = k;
    socket.emit('pantalla:salud', s);
  }
}
setInterval(salud, 2000);
$('#chipAudio').addEventListener('click', () => {
  audioBus.desbloquear();
  salud();
});

// Atajo de emergencia (operador): cierra lo que haya y vuelve a un estado seguro.
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    socket.emit('pantalla:reiniciar');
    flash('REINICIO');
  }
});

// --- Conexion ----------------------------------------------------------
socket.on('connect', () => {
  console.log('[socket] conectado a', SOCKET_URL);
  $('#chipSinServer').hidden = true;
  saludPrevia = '';
  salud();
});
socket.on('disconnect', () => ($('#chipSinServer').hidden = false));
socket.on('connect_error', (e) => {
  console.warn('[socket] error:', e.message);
  $('#chipSinServer').hidden = false;
});
socket.on('pantalla:espejo', () => {
  espejo = true;
  $('#chipEspejo').hidden = false;
  detenerCancion();
});

// --- Estado global (lo manda el server) -----------------------------------
socket.on('estado', (s) => {
  snap = s;
  offsetServidor = s.serverNow - Date.now();
  const cambio = s.etapa !== etapaPrevia;
  etapaActual = s.etapa;
  modoActual = s.actual?.modo || 'solo';
  body.dataset.estado = s.etapa;
  body.dataset.modo = modoActual;
  if (s.reacciones) totales = s.reacciones;

  switch (s.etapa) {
    case 'STANDBY':
      if (cambio) {
        detenerCancion();
        cargarTop();
      }
      break;
    case 'CALLING':
      if (cambio) detenerCancion();
      pintarCalling(s);
      break;
    case 'COUNTDOWN':
      $('#cuenta').textContent = s.actual?.cuenta ?? 3;
      break;
    case 'PLAYING':
      if (cambio && !espejo) arrancarCancion(s.actual);
      break;
    case 'RESULT':
      if (cambio) mostrarResultado(s);
      break;
  }
  pintarCantando(s);
  pintarSiguiente(s);
  etapaPrevia = s.etapa;
});

// la barra de tiempo del llamado (se anima sola mientras dure CALLING)
setInterval(() => {
  if (etapaActual !== 'CALLING' || !snap?.actual) return;
  const { llamadoDesde, llamadoHasta } = snap.actual;
  const resto = Math.max(0, Math.min(1, (llamadoHasta - ahoraServidor()) / (llamadoHasta - llamadoDesde)));
  $('#turnoBarra span').style.width = (resto * 100).toFixed(1) + '%';
}, 200);

function pintarCalling(s) {
  const a = s.actual;
  if (!a) return;
  $('#turnoNombre').textContent = a.nombre;
  $('#turnoCancion').textContent = a.cancion
    ? `${a.cancion.titulo} · ${a.cancion.artista}${a.modo === 'duo' ? ' · DÚO' : ''}`
    : '';
  $('#turnoFase').textContent =
    a.fase === 'eligiendo' ? 'Está eligiendo su canción…' : 'Acercate al escenario y tocá LISTO en tu celu';
}

// "🎤 NOMBRE · ❤️3 🔥1" solo mientras alguien canta
function pintarCantando(s) {
  const el = $('#cantandoAhora');
  const mostrar = s.etapa === 'PLAYING' && s.actual?.nombre;
  el.hidden = !mostrar;
  if (!mostrar) return;
  $('#cantandoNombre').textContent = s.actual.nombre;
  pintarContador();
}

function pintarContador() {
  const el = $('#reaccionesContador');
  const partes = Object.entries(totales)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${EMOJI[k]}${n}`);
  el.textContent = partes.join(' ');
  el.hidden = !partes.length;
}

// la fila completa vive en los celulares; aca solo "SIGUE: X"
function pintarSiguiente(s) {
  const el = $('#siguiente');
  const mostrar = (s.etapa === 'PLAYING' || s.etapa === 'RESULT') && s.siguiente;
  el.hidden = !mostrar;
  if (!mostrar) return;
  $('#siguienteNombre').textContent = s.siguiente.nombre;
  $('#siguienteMas').textContent = s.filaTotal > 1 ? `y ${s.filaTotal - 1} más` : '';
}

// --- STANDBY: lo mejor de la noche --------------------------------------------
async function cargarTop() {
  try {
    const lista = await fetch(`${SOCKET_URL}/api/leaderboard`).then((r) => r.json());
    const ol = $('#topNocheLista');
    ol.innerHTML = '';
    (lista || []).slice(0, 3).forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(p.iniciales)}</b> ${p.puntaje}`;
      ol.appendChild(li);
    });
    $('#topNoche').hidden = !lista?.length;
  } catch {}
}
setInterval(() => {
  if (etapaActual === 'STANDBY') cargarTop();
}, 60_000);

// --- Reacciones del publico -> emojis que flotan por el escenario ---------------
socket.on('reaccion', ({ tipo, nombre, totales: t }) => {
  if (t) totales = t;
  volarReaccion(EMOJI[tipo] || '❤️', nombre);
  if (etapaActual === 'PLAYING') pintarContador();
});

function volarReaccion(emoji, nombre) {
  const cont = $('#reacciones-vuelan');
  if (cont.children.length > 24) return; // el escenario nunca se inunda
  const span = document.createElement('span');
  span.className = 'reaccionVolando';
  const x = 8 + Math.random() * 84; // % del ancho
  const dur = 2.6 + Math.random() * 1.4;
  span.style.left = x + 'vw';
  span.style.setProperty('--dur', dur + 's');
  span.style.setProperty('--drift', (Math.random() * 2 - 1).toFixed(2));
  span.innerHTML = `<b>${emoji}</b>${nombre ? `<small>${escapeHtml(nombre)}</small>` : ''}`;
  cont.appendChild(span);
  setTimeout(() => span.remove(), dur * 1000 + 200);
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
let mandoFin = false;
let audioHandlers = []; // listeners de la cancion en curso (se quitan al terminar)
const barra = $('#progreso');
const barraFill = barra.querySelector('span');

function escucharAudio(evento, fn) {
  audio.addEventListener(evento, fn);
  audioHandlers.push([evento, fn]);
}
function soltarAudio() {
  for (const [evento, fn] of audioHandlers) audio.removeEventListener(evento, fn);
  audioHandlers = [];
}

async function arrancarCancion(actual) {
  const meta =
    catalogoFull.find((c) => c.id === actual?.cancion?.id) ||
    (await cargarCatalogo()).find((c) => c.id === actual?.cancion?.id) ||
    actual?.cancion;
  soltarAudio();
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
  totales = { corazon: 0, fuego: 0, aplauso: 0 };
  letraRec = { texto: '', hechas: 0, titulo: meta?.titulo || '' };
  // graba el canvas compuesto (camara + letra) + audio (cancion + voz)
  grabacion.iniciar(recCanvas.stream(30), audioBus.streamGrabacion());

  if (meta?.lrc) {
    try {
      letras = parsearLRC(await fetch(SOCKET_URL + meta.lrc).then((r) => r.text()));
      if (modoActual === 'duo') voces = repartirDuo(letras);
    } catch (e) {
      console.warn('letra:', e.message);
    }
  }

  const dur = duracionCancion;
  if (meta?.audio) {
    const abs = (u) => (/^https?:\/\//.test(u) ? u : SOCKET_URL + u);
    let probeRemoto = false;
    audio.src = abs(meta.audio);
    audio.currentTime = 0;
    audio.load();
    audio.play().catch(() => {});
    escucharAudio('playing', () => {
      if (!fallback) return;
      fallback = false;
      clearTimeout(finTimer);
      finTimer = setTimeout(finDeCancion, (audio.duration || dur) * 1000 + 4000);
    });
    escucharAudio('ended', finDeCancion);
    escucharAudio('error', () => {
      // el audio local no esta (o fallo): probamos el de Supabase antes de resignarnos
      if (meta.audioRemoto && !probeRemoto) {
        probeRemoto = true;
        audio.src = meta.audioRemoto;
        audio.load();
        audio.play().catch(() => {});
      } else {
        fallback = true;
      }
    });
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
  // los retos son de gestos: sin camara ni deteccion no tiene sentido pedirlos
  if (camaraOk && deteccionOk) retos.tick(performance.now(), datosManos);
}

// El server calcula el puntaje (cancion + retos + publico); la pantalla solo
// informa cuanto de la cancion se canto.
function finDeCancion() {
  if (mandoFin) return;
  mandoFin = true;
  const progreso = Math.min(1, relojBase() / duracionCancion);
  if (!espejo) socket.emit('pantalla:fin', { progreso });
}

// Ajuste fino de sincronía en vivo: [ y ]
addEventListener('keydown', (e) => {
  if (etapaActual !== 'PLAYING') return;
  if (e.key === '[') offsetLetra -= 0.2;
  else if (e.key === ']') offsetLetra += 0.2;
  else return;
  idxLetra = -2;
  flash(`offset ${offsetLetra.toFixed(1)}s`);
  console.log('[letra] offsetLetra =', offsetLetra.toFixed(2));
});

const elActual = $('#lineaActual');
const elSig = $('#lineaSiguiente');
let palabras = [];
let lineaRender = -99;
let palabraTapada = null; // { span, texto, t0 } - la que oculta el reto "adiviná la palabra"

function mostrarLinea(idx, forzar = false) {
  let i = idx;
  while (letras[i] && !letras[i].texto) i++;
  if (!forzar && i === lineaRender && idx >= 0) return;
  lineaRender = i;
  palabraTapada = null; // la linea se reconstruye entera, la referencia vieja ya no sirve

  elActual.innerHTML = '';
  palabras = [];
  const cur = letras[i];
  const sig = [letras[i + 1], letras[i + 2]].find((l) => l?.texto)?.texto || '';
  elSig.textContent = sig;
  if (!espejo) socket.emit('pantalla:letra', { actual: cur?.texto || '', siguiente: sig });

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
  if (palabraTapada && t >= palabraTapada.t0) destaparPalabra(); // le llego el momento, se revela sola
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

// Reto "adiviná la palabra tapada": oculta una palabra que todavia no se
// canto (de la linea actual) hasta que la pellizquen o le llegue su momento.
function taparPalabraProxima() {
  if (palabraTapada) return;
  const t = relojBase() - offsetLetra;
  const candidatas = palabras.filter((p) => p.t0 > t + 0.2);
  if (!candidatas.length) return;
  const elegida = candidatas[Math.floor(Math.random() * candidatas.length)];
  const texto = elegida.span.textContent;
  palabraTapada = { span: elegida.span, texto, t0: elegida.t0 };
  elegida.span.textContent = '▧'.repeat(Math.max(2, texto.trim().length)) + ' ';
}

function destaparPalabra() {
  if (!palabraTapada) return;
  palabraTapada.span.textContent = palabraTapada.texto;
  palabraTapada = null;
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
  soltarAudio();
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

// --- RESULT ---------------------------------------------
async function mostrarResultado(s) {
  const r = s.actual?.resultado;
  const token = s.privado?.videoToken;
  detenerCancion();

  const interrumpida = !!(r?.interrumpida || r?.forzado);
  $('#resultadoTitulo').innerHTML = interrumpida
    ? 'Gracias por <span class="script">cantar</span>'
    : '¡Sos una <span class="script">popstar</span>!';
  const msg = $('#resultadoMsg');
  msg.hidden = !interrumpida;
  msg.textContent = interrumpida ? (r?.motivo || 'La canción se interrumpió') : '';

  // puntaje animado + desglose entendible: canción / retos / público
  const el = $('#score');
  let v = 0;
  const meta = r?.total ?? 0;
  clearInterval(el._t);
  el._t = setInterval(() => {
    v = Math.min(meta, v + Math.max(1, Math.round(meta / 40)));
    el.textContent = v;
    if (v >= meta) clearInterval(el._t);
  }, 25);
  const d = r?.desglose || { cancion: 0, retos: 0, publico: 0 };
  $('#desglose').textContent = `Canción ${d.cancion} · Retos ${d.retos} · Público ${d.publico}`;
  const re = r?.reacciones || { corazon: 0, fuego: 0, aplauso: 0 };
  $('#resumenReacciones').textContent = `❤️ ${re.corazon}   🔥 ${re.fuego}   👏 ${re.aplauso}`;

  // QR de descarga (link privado de esta performance); el cantante tambien lo
  // recibe en su celu, el QR es solo una comodidad.
  const qr = $('#qrMarco');
  qr.hidden = !token;
  if (token) {
    fetch(`${SOCKET_URL}/api/qr-resultado?token=${encodeURIComponent(token)}`)
      .then((x) => x.json())
      .then(({ dataUrl }) => { if (dataUrl) $('#qrResultado').src = dataUrl; })
      .catch(() => {});
  }

  // cerrar la grabacion y subirla: el server la pasa a .mp4 con ffmpeg
  if (espejo) return;
  const blob = await grabacion.detener();
  if (!blob || !blob.size || !token) {
    console.warn('[video] no hay grabacion para subir (blob vacio o sin token)');
    return;
  }
  for (let intento = 0; intento < 3; intento++) {
    try {
      const resp = await fetch(`${SOCKET_URL}/api/video/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/webm' },
        body: blob,
      });
      if (resp.ok || resp.status === 409) return;
    } catch (e) {
      console.warn('subida de video:', e.message);
    }
    await new Promise((x) => setTimeout(x, 2000));
  }
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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
