// La pantalla grande: un ESCENARIO. Muestra siempre lo mismo, sea quien sea el
// que cante, y se maneja desde los celulares. La camara solo alimenta los
// retos de gestos (y, opcionalmente, ve que alguien llego al escenario).
//
// El estado manda el servidor (server/escenario.js):
//   STANDBY -> CALLING -> COUNTDOWN -> PLAYING -> RESULT -> (CALLING | STANDBY)
// Esta pagina reproduce la cancion y la letra, graba el video y le avisa al
// server cuando termino y como le fue con los retos.

import { conectar, SOCKET_URL } from './socket.js';
import { parsearLRC, indiceActual, tiemposPalabras } from './lrc.js';
import { crearReloj } from './reloj.js';
import { crearPrecarga } from './precarga.js';
import { cargarApiYouTube, crearReproductorYouTube, ESTADO as YT_ESTADO } from './youtube.js';
import { logAudio, logCancion, errorAudio, diagnostico } from './audioLog.js';
import { crearReconocimiento } from './vision.js';
import { crearSeguimiento } from './seguimiento.js';
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
      if (dataUrl) {
        $('#qrSala').src = dataUrl;
        $('#qrFijoImg').src = dataUrl;
        $('#qrFijo').classList.add('listo');
      }
      if (url) $('#qrUrl').textContent = url.replace(/^https?:\/\//, '');
    })
    .catch(() => setTimeout(cargarQr, 3000));
}
cargarQr();

// --- Fondo + audio + camara ------------------------------------------
const fondo = crearFondo($('#estrella-wrap'));
const audioBus = crearAudioBus(audio);
// diagnostico: en la consola, window.__karaoke.estadoAudio() muestra por que (no) suena
window.__karaoke = { audio, audioBus, diagnostico };
const camara = crearCamara($('#camara'), video);

// PRECARGA: la cancion de quien esta en el escenario y la de quien sigue se bajan, se
// decodifican y se prueban ANTES de que les toque. Cada cambio de estado se le informa al
// server (la unica fuente de verdad de si se puede empezar).
// Reproductor de YouTube de esta pantalla: se crea una sola vez y se reutiliza para todas las canciones.
let ytPromesa = null;
let yt = null;
function reproductorYT() {
  if (!ytPromesa) {
    ytPromesa = cargarApiYouTube()
      .then((YT) => {
        const r = crearReproductorYouTube({
          YT,
          elementoId: 'ytPlayer',
          origen: location.origin,
          onEstado: (e) => { if (e === YT_ESTADO.TERMINADO && etapaActual === 'PLAYING' && fuenteActiva === yt?.adaptador) finDeCancion(); },
          onError: ({ mensaje }) => { if (etapaActual === 'PLAYING') fallarAudio(mensaje); },
        });
        yt = r;
        return r.listo.then(() => r);
      })
      .catch((e) => { ytPromesa = null; throw e; });
  }
  return ytPromesa;
}
const precarga = crearPrecarga({
  base: SOCKET_URL,
  // YouTube no se descarga: "lista" = el reproductor oficial cargo en esta pantalla
  prepararYouTube: async () => { await reproductorYT(); },
  onEstado: (id, estado, motivo) => {
    if (!espejo) socket.emit('pantalla:audio', { cancionId: id, estado, motivo });
  },
});
const grabacion = crearGrabacion();

// canvas 1280x720 que se GRABA: camara + letra + marca de agua
let letraRec = { texto: '', hechas: 0, titulo: '' };
const recCanvas = crearGrabacionCanvas(video, { getLetra: () => letraRec });

// Retos: plan atado a la cancion (reloj del audio). Los puntos los suma el server.
const retos = crearRetos({
  onCartel: (reto) => {
    pintarReto(reto);
    if (!reto) { destaparPalabra(); palabraEstado = null; }
  },
  onCumplido: (c) => { if (!espejo) socket.emit('pantalla:retoCumplido', c); },
  onResultado: ({ ok, puntos, tipo, palabra, motivo }) => {
    if (tipo === 'palabra') {
      destaparPalabra(true);
      if (palabra) {
        mostrarFeedback(
          ok
            ? { ok: true, titulo: `✓ ¡Era «${palabra}»!`, puntos }
            : { ok: false, titulo: `${motivo === 'tiempo' ? '⌛' : '✗'} Era «${palabra}»` }
        );
      }
    } else if (ok) {
      mostrarFeedback({ ok: true, titulo: '✓ ¡LO HICISTE!', puntos });
    } else {
      mostrarFeedback({ ok: false, suave: true, titulo: 'Se acabó el tiempo ✋' });
    }
  },
  onPalabra: ({ t }) => prepararPalabra(t),
  onPalabraFin: ({ id }) => { if (!espejo) socket.emit('pantalla:retoFin', { id }); },
});

