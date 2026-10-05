// App del celular (/sala). Una sola pagina, una sola vista visible segun el
// rol de la persona en el escenario (PUBLIC / QUEUED / CALLED / SINGING /
// DONE / copiloto). Toda la logica vive en el server (server/escenario.js):
// aca solo se muestra lo que dicen `estado` (publico) y `yo` (privado) y se
// mandan intents tipados. La identidad es un token en localStorage, asi que
// cerrar el navegador, perder señal o reiniciar el server no hace perder el lugar.
import { conectar, SOCKET_URL } from './socket.js';
import { crearBuscador } from './buscador.js';

const $ = (id) => document.getElementById(id);
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// ---------------------------------------------------------------- identidad
let token = leer('karaoke:token');
if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
  token = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '').padEnd(24, 'x').slice(0, 40);
  guardar('karaoke:token', token);
}
let nombre = leer('karaoke:nombre') || '';
$('inNombre').value = nombre;

// ------------------------------------------------------------------- estado
let est = null; // snapshot publico
let yo = null; // lo mio
let ajusteReloj = 0; // serverNow - Date.now()
let totales = { corazon: 0, fuego: 0, aplauso: 0 };
let letra = { actual: '', siguiente: '' };
let yoReal = null; // lo que dice el server (yo puede tener cambios optimistas hasta que llegue lo real)
let resultados = { q: '', items: [], estado: 'cargando', error: null, errorCodigo: null, hayMas: false, remoto: true, cargandoMas: false };
// 🎵 buscador: debounce, cancelacion, paginacion y estados (ver buscador.js)
const buscador = crearBuscador({ base: SOCKET_URL, onCambio: (e) => pintarBuscador(e) });
let modoPendiente = null; // solo/duo elegido ANTES de anotarse (o sin que el server lo confirme todavia)
let resultadoOculto = leer('karaoke:resultadoOculto') || '';
let vistaPrevia = '';
let estadoPrevio = '';
let esSiguientePrevio = false;

const ahoraServer = () => Date.now() + ajusteReloj;
const REACC = [
  { tipo: 'corazon', emoji: '❤️' },
  { tipo: 'fuego', emoji: '🔥' },
  { tipo: 'aplauso', emoji: '👏' },
];

// ------------------------------------------------------------------- socket
function intencion() {
  try { return JSON.parse(leer('karaoke:intencion') || 'null') || undefined; } catch { return undefined; }
}

// El celu se presenta en el handshake (token + nombre + lo que estaba haciendo):
// despues de un corte o un reinicio del server la conexion ya nace registrada y
// cualquier boton funciona desde el primer toque.
const socket = conectar('celu', {}, (cb) => cb({ token, nombre, intencion: intencion() }));

function saludar() {
  socket.emit('hola', { token, nombre, intencion: intencion() }, (r) => {
    if (!r?.ok) mostrarAviso(r?.error || 'No pude conectarme a la sala', 8000);
  });
}

socket.on('connect', () => { $('sinConexion').hidden = true; saludar(); });
socket.on('disconnect', () => { $('sinConexion').hidden = false; });
socket.on('connect_error', () => { $('sinConexion').hidden = false; });
socket.on('estado', (s) => {
  est = s;
  ajusteReloj = s.serverNow - Date.now();
  totales = { corazon: 0, fuego: 0, aplauso: 0, ...(s.reacciones || {}) };
  if (s.etapa !== 'PLAYING') letra = { actual: '', siguiente: '' };
  render();
});
socket.on('yo', (m) => {
  yoReal = m;
  yo = m;
  if (m?.nombre) { nombre = m.nombre; guardar('karaoke:nombre', nombre); }
  recordarIntencion();
  // eligio solo/dúo antes de anotarse y el server no lo aplicó (version anterior): se pide ahora
  if (modoPendiente && enFila(m)) {
    const quiero = modoPendiente;
    modoPendiente = null;
    if (m.modo !== quiero) elegirModo(quiero);
  }
  render();
});
socket.on('reaccion', (r) => {
  if (r?.totales) { totales = { ...totales, ...r.totales }; pintarContadores(); }
});
// el server compara la respuesta del reto de la palabra y avisa a todos
let retoResultado = null; // { ok, texto, hasta }
socket.on('reto:resultado', (r) => {
  const puede = yo?.estado === 'SINGING' || yo?.copilotoDe?.estado === 'SINGING';
  if (!puede) return;
  retoResultado = r.timeout
    ? { ok: false, texto: `⌛ Se acabó el tiempo · era «${r.palabra}»`, hasta: Date.now() + 3500 }
    : r.acierto
      ? { ok: true, texto: `✓ ¡Era «${r.palabra}»! +${r.puntos || 10} puntos`, hasta: Date.now() + 3500 }
      : { ok: false, texto: `✗ Era «${r.palabra}»`, hasta: Date.now() + 3500 };
  if (r.acierto) vibrar([60, 40, 60]);
  renderReto();
});
socket.on('letra', (l) => {
  letra = l || { actual: '', siguiente: '' };
  pintarLetra();
});

