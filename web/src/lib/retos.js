// Retos con las manos durante la canción. Cada tanto aparece un cartel; si lo
// cumplís antes de que se acabe el tiempo, sumás puntos. Alimenta el puntaje.
//
// Detectan sobre `datos` = { manos:[{puntos}], cantidadManos, corazon, pellizco }
// (lo que emite manos.js).

// --- helpers de pose de la mano ---
const dedoArriba = (p, tip, pip) => p[tip].y < p[pip].y - 0.02;
const muñecaArriba = (p, umbral = 0.5) => p[0].y < umbral;

function esPuño(p) {
  return ![[8, 6], [12, 10], [16, 14], [20, 18]].some(([t, i]) => dedoArriba(p, t, i));
}
function esPaz(p) {
  return dedoArriba(p, 8, 6) && dedoArriba(p, 12, 10) && !dedoArriba(p, 16, 14) && !dedoArriba(p, 20, 18);
}
function palmaAbierta(p) {
  return [[8, 6], [12, 10], [16, 14], [20, 18]].every(([t, i]) => dedoArriba(p, t, i));
}
function señalando(p) {
  return dedoArriba(p, 8, 6) && !dedoArriba(p, 12, 10) && !dedoArriba(p, 16, 14) && !dedoArriba(p, 20, 18);
}

export const RETOS = [
  { icono: '🙌', texto: 'Las dos manos arriba', dur: 5, puntos: 12,
    ok: (d) => {
      const arriba = (m) => muñecaArriba(m.puntos, 0.45);
      // con copiloto en cuadro (3+ manos), que sea de a uno por lado - si no,
      // cualquiera de sus dos manos alcanza (el caso de siempre, solo).
      if (d.cantidadManos >= 3) return (d.manosIzq || []).some(arriba) && (d.manosDer || []).some(arriba);
      return d.cantidadManos >= 2 && d.manos.every(arriba);
    } },
  { icono: '💖', texto: 'Hacé un corazón', dur: 6, puntos: 15,
    ok: (d) => d.corazon },
  { icono: '✊', texto: 'Puño bien alto', dur: 5, puntos: 10,
    ok: (d) => d.manos.some((m) => esPuño(m.puntos) && muñecaArriba(m.puntos, 0.45)) },
  { icono: '✌️', texto: 'Seña de paz', dur: 5, puntos: 10,
    ok: (d) => d.manos.some((m) => esPaz(m.puntos)) },
  { icono: '🖐️', texto: 'Saludá a la cámara', dur: 5, puntos: 8,
    ok: (d) => d.manos.some((m) => palmaAbierta(m.puntos) && muñecaArriba(m.puntos, 0.55)) },
  { icono: '👆', texto: 'Señalá al cielo', dur: 5, puntos: 8,
    ok: (d) => d.manos.some((m) => señalando(m.puntos) && m.puntos[8].y < 0.35) },
  // tipo:'palabra' es especial: pantalla.js tapa una palabra que viene en la
  // letra mientras este reto esta activo, y la destapa al pellizcar o cuando
  // llega su momento natural (ver taparPalabraProxima/destaparPalabra).
  { icono: '🫥', texto: 'Adiviná la palabra tapada (pellizcá)', dur: 6, puntos: 14, tipo: 'palabra',
    ok: (d) => d.pellizco },
];

// Máquina simple de retos para usar dentro del loop de PLAYING.
export function crearRetos({ onCartel, onResultado }) {
  let activo = null; // { reto, hasta }
  let proximo = 0;
  let usados = [];
  let puntaje = 0;

  function reset(ahora) {
    activo = null;
    usados = [];
    puntaje = 0;
    proximo = ahora + 12_000; // primer reto a los ~12s
    onCartel(null);
  }

  // llamar cada frame con el tiempo (ms) y los datos de manos
  function tick(ahora, datos) {
    if (activo) {
      if (datos && activo.reto.ok(datos)) {
        puntaje += activo.reto.puntos;
        onResultado({ ok: true, puntos: activo.reto.puntos });
        activo = null;
        proximo = ahora + 14_000 + Math.random() * 8_000;
        onCartel(null);
      } else if (ahora > activo.hasta) {
        onResultado({ ok: false, puntos: 0 });
        activo = null;
        proximo = ahora + 14_000 + Math.random() * 8_000;
        onCartel(null);
      } else {
        onCartel({
          ...activo.reto,
          resto: Math.max(0, (activo.hasta - ahora) / (activo.reto.dur * 1000)),
        });
      }
      return;
    }
    if (ahora >= proximo) {
      if (usados.length >= RETOS.length) usados = [];
      const cand = RETOS.filter((r) => !usados.includes(r));
      const reto = cand[Math.floor(Math.random() * cand.length)];
      usados.push(reto);
      activo = { reto, hasta: ahora + reto.dur * 1000 };
      onCartel({ ...reto, resto: 1 });
    }
  }

  return { reset, tick, get puntaje() { return puntaje; } };
}