// Arranca directo. Intentamos desbloquear el audio apenas carga (funciona solo
// si el navegador corre con --autoplay-policy=no-user-gesture-required, ver
// README "Modo kiosco"); si no, aparece un chip discreto y un clic lo destraba.
audioBus.desbloquear();

function frame() {
  fondo.latir(audioBus.tick());
  camara.dibujar(datosManos);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// El cuadro del VIDEO se dibuja con su propio reloj (~30 por segundo), no con el de la
// pantalla: si el navegador frena requestAnimationFrame (ventana tapada, carga alta)
// el video no se entrecorta con el.
setInterval(() => { if (grabacion.grabando) recCanvas.dibujar(); }, 33);

// --- Camara, microfono y deteccion (todo opcional: el show sigue sin ellos) ---
let camaraOk = null; // null = todavia pidiendo permiso
let micOk = null;
let deteccion = 'cargando'; // 'cargando' | 'ok' | 'error' (MediaPipe)
let ultimoFrameManos = 0;
let ultimaPresenciaEmit = 0;
// el tracking esta dando resultados AHORA (si el video se congela o MediaPipe muere, deja de estarlo)
const deteccionViva = () => deteccion === 'ok' && performance.now() - ultimoFrameManos < 2500;
const manosDisponibles = () => camaraOk === true && deteccionViva();
// TRACKING (donde estan las manos) -> GESTOS (que hacen): ver seguimiento.js y manos.js
const seguimiento = crearSeguimiento();

const gestos = crearGestos({
  getOpciones: () => (palabraEstado && !espejo && manosDisponibles() ? palabraEstado.opciones.length : 0),
  onOpcion: (i) => responderPalabraConMano(i),
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
      onResultado: ({ detecciones, hayPersona, cara }) => {
        const t = performance.now();
        deteccion = 'ok';
        ultimoFrameManos = t;
        gestos({ manos: seguimiento.actualizar(detecciones, t), cara, ts: t });
        if (!espejo && t - ultimaPresenciaEmit > 1000) {
          ultimaPresenciaEmit = t;
          socket.emit('pantalla:presencia', { hay: !!hayPersona });
        }
      },
    }).catch((err) => {
      // la camara anda pero MediaPipe no cargo: antes esto era SILENCIOSO y los
      // retos con manos simplemente no aparecian nunca
      console.warn('[manos] el reconocimiento no arranco:', err?.message || err);
      deteccion = 'error';
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
  const manosCaidas = camaraOk === true && (deteccion === 'error' || (deteccion === 'ok' && !deteccionViva()));
  // si el tracking de manos no anda, para el escenario es como no tener camara
  const s = { camara: camaraOk !== false && !manosCaidas, mic: micOk !== false, audio: audioOk };
  $('#chipCamara').hidden = camaraOk !== false;
  $('#chipManos').hidden = !manosCaidas;
  $('#chipMic').hidden = s.mic;
  $('#chipAudio').hidden = true; // reemplazado por el cartel grande: sin sonido no hay karaoke
  $('#sonidoOverlay').hidden = s.audio;
  if (!s.audio) audioBus.contexto?.resume?.().catch(() => {}); // si ya hubo un gesto, se destraba solo
  const k = JSON.stringify(s);
  if (k !== saludPrevia && socket.connected && !espejo) {
    saludPrevia = k;
    socket.emit('pantalla:salud', s);
  }
}
setInterval(salud, 2000);
// tocar la pantalla (cualquier lado) habilita el sonido; no hace falta ningun boton
function activarSonido() {
  Promise.resolve(audioBus.desbloquear()).then(() => {
    logAudio(`AudioContext: ${audioBus.contexto?.state}`);
    salud();
  });
}
$('#sonidoOverlay').addEventListener('click', activarSonido);
audioBus.contexto?.addEventListener('statechange', () => {
  logAudio(`AudioContext cambio a: ${audioBus.contexto.state}`);
  salud();
});
setTimeout(salud, 300);

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
  // el server pudo haberse reiniciado: se le dice de nuevo que audio tiene la pantalla listo
  for (const j of precarga.estados()) socket.emit('pantalla:audio', { cancionId: j.id, estado: j.estado, motivo: j.motivo });
});
socket.on('audio:reintentar', ({ cancionId } = {}) => {
  if (cancionId && precarga.ids.includes(cancionId)) precarga.reintentar(cancionId);
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
  // dueto: "VOZ 1 · IARA" / "VOZ 2 · ROCIO" (el compañero es quien entro como copiloto)
  $('#lineaActual').dataset.n1 = s.actual?.nombre ? ` · ${s.actual.nombre}` : '';
  $('#lineaActual').dataset.n2 = s.actual?.copiloto ? ` · ${s.actual.copiloto}` : '';
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
      if (cambio && !espejo) calentarYouTube(s.actual);
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

  // Que audio tener cargado: el de quien esta en el escenario y el de quien sigue. Si alguien
  // cambia de cancion mientras espera, la precarga vieja se cancela y arranca la nueva.
  if (!espejo) {
    const enEscena = s.etapa !== 'RESULT' && s.etapa !== 'STANDBY' ? s.actual?.cancion?.id : null;
    precarga.proteger(s.etapa === 'COUNTDOWN' || s.etapa === 'PLAYING' ? [s.actual?.cancion?.id] : []);
    precarga.apuntar([enEscena, s.siguiente?.cancionId]);
  }
});