// si el server se reinicia, el celu se vuelve a anotar solo con su cancion
function recordarIntencion() {
  const enFila = yo && (yo.estado === 'QUEUED' || yo.estado === 'CALLED');
  if (enFila) guardar('karaoke:intencion', JSON.stringify({ enFila: true, cancionId: yo.cancionId, modo: yo.modo, busqueda: yo.cancion?.searchQuery || resultados.q || '' }));
  else if (yo) { try { localStorage.removeItem('karaoke:intencion'); } catch {} }
}

// ---------------------------------------------------------------- utilidades
let avisoTimer = null;
function mostrarAviso(txt, ms = 5000) {
  const a = $('aviso');
  a.textContent = txt;
  a.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (a.hidden = true), ms);
}

function enviar(evento, datos, alErrar) {
  socket.emit(evento, datos, (r) => {
    if (r && r.ok === false) {
      mostrarAviso(r.error || 'No se pudo', 5000);
      alErrar?.(r);
    }
  });
}

function mmss(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
}

function etaTexto(seg, esSiguiente) {
  if (esSiguiente && (seg == null || seg <= 60)) return 'Sos el siguiente';
  if (seg == null) return '';
  const min = Math.max(1, Math.round(seg / 60));
  return `Te toca en ~${min} min`;
}

const tituloDe = (c) => (c ? `${c.titulo}${c.artista ? ` · ${c.artista}` : ''}` : '');
const hayPantalla = () => !!est?.pantalla?.conectada;

// ------------------------------------------------------------------ vistas
const VISTAS = ['vPublico', 'vFila', 'vTurno', 'vCuenta', 'vCantando', 'vResultado', 'vCopiloto'];

function elegirVista() {
  if (!yo) return 'vPublico';
  if (yo.copilotoDe) return 'vCopiloto';
  switch (yo.estado) {
    case 'QUEUED': return 'vFila';
    case 'CALLED': return 'vTurno';
    case 'SINGING': return est?.etapa === 'COUNTDOWN' ? 'vCuenta' : 'vCantando';
    case 'DONE':
      return yo.videoToken && resultadoOculto === yo.videoToken ? 'vPublico' : 'vResultado';
    default: return 'vPublico';
  }
}

function render() {
  if (!est) return;
  const vista = elegirVista();
  for (const v of VISTAS) $(v).hidden = v !== vista;

  // avisos al cambiar de estado
  const estadoAhora = yo?.estado || '';
  if (estadoAhora === 'CALLED' && estadoPrevio !== 'CALLED') avisarTurno();
  else if (yo?.esSiguiente && !esSiguientePrevio && estadoAhora === 'QUEUED') vibrar([120, 80, 120]);
  if (yo?.mensaje && yo.mensaje !== renderMensajeVisto) { renderMensajeVisto = yo.mensaje; mostrarAviso(yo.mensaje, 7000); }
  estadoPrevio = estadoAhora;
  esSiguientePrevio = !!yo?.esSiguiente;
  vistaPrevia = vista;

  renderPublico();
  renderFila();
  renderTurno();
  renderCuenta();
  renderCantando();
  renderResultado();
  renderCopiloto();
  renderSelectores();
  pintarModoPublico();
  renderReto();
  pintarContadores();
  pintarLetra();
  pantallaEncendida(['vFila', 'vTurno', 'vCuenta', 'vCantando', 'vCopiloto'].includes(vista));
  refrescarTimers();
}
let renderMensajeVisto = '';

function vibrar(patron) {
  try { navigator.vibrate?.(patron); } catch {}
}

let tituloOriginal = document.title;
let tituloTimer = null;
function avisarTurno() {
  vibrar([300, 150, 300, 150, 700]);
  clearInterval(tituloTimer);
  let on = false;
  tituloTimer = setInterval(() => {
    on = !on;
    document.title = on ? '🎤 ¡ES TU TURNO!' : tituloOriginal;
    if (yo?.estado !== 'CALLED') { clearInterval(tituloTimer); document.title = tituloOriginal; }
  }, 900);
}

