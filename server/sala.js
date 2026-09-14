// La "sala": fila de espera (con turnos automáticos) + reacciones en vivo.
// Es un concepto aparte de la máquina de estados de la canción (stateMachine.js):
// esta lleva la cola de nombres, aquella lleva ESPERANDO->MODO->...->RESULTADO.
//
// Flujo:
//   1. alguien se anota desde el celu (anotarse) -> entra a la fila.
//   2. en ESPERANDO, si nadie fue "llamado" todavía, se llama al primero de
//      la fila (llamarSiguiente) -> aparece "¡Es tu turno, <nombre>!" en pantalla.
//   3. cuando esa persona levanta la mano (evento "presencia"), el server
//      llama a confirmarTurno(): ese nombre pasa a "cantando" durante toda
//      la performance.
//   4. al terminar (RESULTADO) o resetear, liberar() limpia "cantando" y
//      llama al siguiente de la fila automáticamente.
//
// Si nadie se anotó nunca, la fila queda vacía y todo funciona como antes
// (cualquiera levanta la mano y canta, sin nombre asociado).

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I, para que se lea facil
const MS_LLAMADO_TIMEOUT = 45_000; // si nadie confirma en este tiempo, se saltea

function generarCodigo(largo = 4) {
  let c = '';
  for (let i = 0; i < largo; i++) c += ABC[Math.floor(Math.random() * ABC.length)];
  return c;
}

export function crearSala({ onCambio } = {}) {
  const codigo = generarCodigo();
  let fila = []; // [{id, nombre}]
  let llamado = null; // {id, nombre} - el proximo en la fila, ya avisado en pantalla
  let cantando = null; // {id, nombre} - quien esta arriba del escenario ahora
  let timerLlamado = null;

  const emitir = () => onCambio && onCambio(snapshot());

  function snapshot() {
    return {
      codigo,
      fila: fila.map((p) => ({ id: p.id, nombre: p.nombre })),
      llamado: llamado ? { ...llamado } : null,
      cantando: cantando ? { ...cantando } : null,
    };
  }

  function anotarse(nombre) {
    const limpio = String(nombre ?? '').trim().slice(0, 24);
    if (!limpio) return { ok: false, error: 'Escribí tu nombre' };
    if (fila.length + (llamado ? 1 : 0) + (cantando ? 1 : 0) >= 60) {
      return { ok: false, error: 'La fila está llena, probá en un rato' };
    }
    const id = Math.random().toString(36).slice(2, 9);
    fila.push({ id, nombre: limpio });
    llamarSiguiente();
    emitir();
    return { ok: true, id, posicion: fila.length };
  }

  function llamarSiguiente() {
    clearTimeout(timerLlamado);
    if (llamado || cantando || !fila.length) return;
    llamado = fila.shift();
    timerLlamado = setTimeout(() => {
      llamado = null; // no aparecio: lo salteamos y probamos con el que sigue
      emitir();
      llamarSiguiente();
    }, MS_LLAMADO_TIMEOUT);
  }

  // Se llama cuando alguien confirma presencia (levanta la mano) en ESPERANDO.
  // Devuelve el nombre que queda "cantando" (o null si no habia nadie en fila).
  function confirmarTurno() {
    clearTimeout(timerLlamado);
    cantando = llamado;
    llamado = null;
    emitir();
    return cantando;
  }

  // Termino la cancion (o se reseteo a mitad de camino): libera el lugar y
  // llama automaticamente al siguiente de la fila.
  function liberar() {
    if (!cantando) return;
    cantando = null;
    llamarSiguiente();
    emitir();
  }

  function salir(id) {
    const antes = fila.length;
    fila = fila.filter((p) => p.id !== id);
    let cambio = fila.length !== antes;
    if (llamado?.id === id) {
      clearTimeout(timerLlamado);
      llamado = null;
      llamarSiguiente();
      cambio = true;
    }
    if (cambio) emitir();
  }

  llamarSiguiente(); // por si ya hay gente anotada de una sesion anterior

  return {
    snapshot,
    anotarse,
    confirmarTurno,
    liberar,
    salir,
    get codigo() { return codigo; },
  };
}