// la barra de tiempo del llamado (se anima sola mientras dure CALLING)
setInterval(() => {
  if (etapaActual !== 'CALLING' || !snap?.actual) return;
  const { llamadoDesde, llamadoHasta } = snap.actual;
  const resto = Math.max(0, Math.min(1, (llamadoHasta - ahoraServidor()) / (llamadoHasta - llamadoDesde)));
  $('#turnoBarra span').style.width = (resto * 100).toFixed(1) + '%';
}, 200);

// --- CALLING: el turno de alguien -----------------------------------------------
// La cancion se elige SOLO desde el celu (la pantalla es un escenario, no un menu). Aca se
// ve de quien es el turno, que va a cantar y si su audio ya esta listo para sonar.
function pintarCalling(s) {
  const a = s.actual;
  if (!a) return;
  $('#turnoNombre').textContent = a.nombre;
  const modo = $('#turnoModo');
  modo.hidden = false;
  modo.textContent = a.modo === 'duo' ? 'a dúo · voz 1 y voz 2' : 'solo';
  const c = a.cancion;
  $('#turnoCancion').innerHTML = c
    ? `${escapeHtml(c.titulo)} <span class="art">${escapeHtml(c.artista)}</span>`
    : '<span class="art">eligiendo su canción en el celu…</span>';
  const au = a.audio || {};
  const fase = $('#turnoFase');
  fase.dataset.audio = au.estado || '';
  fase.textContent = !c
    ? 'Elegí tu canción desde el celu'
    : au.estado === 'lista'
      ? '✓ Audio listo · tocá LISTO en tu celu'
      : au.estado === 'bloqueado'
        ? '🔇 Tocá la pantalla para activar el sonido'
        : au.estado === 'error'
          ? `⚠️ No se pudo preparar el audio${au.motivo ? ` (${au.motivo})` : ''}`
          : `⏳ Preparando el audio… ${au.etapa === 'pantalla' ? '(cargando en la pantalla)' : au.etapa === 'servidor' ? '(consiguiendo la canción)' : ''}`;
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
let finTimer = null;
let offsetLetra = 0;
let duracionCancion = 40;
let cancionId = '';
let mandoFin = false;
let audioHandlers = []; // listeners de la cancion en curso (se quitan al terminar)
let audioDetectado = false; // se vio señal real en el analizador (la musica llega al grafo)
let silencioChequeado = 0;
const barra = $('#progreso');
const barraFill = barra.querySelector('span');

// UNA sola fuente de verdad para la letra, los retos, el progreso y el fin:
// el tiempo REAL del audio (ver reloj.js). Nada de temporizadores paralelos.
// La fuente activa es el <audio> (biblioteca local) o el adaptador del reproductor de YouTube;
// el reloj no se entera de cual es: lee siempre del mismo proxy.
let fuenteActiva = audio;
const fuenteReloj = {
  get currentTime() { return fuenteActiva.currentTime; },
  get paused() { return fuenteActiva.paused; },
  get ended() { return fuenteActiva.ended; },
  get readyState() { return fuenteActiva.readyState; },
  get playbackRate() { return fuenteActiva.playbackRate || 1; },
};
const reloj = crearReloj({
  audio: fuenteReloj,
  latencia: () => audioBus.contexto?.outputLatency || audioBus.contexto?.baseLatency || 0,
});
const claveOffset = (id) => `karaoke:offset:${id}`;
const absUrl = (u) => (/^https?:\/\//.test(u) ? u : SOCKET_URL + u);

function escucharAudio(evento, fn) {
  audio.addEventListener(evento, fn);
  audioHandlers.push([evento, fn]);
}
function soltarAudio() {
  for (const [evento, fn] of audioHandlers) audio.removeEventListener(evento, fn);
  audioHandlers = [];
}

async function buscarMeta(actual) {
  const id = actual?.cancion?.id;
  try {
    const r = await fetch(`${SOCKET_URL}/api/cancion/${encodeURIComponent(id)}`);
    if (r.ok) return await r.json();
  } catch {}
  return catalogoFull.find((c) => c.id === id) || actual?.cancion;
}

// La pantalla no pudo reproducir: nunca se "canta en silencio". El server cierra la performance
// con el motivo y pasa a la siguiente.
function fallarAudio(motivo) {
  errorAudio(`fallo de reproducción: ${motivo}`);
  $('#chipSilencio').hidden = false;
  $('#chipSilencio').textContent = `🔇 ${motivo}`;
  if (!espejo) socket.emit('pantalla:audioFallo', { motivo });
}

// Cuenta regresiva (3-2-1): el reproductor de YouTube ya se muestra y carga el video en silencio,
// asi cuando empieza la cancion solo hay que dar play desde el segundo 0.
function calentarYouTube(actual) {
  const c = actual?.cancion;
  if (c?.origen !== 'youtube' || !c.videoId) return;
  const pre = precarga.obtener(c.id);
  body.dataset.yt = pre?.lrc ? 'chico' : 'grande';
  reproductorYT().then((r) => r.precalentar(c.videoId)).catch((e) => errorAudio(`YouTube: no se pudo precalentar (${e.message})`));
}

async function arrancarCancion(actual) {
  const id = actual?.cancion?.id;
  const pre = precarga.obtener(id); // lo normal: ya esta cargada y probada
  const meta = pre?.meta || (await buscarMeta(actual));
  logCancion(`PLAYING ${id}: ${pre ? 'audio precargado en memoria' : 'SIN precarga (se usa la URL del server)'}`);
  if (!pre) errorAudio(`${id}: entró a PLAYING sin audio precargado`);

  soltarAudio();
  letras = [];
  voces = [];
  idxLetra = -1;
  mandoFin = false;
  audioDetectado = false;
  silencioChequeado = 0;
  $('#chipSilencio').hidden = true;
  cancionId = id || '';
  // el ajuste que hizo la persona con [ y ] queda guardado para esa cancion
  let guardado = null;
  try { guardado = localStorage.getItem(claveOffset(cancionId)); } catch {}
  offsetLetra = guardado != null && guardado !== '' ? Number(guardado) || 0 : Number(meta?.offsetLetra) || 0;
  duracionCancion = Number(meta?.duracion) || 40;
  clearTimeout(finTimer);
  mostrarLinea(-1, true);
  barra.hidden = false;
  barraFill.style.width = '0%';
  retos.reset();
  palabraEstado = null;
  totales = { corazon: 0, fuego: 0, aplauso: 0 };
  letraRec = { texto: '', hechas: 0, titulo: meta?.titulo || '' };
  // graba el canvas compuesto (camara + letra) + audio (cancion + voz)
  grabacion.iniciar(recCanvas.stream(30), audioBus.streamGrabacion());

  const dur = duracionCancion;
  const esYT = meta?.origen === 'youtube';
  const fuente = esYT ? null : pre ? pre.blobUrl : meta?.audio ? absUrl(meta.audio) : null;
  fuenteActiva = esYT ? yt?.adaptador || audio : audio;
  reloj.iniciar({ conAudio: esYT || !!fuente });
  if (esYT) {
    // reproduccion SOLO con el reproductor oficial embebido: no se descarga ni se extrae audio
    body.dataset.yt = pre?.lrc ? 'chico' : 'grande';
    logAudio(`YouTube ${meta.videoId}: play (${pre?.lrc ? 'letra propia + video chico' : 'letra dentro del video'})`);
    (async () => {
      try {
        const r = await reproductorYT();
        fuenteActiva = r.adaptador;
        await r.reproducir(meta.videoId);
        if (etapaActual !== 'PLAYING') return;
        reloj.alReproducir(); // recien ahora el tiempo de la letra empieza a correr
        clearTimeout(finTimer);
        const total = r.adaptador.duration || dur;
        finTimer = setTimeout(finDeCancion, total * 1000 + 4000);
      } catch (e) {
        if (e.codigo === 'autoplay') fallarAudio('el navegador no deja sonar YouTube: tocá la pantalla una vez (o usá el modo kiosco)');
        else fallarAudio(e.message || 'no se pudo reproducir el video');
      }
    })();
  }
  if (fuente) {
    let probeRemoto = false;
    const usarRemoto = () => {
      // la copia local fallo: probamos la de Supabase antes de resignarnos
      if (!meta.audioRemoto || probeRemoto) return false;
      probeRemoto = true;
      logAudio('probando la copia remota del audio');
      audio.src = meta.audioRemoto;
      audio.load();
      audio.play().catch((e) => fallarAudio(`play() rechazado: ${e.message}`));
      return true;
    };
    escucharAudio('playing', () => {
      reloj.alReproducir(); // recien ahora el tiempo de la letra empieza a correr
      logAudio(`reproduciendo: currentTime ${audio.currentTime.toFixed(2)} · volumen ${audio.volume} · muted ${audio.muted} · AudioContext ${audioBus.contexto?.state}`);
      clearTimeout(finTimer);
      finTimer = setTimeout(finDeCancion, ((Number.isFinite(audio.duration) && audio.duration) || dur) * 1000 + 4000);
    });
    escucharAudio('ended', finDeCancion);
    escucharAudio('waiting', () => logAudio(`el audio espera datos (readyState ${audio.readyState})`));
    escucharAudio('stalled', () => errorAudio(`el audio se trabó (networkState ${audio.networkState})`));
    escucharAudio('error', () => {
      errorAudio(`error del <audio>: código ${audio.error?.code} ${audio.error?.message || ''}`);
      if (!usarRemoto()) fallarAudio(`el audio dio error (${audio.error?.code ?? '?'})`);
    });
    logAudio(`AudioContext: ${audioBus.contexto?.state} · fuente: ${pre ? 'blob precargado' : fuente}`);
    audio.src = fuente;
    audio.volume = 1;
    audio.muted = false;
    try { audio.currentTime = 0; } catch {}
    audio.play().then(
      () => logAudio('play() OK'),
      (e) => {
        errorAudio(`play() rechazado: ${e.name}: ${e.message}`);
        if (!usarRemoto()) fallarAudio(`play() rechazado: ${e.message}`);
      }
    );
  }
  // si el audio nunca suena el reloj sigue solo (ver reloj.js) y esto cierra la cancion
  finTimer = setTimeout(() => { if (reloj.modo !== 'audio') finDeCancion(); }, (dur + 8) * 1000);

  clearInterval(loopId);
  loopId = setInterval(tickLetra, 60);

  // la letra ya viene con la precarga (si no, se baja ahora)
  let texto = pre?.lrc;
  if (!texto && meta?.lrc) {
    try { texto = await fetch(absUrl(meta.lrc)).then((r) => r.text()); } catch (e) { errorAudio(`letra: ${e.message}`); }
  }
  const lrc = texto ? parsearLRC(texto) : null;
  if (lrc?.length) {
    letras = lrc;
    if (modoActual === 'duo') voces = repartirDuo(letras);
  }
  idxLetra = -2;
  // plan de retos de ESTA performance: atado a la cancion y a las lineas de letra
  const durReal = Number.isFinite(fuenteActiva.duration) && fuenteActiva.duration > 5 ? fuenteActiva.duration : duracionCancion;
  retos.planificar({
    duracion: durReal,
    inicios: letras.filter((l) => l.texto).map((l) => l.tiempo + offsetLetra),
    conPalabra: letras.length > 8,
  });
}

const relojBase = () => reloj.base();

function tickLetra() {
  const base = reloj.base(); // segundos de audio (progreso y retos)
  const t = reloj.letra(offsetLetra); // tiempo de letra (audio - offset - latencia)
  barraFill.style.width =
    Math.max(0, Math.min(100, (base / duracionCancion) * 100)).toFixed(1) + '%';

  const nuevo = indiceActual(letras, t);
  if (nuevo !== idxLetra) {
    idxLetra = nuevo;
    mostrarLinea(nuevo);
  }
  pintarPalabras(t);
  verificarSonido(base);
  // los retos usan el MISMO reloj que la letra (segundos de audio), no uno propio
  const hayManos = manosDisponibles();
  retos.tick(base, hayManos ? datosManos : null, { hayManos });
}

// La prueba de que la musica SUENA: el analizador esta en el mismo grafo que los parlantes.
// Si el audio avanza pero no hay señal pasados unos segundos (contexto suspendido, grafo
// roto) se intenta destrabar y, si sigue mudo, la performance se cierra con el motivo en vez
// de seguir "cantando" en silencio. (Lo que no se puede ver desde el navegador: que el
// sistema operativo mande ese sonido al parlante correcto.)
function verificarSonido(base) {
  if (fuenteActiva !== audio) return verificarSonidoYouTube(base);
  if (audio.paused || reloj.modo !== 'audio') return;
  if (audioBus.tick() > 0.002) {
    if (!audioDetectado) logAudio(`señal de audio detectada en el grafo (currentTime ${audio.currentTime.toFixed(1)} s)`);
    audioDetectado = true;
    return;
  }
  if (audioDetectado || base < 20 || performance.now() - silencioChequeado < 3000) return;
  silencioChequeado = performance.now();
  errorAudio(`el audio avanza (${base.toFixed(1)} s) pero NO hay señal en la salida · AudioContext ${audioBus.contexto?.state}`);
  audioBus.desbloquear();
  setTimeout(() => {
    if (!audioDetectado && etapaActual === 'PLAYING') fallarAudio('no se detecta sonido en la salida');
  }, 3000);
}

// Con YouTube el sonido sale del iframe y no pasa por el Web Audio API: no se puede medir la
// señal. Lo que SI se verifica es que el reproductor este reproduciendo, con volumen y sin silencio.
let ytChequeo = 0;
function verificarSonidoYouTube(base) {
  if (reloj.modo !== 'audio' || performance.now() - ytChequeo < 2000) return;
  ytChequeo = performance.now();
  const a = fuenteActiva;
  if (a.muted || a.volume === 0) {
    errorAudio('YouTube está silenciado: se restablece el volumen');
    try { yt.restaurarSonido(); } catch {}
  }
}

// El server calcula el puntaje (cancion + retos + publico); la pantalla solo
// informa cuanto de la cancion se canto.
function finDeCancion() {
  if (mandoFin) return;
  mandoFin = true;
  const total = reloj.modo === 'audio' && Number.isFinite(fuenteActiva.duration) && fuenteActiva.duration > 5 ? fuenteActiva.duration : duracionCancion;
  const progreso = Math.min(1, reloj.base() / total);
  if (!espejo) socket.emit('pantalla:fin', { progreso });
}

// Ajuste fino de sincronía en vivo: [ y ]
addEventListener('keydown', (e) => {
  if (etapaActual !== 'PLAYING') return;
  if (e.key === '[') offsetLetra -= 0.2;
  else if (e.key === ']') offsetLetra += 0.2;
  else return;
  idxLetra = -2;
  offsetLetra = Math.round(offsetLetra * 10) / 10;
  try { localStorage.setItem(claveOffset(cancionId), String(offsetLetra)); } catch {}
  flash(`letra ${offsetLetra > 0 ? '+' : ''}${offsetLetra.toFixed(1)} s · guardado`);
  console.log(`[letra] ${cancionId}: "offsetLetra": ${offsetLetra.toFixed(1)} (queda guardado en esta pantalla; pegalo en canciones.json para fijarlo)`);
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
  // color por voz (modo dúo)
  const voz = voces[i] || 'p1';
  if (!espejo) socket.emit('pantalla:letra', { actual: cur?.texto || '', siguiente: sig, voz: modoActual === 'duo' ? voz : null });
  elActual.dataset.voz = modoActual === 'duo' ? voz : '';
  elSig.dataset.voz = modoActual === 'duo' ? (voces[i + 1] || voz) : '';

  if (!cur || !cur.texto) {
    elActual.hidden = true;
    letraRec = { ...letraRec, texto: '', hechas: 0 };
    return;
  }
  elActual.hidden = false;
  letraRec = { ...letraRec, texto: cur.texto, hechas: 0 };

  for (const { palabra, t0 } of tiemposPalabras(cur.texto, cur.tiempo, letras[i + 1]?.tiempo)) {
    const span = document.createElement('span');
    span.textContent = palabra + ' ';
    elActual.appendChild(span);
    palabras.push({ span, t0 });
  }
  elActual.classList.remove('entrando');
  void elActual.offsetWidth;
  elActual.classList.add('entrando');
  ajustarLetra();
}

function pintarPalabras(t) {
  if (palabraTapada && t >= palabraTapada.t0) destaparPalabra(); // le llego el momento: se revela
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

// --- Reto de la palabra ----------------------------------------------------
// Tapa una palabra de la linea actual que todavia no se canto, arma 3 opciones
// (la correcta + 2 palabras de la misma cancion) y se las manda al server, que
// guarda la respuesta correcta. Se contesta con la mano (elegir + pellizco
// sostenido) o desde el celu del cantante/copiloto; el server compara.
let palabraEstado = null; // { id, opciones, respondida }

const limpiar = (w) => String(w || '').replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();
const sinAcentos = (w) => limpiar(w).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const mezclado = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);

function prepararPalabra(tAudio) {
  if (espejo || palabraTapada || palabraEstado || !socket.connected) return null;
  const t = reloj.letra(offsetLetra); // tiempo de letra (el mismo que usa la pantalla)
  // la palabra tiene que llegar con tiempo para contestar (3.5 s a 12 s)
  const cand = palabras
    .map((p) => ({ ...p, txt: limpiar(p.span.textContent) }))
    .filter((p) => p.t0 - t >= 3.5 && p.t0 - t <= 12 && p.txt.length >= 3);
  if (!cand.length) return null;
  const elegida = cand.sort((a, b) => b.txt.length - a.txt.length || b.t0 - a.t0)[0];
  const correcta = elegida.txt;

  // distractores: otras palabras de la misma cancion, parecidas en largo
  const vistos = new Set([sinAcentos(correcta)]);
  const pool = [];
  for (const l of letras) {
    for (const w of l.texto.split(/\s+/)) {
      const c = limpiar(w);
      const k = sinAcentos(c);
      if (c.length < 3 || vistos.has(k)) continue;
      vistos.add(k);
      pool.push(c);
    }
  }
  if (pool.length < 2) return null;
  pool.sort((a, b) => Math.abs(a.length - correcta.length) - Math.abs(b.length - correcta.length) || Math.random() - 0.5);
  const opciones = mezclado([correcta, pool[0], pool[1]]);
  const dur = Math.min(10, Math.max(2.5, elegida.t0 - t - 0.3));
  const id = Math.random().toString(36).slice(2, 8);

  palabraTapada = { span: elegida.span, texto: elegida.span.textContent, t0: elegida.t0 };
  elegida.span.textContent = '▧'.repeat(Math.max(3, correcta.length)) + ' ';
  elegida.span.classList.add('tapada');
  palabraEstado = { id, opciones, respondida: false };

  const limite = setTimeout(() => retos.cancelarPalabra(id), 2500); // el server no contesto
  socket.emit('pantalla:retoPalabra', { id, opciones, correcta: opciones.indexOf(correcta), dur }, (r) => {
    clearTimeout(limite);
    if (!r?.ok) retos.cancelarPalabra(id);
  });
  return { id, hasta: tAudio + dur, opciones };
}

function destaparPalabra(resaltar = false) {
  if (!palabraTapada) return;
  palabraTapada.span.textContent = palabraTapada.texto;
  palabraTapada.span.classList.remove('tapada');
  if (resaltar) {
    const sp = palabraTapada.span;
    sp.classList.add('revelada');
    setTimeout(() => sp.classList.remove('revelada'), 2500);
  }
  palabraTapada = null;
}

// la respuesta con la mano (elegir una opcion y pellizcar sostenido)
function responderPalabraConMano(i) {
  if (!palabraEstado || palabraEstado.respondida || espejo) return;
  palabraEstado.respondida = true;
  flash(`«${palabraEstado.opciones[i]}»`);
  socket.emit('pantalla:retoResponder', { id: palabraEstado.id, opcion: i });
}

// el server comparo la respuesta (del celu, de la mano o por tiempo)
socket.on('reto:resultado', (r) => {
  retos.resolverPalabra(r);
});

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
  retos.reset();
  palabraEstado = null;
  destaparPalabra();
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {}
  yt?.detener();
  delete body.dataset.yt;
  fuenteActiva = audio;
}

// --- Retos: cartel y feedback ------------------------------------------------
function pintarReto(reto) {
  const el = $('#reto');
  if (!el) return;
  if (!reto) { el.hidden = true; return; }
  el.hidden = false;
  el.dataset.tipo = reto.tipo;
  $('#retoIcono').textContent = reto.icono;
  $('#retoTexto').textContent = reto.texto;
  $('#retoPuntos').textContent = `+${reto.puntos}`;
  el.style.setProperty('--resto', (reto.resto ?? 1).toFixed(2));
  el.style.setProperty('--sostener', (reto.sostener ?? 0).toFixed(2));

  const cont = $('#retoOpciones');
  cont.hidden = !reto.opciones;
  $('#retoAyuda').hidden = !reto.opciones;
  if (!reto.opciones) return;
  if (cont.dataset.id !== reto.id) {
    cont.dataset.id = reto.id;
    cont.innerHTML = '';
    reto.opciones.forEach((o) => {
      const b = document.createElement('div');
      b.className = 'opcion';
      b.textContent = o;
      cont.appendChild(b);
    });
  }
  const sel = manosDisponibles() ? (datosManos?.opcionSel ?? -1) : -1;
  const pinch = datosManos?.pinchProgress ?? 0;
  [...cont.children].forEach((b, k) => {
    b.classList.toggle('sel', k === sel);
    b.style.setProperty('--pinch', k === sel ? pinch.toFixed(2) : '0');
  });
  $('#retoAyuda').textContent = manosDisponibles()
    ? 'Mové la mano hasta la palabra y pellizcá · o tocá en tu celu'
    : 'Tocá la palabra en tu celu';
}

// "✓ ¡LO HICISTE! +10 PUNTOS": la persona tiene que ver POR QUE ganó el punto
function mostrarFeedback({ ok, titulo, puntos, suave = false }) {
  const el = $('#retoFeedback');
  if (!el) return;
  el.className = ok ? 'ok' : suave ? 'suave' : 'fallo';
  $('#retoFeedbackTitulo').textContent = titulo;
  $('#retoFeedbackPuntos').textContent = ok && puntos ? `+${puntos} PUNTOS` : '';
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, ok ? 2000 : 1600);
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
  const grabando = grabacion.grabando;
  const blob = await grabacion.detener();
  if (!blob || !blob.size || !token) {
    console.warn(`[video] no hay nada para subir: blob=${blob ? blob.size + 'B' : 'null'} (estaba grabando: ${grabando}) token=${token ? 'si' : 'NO'} diagnostico=${JSON.stringify(grabacion.diagnostico)}`);
    // el celu no tiene que esperar para siempre un video que no va a llegar
    if (token) socket.emit('pantalla:videoError', { token });
    return;
  }
  // la subida es lo mas fragil del video (archivo grande, wifi): se reintenta
  // con espera creciente y, si no hay caso, se le avisa al server para que el
  // celu de la persona muestre un error claro en vez de esperar para siempre
  for (let intento = 0; intento < 4; intento++) {
    try {
      const resp = await fetch(`${SOCKET_URL}/api/video/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/webm' },
        body: blob,
      });
      if (resp.ok || resp.status === 409) return;
      console.warn(`[video] el server rechazo la subida (${resp.status})`);
      if (resp.status === 403 || resp.status === 413) break; // reintentar no arregla esto
    } catch (e) {
      console.warn('[video] subida:', e.message);
    }
    await new Promise((x) => setTimeout(x, 2000 * (intento + 1)));
  }
  socket.emit('pantalla:videoError', { token });
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