// ---------------------------------------------------------------- PUBLICO
function renderPublico() {
  const a = est.actual;
  const kicker = $('ahoraKicker');
  const txt = $('ahoraTexto');
  const cancion = $('ahoraCancion');
  const barra = $('ahoraBarra');
  barra.hidden = true;
  cancion.textContent = '';
  if (!a || est.etapa === 'STANDBY') {
    kicker.textContent = 'ahora';
    txt.textContent = 'Escenario libre';
    cancion.textContent = 'Anotate y cantá ya mismo';
  } else if (est.etapa === 'CALLING') {
    kicker.textContent = 'llamando a';
    txt.textContent = a.nombre;
    cancion.textContent = 'Está eligiendo su canción';
  } else if (est.etapa === 'COUNTDOWN') {
    kicker.textContent = 'está por cantar';
    txt.textContent = a.nombre;
    cancion.textContent = a.cancion ? `${a.cancion.titulo} · ${a.cancion.artista}` : '';
  } else if (est.etapa === 'PLAYING') {
    kicker.textContent = 'cantando ahora 🎤';
    txt.textContent = a.nombre;
    cancion.textContent = a.cancion ? `${a.cancion.titulo} · ${a.cancion.artista}` : '';
    barra.hidden = false;
  } else {
    kicker.textContent = 'terminó';
    txt.textContent = a.nombre;
    cancion.textContent = a.resultado ? `${a.resultado.total} puntos` : '';
  }
  const sig = est.siguiente;
  const mas = Math.max(0, (est.filaTotal || 0) - 1);
  $('ahoraSigue').textContent = sig ? `Sigue: ${sig.nombre}${mas ? ` y ${mas} más` : ''}` : '';

  const libre = !a || est.etapa === 'STANDBY';
  const cola = est.filaTotal || 0;
  $('btnCantar').textContent = libre && !cola ? '🎤 Quiero cantar · pasás ya' : `🎤 Quiero cantar · ${cola + 1}º en la fila`;
}

// ------------------------------------------------------------------- FILA
function renderFila() {
  if (!yo || yo.estado !== 'QUEUED') return;
  $('filaPos').textContent = yo.posicion ?? '–';
  $('filaEta').textContent = etaTexto(yo.etaSeg, yo.esSiguiente);
  const a = est.actual;
  $('filaAhora').textContent = a && est.etapa !== 'STANDBY' ? `Ahora: ${a.nombre}${a.cancion ? ` · ${a.cancion.titulo}` : ''}` : '';
  $('filaCancion').textContent = yo.cancion ? tituloDe(yo.cancion) : 'Todavía no elegiste';
  const box = $('boxCodigo');
  box.hidden = !yo.codigoCopiloto;
  if (yo.codigoCopiloto) {
    $('codigoCopiloto').textContent = yo.codigoCopiloto;
    $('copilotoEstado').textContent = yo.copiloto
      ? `${yo.copiloto.nombre} es tu copiloto 🤝`
      : yo.modo === 'duo'
        ? 'Dúo: pasale este código a tu compañero/a. Va a cantar la VOZ 2.'
        : 'Que escriba este código en su celu para ayudarte con la letra.';
  }
}

// ------------------------------------------------------------------ TURNO
function renderTurno() {
  if (!yo || yo.estado !== 'CALLED') return;
  const calling = est.etapa === 'CALLING';
  const a = yo.audio?.estado;
  $('turnoTitulo').textContent = calling ? '¡Pasá al frente!' : 'Ya casi…';
  $('turnoCancion').textContent = yo.cancion ? tituloDe(yo.cancion) : 'Elegí tu canción';
  $('turnoAyuda').textContent = !calling
    ? 'Esperá un momento, termina la canción anterior.'
    : !yo.cancionId
      ? 'Elegí tu canción acá abajo.'
      : a === 'lista'
        ? 'Parate frente a la pantalla y tocá LISTO.'
        : a === 'error'
          ? 'No se pudo preparar ese audio: reintentá o elegí otra canción.'
          : a === 'bloqueado'
            ? 'Falta activar el sonido en la pantalla (hay que tocarla una vez).'
            : 'Se está preparando tu audio, un momento…';
}

// ----------------------------------------------------------------- CUENTA
function renderCuenta() {
  if (!yo || yo.estado !== 'SINGING' || est.etapa !== 'COUNTDOWN') return;
  $('cuentaNum').textContent = est.actual?.cuenta ?? '';
  const c = est.actual?.cancion;
  $('cuentaCancion').textContent = c ? `${c.titulo} · ${c.artista}` : '';
}

