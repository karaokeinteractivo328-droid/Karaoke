// Vigila cuantos cuadros por segundo logra la pantalla y decide si hay que pasar al MODO LIVIANO.
//
// Proyectada en una tele o en una compu justa, la pantalla (camara a pantalla completa + efectos de mezcla +
// reconocimiento de manos + grabacion) puede no llegar a moverse fluida. En vez de que se vea "trabada",
// cuando detecta que va lento apaga lo que mas cuesta y que menos se nota (mezclas de color, el giro de la
// estrella) y espacia el reconocimiento de manos. Si despues la compu se recupera, vuelve al modo normal.
//
// Logica pura (el reloj lo da quien llama): se prueba sin navegador.

export function crearVigilante({
  ventanaMs = 3000, // cada cuanto se evalua
  lentoMs = 42, // cuadro promedio mas lento que esto (< ~24 fps) = va trabado
  rapidoMs = 24, // cuadro promedio mas rapido que esto (> ~40 fps) = anda holgado
  ventanasParaBajar = 2, // ventanas lentas SEGUIDAS para pasar a liviano (un tironcito aislado no cuenta)
  ventanasParaSubir = 3, // ventanas holgadas seguidas para volver a normal
  minLivianoMs = 45_000, // una vez en liviano se queda al menos esto (evita ir y venir)
  alCambiar = () => {},
} = {}) {
  let liviano = false;
  let desdeT = null;
  let anteriorT = null;
  let suma = 0;
  let n = 0;
  let lentas = 0;
  let holgadas = 0;
  let livianoDesde = 0;

  // `t` = marca de tiempo del cuadro (ms). Devuelve el modo actual.
  function cuadro(t, visible = true) {
    if (!visible) { // pestaña oculta / minimizada: el navegador frena los cuadros y no dice nada de la compu
      anteriorT = null; desdeT = null; suma = 0; n = 0;
      return liviano;
    }
    if (desdeT === null) desdeT = t;
    if (anteriorT !== null) {
      const d = t - anteriorT;
      if (d > 0 && d < 1000) { suma += d; n++; } // pausas largas (cambio de pestaña) no cuentan
    }
    anteriorT = t;
    if (t - desdeT >= ventanaMs) {
      const media = n ? suma / n : 0;
      suma = 0; n = 0; desdeT = t;
      if (media > lentoMs) { lentas++; holgadas = 0; }
      else if (media > 0 && media < rapidoMs) { holgadas++; lentas = 0; }
      else { lentas = 0; holgadas = 0; }
      if (!liviano && lentas >= ventanasParaBajar) {
        liviano = true; livianoDesde = t; lentas = 0;
        alCambiar(true, media);
      } else if (liviano && holgadas >= ventanasParaSubir && t - livianoDesde >= minLivianoMs) {
        liviano = false; holgadas = 0;
        alCambiar(false, media);
      }
    }
    return liviano;
  }

  return { cuadro, get liviano() { return liviano; } };
}
