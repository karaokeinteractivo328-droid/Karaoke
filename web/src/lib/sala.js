// App del celular (/sala). Una sola pagina, una sola vista visible segun el
// rol de la persona en el escenario (PUBLIC / QUEUED / CALLED / SINGING /
// DONE / copiloto). Toda la logica vive en el server (server/escenario.js):
// aca solo se muestra lo que dicen `estado` (publico) y `yo` (privado) y se
// mandan intents tipados. La identidad es un token en localStorage, asi que
// cerrar el navegador, perder señal o reiniciar el server no hace perder el lugar.
import { conectar, SOCKET_URL } from './socket.js';

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
let canciones = [];
let modoPref = 'solo';
let filtro = '';
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
const socket = conectar('celu');

function intencion() {
  try { return JSON.parse(leer('karaoke:intencion') || 'null') || undefined; } catch { return undefined; }
}

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
  yo = m;
  if (m?.nombre) { nombre = m.nombre; guardar('karaoke:nombre', nombre); }
  recordarIntencion();
  render();
});
socket.on('reaccion', (r) => {
  if (r?.totales) { totales = { ...totales, ...r.totales }; pintarContadores(); }
});
socket.on('letra', (l) => {
  letra = l || { actual: '', siguiente: '' };
  pintarLetra();
});

// si el server se reinicia, el celu se vuelve a anotar solo con su cancion
function recordarIntencion() {
  const enFila = yo && (yo.estado === 'QUEUED' || yo.estado === 'CALLED');
  if (enFila) guardar('karaoke:intencion', JSON.stringify({ enFila: true, cancionId: yo.cancionId, modo: yo.modo }));
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

const cancionPorId = (id) => canciones.find((c) => c.id === id);
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
  const c = cancionPorId(yo.cancionId);
  $('filaCancion').textContent = c ? c.titulo : 'Todavía no elegiste';
  const box = $('boxCodigo');
  box.hidden = !yo.codigoCopiloto;
  if (yo.codigoCopiloto) {
    $('codigoCopiloto').textContent = yo.codigoCopiloto;
    $('copilotoEstado').textContent = yo.copiloto
      ? `${yo.copiloto.nombre} es tu copiloto 🤝`
      : 'Que escriba este código en su celu para ayudarte con la letra.';
  }
}

// ------------------------------------------------------------------ TURNO
function renderTurno() {
  if (!yo || yo.estado !== 'CALLED') return;
  const c = cancionPorId(yo.cancionId);
  const calling = est.etapa === 'CALLING';
  $('turnoTitulo').textContent = calling ? '¡Pasá al frente!' : 'Ya casi…';
  $('turnoCancion').textContent = c ? c.titulo : 'Elegí tu canción';
  $('turnoAyuda').textContent = !calling
    ? 'Esperá un momento, termina la canción anterior.'
    : !c
      ? 'Elegila acá abajo o con la mano en la pantalla.'
      : hayPantalla() && est.pantalla.camara
        ? '👋 Confirmala con la mano en la pantalla: subí o bajá la mano para moverte y juntá pulgar e índice un segundo.'
        : 'Tocá EMPEZAR para arrancar.';
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

function pintarLetra() {
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
  const link = $('resVideo');
  if (yo.videoToken) {
    link.href = `${SOCKET_URL}/video/${yo.videoToken}`;
    link.hidden = false;
    $('resVideoEstado').textContent = 'Es privado: solo lo ves con este link. Si todavía se está preparando, la página se actualiza sola. Se borra en 6 horas.';
  } else {
    link.hidden = true;
    $('resVideoEstado').textContent = 'Esta vez no hay video.';
  }
}

// --------------------------------------------------------------- COPILOTO
function renderCopiloto() {
  if (!yo?.copilotoDe) return;
  $('copiDe').textContent = `Ayudás a ${yo.copilotoDe.nombre}`;
  const e = yo.copilotoDe.estado;
  $('copiEstado').textContent =
    e === 'SINGING' ? 'Está cantando: acompañalo con la letra.' : e === 'QUEUED' ? 'Todavía está en la fila.' : 'Esperando su turno…';
}

// ------------------------------------------------------ selector de canciones
let firmaSelector = '';
function renderSelectores() {
  if (!yo) return;
  const f = filtro.trim().toLowerCase();
  const firma = `${yo.cancionId}|${yo.modo}|${modoPref}|${f}|${canciones.length}|${vistaPrevia}`;
  if (firma === firmaSelector) return;
  firmaSelector = firma;
  const modo = yo.estado === 'QUEUED' || yo.estado === 'CALLED' ? yo.modo || modoPref : modoPref;
  for (const box of document.querySelectorAll('[data-selector]')) {
    for (const b of box.querySelectorAll('.modo button')) b.classList.toggle('on', b.dataset.modo === modo);
    const ul = box.querySelector('.canciones');
    ul.textContent = '';
    for (const c of canciones) {
      if (f && !`${c.titulo} ${c.artista}`.toLowerCase().includes(f)) continue;
      const li = document.createElement('li');
      li.dataset.id = c.id;
      if (c.id === yo.cancionId) li.classList.add('elegida');
      li.textContent = c.titulo;
      const art = document.createElement('span');
      art.className = 'art';
      art.textContent = `${c.artista}${c.duracion ? ` · ${mmss(c.duracion)}` : ''}`;
      li.append(art);
      ul.append(li);
    }
  }
}

document.addEventListener('click', (e) => {
  const li = e.target.closest?.('.canciones li');
  if (li) {
    enviar('cancion:elegir', { cancionId: li.dataset.id, modo: yo?.modo || modoPref });
    return;
  }
  const mb = e.target.closest?.('.modo button');
  if (mb) {
    modoPref = mb.dataset.modo;
    if (yo?.cancionId) enviar('cancion:elegir', { cancionId: yo.cancionId, modo: modoPref });
    firmaSelector = '';
    renderSelectores();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('buscar')) {
    filtro = e.target.value;
    for (const i of document.querySelectorAll('.buscar')) if (i !== e.target) i.value = filtro;
    renderSelectores();
  }
});

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
  enviar('fila:entrar', { nombre: n }, (r) => { err.textContent = r.error; err.hidden = false; });
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
  if (n) enviar('fila:entrar', { nombre: n });
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
    const respaldo = !est.pantalla?.camara || !hayPantalla() || (yo.listoCeluDesde && t >= yo.listoCeluDesde);
    $('btnListo').hidden = !(respaldo && yo.cancionId);
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
(async function cargarCanciones() {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${SOCKET_URL}/api/canciones`);
      canciones = await r.json();
      firmaSelector = '';
      render();
      return;
    } catch {
      await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
    }
  }
})();