// ---------------------------------------------------------------- CANTANDO
function renderCantando() {
  if (!yo || yo.estado !== 'SINGING') return;
  const c = est.actual?.cancion;
  $('cantaCancion').textContent = c ? c.titulo : '';
  pintarLetra();
}

function pintarContadores() {
  $('cantaReacc').textContent = `❤️ ${totales.corazon || 0}   🔥 ${totales.fuego || 0}   👏 ${totales.aplauso || 0}`;
}

// En un dueto cada linea es de una voz: la 1 es de quien canta y la 2 de su companero
// (el que entro como copiloto). Cada celu dice de quien es la linea de ahora.
function etiquetaVoz() {
  if (est?.actual?.modo !== 'duo' || !letra.voz) return null;
  const soyCantante = yo?.estado === 'SINGING';
  const miVoz = soyCantante ? 'p1' : 'p2';
  const otro = (soyCantante ? yo?.copiloto?.nombre : yo?.copilotoDe?.nombre) || 'tu compañero/a';
  if (letra.voz === 'both') return { texto: '🎶 Los dos', mia: true };
  return letra.voz === miVoz ? { texto: '🎤 Te toca a vos', mia: true } : { texto: `⏳ Le toca a ${otro}`, mia: false };
}

function pintarLetra() {
  const v = etiquetaVoz();
  for (const e of document.querySelectorAll('[data-voz-turno]')) {
    e.hidden = !v;
    if (v) { e.textContent = v.texto; e.classList.toggle('mia', v.mia); }
  }
  $('cantaLetra').textContent = letra.actual || '…';
  $('cantaLetraSig').textContent = letra.siguiente || '';
  $('copiLetra').textContent = letra.actual || 'Esperando que arranque la canción…';
  $('copiLetraSig').textContent = letra.siguiente || '';
}

// --------------------------------------------------------------- RESULTADO
function renderResultado() {
  if (!yo || yo.estado !== 'DONE' || !yo.resultado) return;
  const r = yo.resultado;
  $('resTotal').textContent = r.total;
  $('resTitulo').textContent = r.interrumpida ? '¡Gracias por cantar!' : '¡Sos una popstar!';
  const m = $('resMotivo');
  m.hidden = !r.interrumpida && !r.forzado;
  m.textContent = r.motivo ? `${r.motivo}. El puntaje es parcial.` : '';
  const d = r.desglose || {};
  $('resDesglose').textContent = `Canción ${d.cancion ?? 0} · Retos ${d.retos ?? 0} · Público ${d.publico ?? 0}`;
  const x = r.reacciones || {};
  $('resReacc').textContent = `❤️ ${x.corazon || 0}   🔥 ${x.fuego || 0}   👏 ${x.aplauso || 0}`;
  pintarVideo();
}

// El video de cada performance tiene su propio token y su propio estado en el
// server: esperando -> procesando -> listo (o error). El celu lo consulta solo
// y avisa cuando esta listo, sin que la persona tenga que recargar nada.
let video = { token: '', estado: 'esperando' };

function pintarVideo() {
  const link = $('resVideo');
  const txt = $('resVideoEstado');
  if (!yo?.videoToken) {
    link.hidden = true;
    txt.textContent = 'Esta vez no hay video.';
    return;
  }
  link.href = `${SOCKET_URL}/video/${yo.videoToken}`;
  const e = video.token === yo.videoToken ? video.estado : 'esperando';
  $('resVideoTitulo').textContent =
    e === 'listo' ? '🎥 Tu video está listo' : e === 'error' || e === 'desconocido' ? '🎥 Tu video' : '🎥 Procesando tu video…';
  link.hidden = !(e === 'listo' || e === 'error');
  link.textContent = e === 'listo' ? '▶ Ver / descargar' : 'Probar abrir mi video';
  txt.textContent =
    e === 'listo'
      ? 'Es privado: solo lo ves con este link. Se borra en 6 horas.'
      : e === 'error'
        ? 'No pudimos prepararlo del todo. Tocá el botón por si se puede ver igual.'
        : e === 'desconocido'
          ? 'El video ya no está.'
          : 'Puede tardar un minuto. Te avisamos acá apenas esté listo.';
}

let consultando = false;
async function consultarVideo() {
  const token = yo?.videoToken;
  if (!token || consultando || (video.token === token && (video.estado === 'listo' || video.estado === 'desconocido'))) return;
  consultando = true;
  try {
    const r = await fetch(`${SOCKET_URL}/api/video/${token}/estado`);
    const j = await r.json();
    if (token !== yo?.videoToken) return;
    const previo = video.token === token ? video.estado : '';
    video = { token, estado: j.estado };
    if (j.estado === 'listo' && previo !== 'listo') {
      vibrar([80, 50, 80]);
      mostrarAviso('🎥 ¡Tu video está listo!', 6000);
    }
    pintarVideo();
  } catch {
    /* sin red: se reintenta en el proximo ciclo */
  } finally {
    consultando = false;
  }
}
setInterval(() => { if (vistaPrevia === 'vResultado') consultarVideo(); }, 3000);

// --------------------------------------------------------------- COPILOTO
function renderCopiloto() {
  if (!yo?.copilotoDe) return;
  $('copiDe').textContent = `Ayudás a ${yo.copilotoDe.nombre}`;
  const e = yo.copilotoDe.estado;
  $('copiEstado').textContent =
    e === 'SINGING' ? 'Está cantando: acompañalo con la letra.' : e === 'QUEUED' ? 'Todavía está en la fila.' : 'Esperando su turno…';
}

// ----------------------------------------------- reto de la palabra (celu)
// El cantante y el copiloto contestan tocando una opcion. Mientras dura el reto
// se oculta el teleprompter: mostraria justo la palabra que hay que adivinar.
let retoPintado = '';
function renderReto() {
  const reto = est?.actual?.retoPalabra || null;
  const puede = !!yo && (yo.estado === 'SINGING' || yo.copilotoDe?.estado === 'SINGING');
  const mostrar = !!reto && puede;
  if (retoResultado && Date.now() > retoResultado.hasta) retoResultado = null;
  for (const box of document.querySelectorAll('[data-reto]')) {
    box.hidden = !mostrar;
    if (!mostrar) continue;
    const opc = box.querySelector('.retoOpc');
    if (opc.dataset.id !== reto.id) {
      opc.dataset.id = reto.id;
      opc.textContent = '';
      reto.opciones.forEach((o, i) => {
        const b = document.createElement('button');
        b.textContent = o;
        b.addEventListener('click', () => {
          for (const x of document.querySelectorAll('.retoOpc button')) x.disabled = true;
          document.querySelectorAll('.retoOpc').forEach((c) => c.children[i]?.classList.add('elegida'));
          vibrar(15);
          enviar('reto:responder', { id: reto.id, opcion: i }, () => {
            for (const x of document.querySelectorAll('.retoOpc button')) { x.disabled = false; x.classList.remove('elegida'); }
          });
        });
        opc.append(b);
      });
    }
  }
  for (const t of document.querySelectorAll('[data-teleprompter]')) t.hidden = mostrar;
  for (const r of document.querySelectorAll('[data-reto-res]')) {
    r.hidden = !retoResultado || mostrar;
    if (retoResultado) {
      r.textContent = retoResultado.texto;
      r.className = `retoRes ${retoResultado.ok ? 'ok' : 'fallo'}`;
    }
  }
  const k = `${reto?.id || ''}|${retoResultado?.texto || ''}`;
  if (k !== retoPintado) retoPintado = k;
}
setInterval(() => { if (retoResultado) renderReto(); }, 500);

// ------------------------------------------------------ selector de canciones
let firmaSelector = '';
function renderSelectores() {
  if (!yo) return;
  const firma = `${yo.cancionId}|${yo.modo}|${yo.audio?.estado}|${yo.audio?.etapa}|${yo.audio?.motivo}|${vistaPrevia}`;
  if (firma === firmaSelector) return;
  firmaSelector = firma;
  const modo = yo.modo || 'solo';
  for (const box of document.querySelectorAll('[data-selector]')) {
    for (const b of box.querySelectorAll('.modo button')) b.classList.toggle('on', b.dataset.modo === modo);
    const ayuda = box.querySelector('[data-modo-ayuda]');
    if (ayuda) {
      ayuda.textContent = modo === 'duo'
        ? 'A dúo: vos cantás la VOZ 1 y tu compañero/a la VOZ 2 (entra con tu código de copiloto).'
        : 'Solo: cantás vos toda la canción.';
    }
  }
  pintarAudio();
  pintarBuscador(resultados);
}

// Estado REAL del audio de mi cancion (no "se encontro una URL"): preparando -> lista | error
function pintarAudio() {
  const a = yo?.audio;
  for (const el of document.querySelectorAll('[data-audio-estado]')) {
    if (!yo?.cancionId || !a || a.estado === 'sin_cancion') {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    el.className = `audioEstado ${a.estado}`;
    const txt = el.querySelector('.audioTxt');
    const motivo = el.querySelector('.audioMotivo');
    const btns = el.querySelector('.audioBtns');
    btns.hidden = a.estado !== 'error';
    if (a.estado === 'lista') {
      txt.textContent = '✅ Audio listo';
      motivo.textContent = a.verificadaEnPantalla === false ? 'Se vuelve a comprobar en la pantalla cuando seas el siguiente.' : 'Ya está cargado en la pantalla.';
    } else if (a.estado === 'bloqueado') {
      txt.textContent = '🔇 Falta activar el sonido en la pantalla';
      motivo.textContent = 'Hay que tocar la pantalla grande una vez (o abrirla en modo kiosco).';
    } else if (a.estado === 'error') {
      txt.textContent = '⚠️ No se pudo preparar el audio';
      motivo.textContent = a.motivo || 'La fuente no se puede reproducir.';
    } else {
      txt.textContent = '⏳ Preparando el audio…';
      motivo.textContent = a.etapa === 'pantalla' ? 'Cargándolo en la pantalla.' : 'Consiguiendo la canción (puede tardar unos segundos).';
    }
  }
}

// Una tarjeta de resultado: miniatura, titulo, canal, duracion, insignia KARAOKE y boton ELEGIR.
function tarjetaCancion(c) {
  const li = document.createElement('li');
  li.dataset.id = c.id;
  li.className = 'resultado';
  if (c.id === yo?.cancionId) li.classList.add('elegida');
  const miniatura = document.createElement(c.thumbnail ? 'img' : 'span');
  miniatura.className = 'miniatura';
  if (c.thumbnail) {
    miniatura.src = c.thumbnail;
    miniatura.alt = '';
    miniatura.loading = 'lazy';
    miniatura.referrerPolicy = 'no-referrer';
  } else {
    miniatura.textContent = '🎵';
  }
  const info = document.createElement('span');
  info.className = 'info';
  const titulo = document.createElement('span');
  titulo.className = 'titulo';
  titulo.textContent = c.titulo;
  const art = document.createElement('span');
  art.className = 'art';
  art.textContent = `${c.canal || c.artista || ''}${c.duracion ? ` · ${mmss(c.duracion)}` : ''}`;
  info.append(titulo, art);
  if (c.karaoke?.esKaraoke || c.fuente === 'local') {
    const k = document.createElement('span');
    k.className = 'tagKaraoke';
    k.textContent = c.fuente === 'local' ? 'LISTA' : 'KARAOKE';
    info.append(k);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'elegir';
  btn.textContent = c.id === yo?.cancionId ? '✓ ELEGIDA' : 'ELEGIR';
  li.append(miniatura, info, btn);
  return li;
}

// Resultados del buscador (loading / vacio / error / paginacion), en todas las tarjetas.
function pintarBuscador(e) {
  resultados = e;
  for (const box of document.querySelectorAll('[data-selector]')) {
    const ul = box.querySelector('.canciones');
    const estadoEl = box.querySelector('[data-buscar-estado]');
    const errEl = box.querySelector('[data-buscar-error]');
    const mas = box.querySelector('[data-buscar-mas]');
    if (!ul) continue;
    ul.textContent = '';
    if (e.estado === 'cargando' && !e.items.length) {
      for (let k = 0; k < 4; k++) {
        const li = document.createElement('li');
        li.className = 'cargando';
        li.textContent = 'Cargando canción';
        ul.append(li);
      }
    }
    for (const c of e.items) ul.append(tarjetaCancion(c));
    estadoEl.textContent =
      e.estado === 'cargando'
        ? 'Buscando karaokes en YouTube…'
        : e.estado === 'vacio'
          ? `No encontramos resultados para "${e.q}". Probá con el artista y el nombre del tema.`
          : e.q
            ? `${e.items.length} resultado${e.items.length === 1 ? '' : 's'}${e.remoto ? ' · los karaoke primero' : ' · la búsqueda de YouTube no está disponible en este equipo'}`
            : e.remoto
              ? 'Escribí un artista o tema: buscamos la versión karaoke en YouTube.'
              : 'Disponibles ahora (listas para cantar). La búsqueda de YouTube no está configurada.';
    errEl.hidden = !e.error;
    errEl.querySelector('.error').textContent = e.error || '';
    errEl.querySelector('[data-buscar-reintentar]').hidden = e.errorCodigo === 'sin_clave';
    mas.hidden = !(e.estado === 'ok' && e.hayMas);
    mas.textContent = e.cargandoMas ? 'Cargando…' : 'Ver más canciones';
  }
}

// Elegir una cancion: se marca al instante ("preparando") y el server la registra y
// empieza a bajar/validar el audio YA, no cuando te toque el turno.
function elegirCancion(id) {
  if (!yo || !enFila(yo) || yo.cancionId === id) return;
  const c = resultados.items.find((x) => x.id === id);
  yo = { ...yo, cancionId: id, cancion: c ? { id: c.id, titulo: c.titulo, artista: c.canal || c.artista, thumbnail: c.thumbnail, origen: c.fuente === 'youtube' ? 'youtube' : 'local' } : yo.cancion, audio: { estado: 'preparando', etapa: 'servidor' } };
  firmaSelector = '';
  render();
  enviar('cancion:elegir', { cancionId: id, busqueda: resultados.q || '' }, () => {
    yo = yoReal; // no se pudo: volver a lo que dice el server
    firmaSelector = '';
    render();
  });
}

// Solo / Dúo. Responde al instante (se marca el boton sin esperar al server) y
// aguanta que el server sea de una version anterior: Vercel y Render no se
// actualizan a la vez, y un server viejo no conoce `modo:elegir` (antes el boton
// quedaba mudo).
const enFila = (m) => !!m && (m.estado === 'QUEUED' || m.estado === 'CALLED');
const modoMostrado = () => modoPendiente ?? yo?.modo ?? 'solo';

function pintarModoPublico() {
  const m = modoMostrado();
  for (const b of document.querySelectorAll('#modoPublico button')) b.classList.toggle('on', b.dataset.modo === m);
  $('ayudaModoPublico').textContent = m === 'duo'
    ? 'A dúo: vos cantás la VOZ 1 y tu compañero/a la VOZ 2 (entra con tu código).'
    : 'Solo: cantás vos toda la canción.';
}

function elegirModo(modo) {
  if (!enFila(yo)) {
    // todavia no esta en la fila: se recuerda y viaja con "Quiero cantar"
    modoPendiente = modo;
    pintarModoPublico();
    return;
  }
  yo = { ...yo, modo };
  firmaSelector = '';
  render();
  socket.timeout(2500).emit('modo:elegir', { modo }, (err, r) => {
    if (!err) {
      if (r && r.ok === false) mostrarAviso(r.error || 'No se pudo cambiar el modo', 5000);
      return;
    }
    // sin respuesta: server anterior. Por la via vieja el modo viaja con la cancion.
    if (yo?.cancionId) enviar('cancion:elegir', { cancionId: yo.cancionId, modo });
    else mostrarAviso('El servidor se está actualizando: elegí tu canción y probá el modo de nuevo en un minuto.', 7000);
  });
}

document.addEventListener('click', (e) => {
  const li = e.target.closest?.('.canciones li');
  if (li && li.dataset.id) {
    elegirCancion(li.dataset.id);
    return;
  }
  const mb = e.target.closest?.('.modo button');
  if (mb) {
    elegirModo(mb.dataset.modo);
    return;
  }
  if (e.target.closest?.('[data-audio-reintentar]')) {
    mostrarAviso('Preparando el audio de nuevo…', 3000);
    yo = yo && { ...yo, audio: { estado: 'preparando', etapa: 'servidor' } };
    firmaSelector = '';
    render();
    enviar('audio:reintentar');
    return;
  }
  if (e.target.closest?.('[data-audio-cambiar]')) {
    const input = e.target.closest('[data-selector]')?.querySelector('.buscar');
    input?.focus();
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (e.target.closest?.('[data-buscar-reintentar]')) {
    buscador.reintentar();
    return;
  }
  if (e.target.closest?.('[data-buscar-mas]')) buscador.masResultados();
});

document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('buscar')) {
    const v = e.target.value;
    for (const i of document.querySelectorAll('.buscar')) if (i !== e.target) i.value = v;
    buscador.consultar(v); // con debounce: no se le pega a la API por cada tecla
  }
});

// scroll infinito: al llegar casi al final de la lista se pide la pagina siguiente
document.addEventListener('scroll', (e) => {
  const ul = e.target;
  if (ul?.classList?.contains?.('canciones') && ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 80) buscador.masResultados();
}, true);

// -------------------------------------------------------------- reacciones
for (const cont of document.querySelectorAll('[data-reacciones]')) {
  for (const r of REACC) {
    const b = document.createElement('button');
    b.textContent = r.emoji;
    b.setAttribute('aria-label', r.tipo);
    b.addEventListener('click', () => {
      socket.emit('reaccion', { tipo: r.tipo });
      b.classList.add('tocado');
      setTimeout(() => b.classList.remove('tocado'), 160);
      vibrar(10);
    });
    cont.append(b);
  }
}

// ----------------------------------------------------------------- acciones
$('btnCantar').addEventListener('click', () => {
  const n = $('inNombre').value.trim();
  const err = $('errPublico');
  err.hidden = true;
  if (!n) {
    err.textContent = 'Escribí tu nombre para anotarte';
    err.hidden = false;
    $('inNombre').focus();
    return;
  }
  nombre = n;
  guardar('karaoke:nombre', nombre);
  const m = modoMostrado();
  modoPendiente = m; // si el server es de una version anterior, se reconcilia al llegar `yo`
  enviar('fila:entrar', { nombre: n, modo: m }, (r) => { err.textContent = r.error; err.hidden = false; });
});

$('btnCopiloto').addEventListener('click', () => {
  $('boxCopiloto').hidden = !$('boxCopiloto').hidden;
  if (!$('boxCopiloto').hidden) $('inCodigo').focus();
});
$('btnUnirCopiloto').addEventListener('click', () => {
  const codigo = $('inCodigo').value.trim();
  if (!codigo) return;
  enviar('copiloto:unirse', { codigo }, (r) => { $('errPublico').textContent = r.error; $('errPublico').hidden = false; });
});
$('btnSalirCopiloto').addEventListener('click', () => enviar('copiloto:salir'));
$('btnSalir').addEventListener('click', () => enviar('fila:salir'));
$('btnCancelarTurno').addEventListener('click', () => enviar('fila:salir'));
$('btnListo').addEventListener('click', () => enviar('turno:listo'));
$('btnTerminar').addEventListener('click', () => {
  if (confirm('¿Terminar la canción ahora?')) enviar('cantante:terminar');
});
$('btnDeNuevo').addEventListener('click', () => {
  ocultarResultado();
  const n = $('inNombre').value.trim() || nombre;
  if (n) { const m = modoMostrado(); modoPendiente = m; enviar('fila:entrar', { nombre: n, modo: m }); }
});
$('btnSeguirMirando').addEventListener('click', ocultarResultado);

function ocultarResultado() {
  resultadoOculto = yo?.videoToken || 'x';
  guardar('karaoke:resultadoOculto', resultadoOculto);
  render();
}

// ------------------------------------------------------------------ timers
function refrescarTimers() {
  if (!est) return;
  const t = ahoraServer();
  const a = est.actual;

  // progreso de la cancion (publico y cantante)
  if (est.etapa === 'PLAYING' && a?.playingDesde && a.cancion?.duracion) {
    const p = Math.min(1, Math.max(0, (t - a.playingDesde) / (a.cancion.duracion * 1000)));
    $('ahoraBarra').firstElementChild.style.width = `${p * 100}%`;
    $('cantaProgreso').style.width = `${p * 100}%`;
  }

  // turno: tiempo que queda para confirmar + respaldo desde el celu
  if (yo?.estado === 'CALLED' && est.etapa === 'CALLING' && a) {
    const total = Math.max(1, a.llamadoHasta - a.llamadoDesde);
    const resta = Math.max(0, a.llamadoHasta - t);
    $('turnoBarra').firstElementChild.style.width = `${(resta / total) * 100}%`;
    // LISTO solo cuando el audio REALMENTE esta listo (existe + cargo + se puede reproducir)
    const au = yo.audio?.estado;
    const btn = $('btnListo');
    btn.hidden = false;
    btn.disabled = au !== 'lista' || !yo.cancionId;
    btn.textContent = !yo.cancionId
      ? '🎵 Elegí una canción'
      : au === 'lista'
        ? '▶ ¡LISTO!'
        : au === 'error'
          ? '⚠️ Reintentá o elegí otra canción'
          : au === 'bloqueado'
            ? '🔇 Esperando el sonido de la pantalla'
            : '⏳ Preparando el audio…';
  } else {
    $('btnListo').hidden = true;
  }

  if (yo?.estado === 'QUEUED') $('filaEta').textContent = etaTexto(yo.etaSeg, yo.esSiguiente);
}
setInterval(refrescarTimers, 500);

// -------------------------------------------------------------- wake lock
let wakeLock = null;
async function pantallaEncendida(quiero) {
  try {
    if (quiero && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!quiero && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // al volver del bloqueo el socket pudo cortarse: re-saludamos y re-pedimos el lock
    if (socket.connected) saludar(); else socket.connect();
    render();
  }
});

// ---------------------------------------------------------------- canciones
buscador.iniciar(); // arranca con la biblioteca local (lo que se puede cantar ya)
