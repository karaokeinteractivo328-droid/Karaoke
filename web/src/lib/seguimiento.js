// TRACKING de manos: "donde estan las manos", y nada mas.
//
// vision.js (MediaPipe) entrega detecciones crudas frame a frame. Esas
// detecciones NO tienen identidad: MediaPipe puede etiquetar las dos manos
// como "Right", perder una por un frame o duplicar una misma mano. Si los
// gestos consumieran eso directo, todo parpadearia.
//
// Este modulo las convierte en TRACKS estables:
//   - cada mano tiene un `id` que persiste mientras se la siga viendo
//     (se asocian por cercania entre frames, no por la etiqueta Left/Right)
//   - un filtro One Euro por TRACK (antes era por etiqueta: dos manos con la
//     misma etiqueta compartian filtro y se mezclaban)
//   - una mano perdida se conserva `graciaMs` (marcada `perdida`), asi un frame
//     sin deteccion no corta un gesto
//   - se descartan detecciones duplicadas de una misma mano
//   - lado izq/der por posicion, con histeresis (no salta en el centro)
//   - historial corto del centro de la palma (para detectar el saludo)
//
// Es puro (sin DOM ni MediaPipe): se prueba en web/test/.

import { crearFiltroMano } from './oneEuro.js';

const PALMA = [0, 5, 9, 13, 17]; // muneca + base de los 4 dedos

export function centroPalma(puntos) {
  let x = 0;
  let y = 0;
  for (const i of PALMA) {
    x += puntos[i].x;
    y += puntos[i].y;
  }
  return { x: x / PALMA.length, y: y / PALMA.length };
}

export function crearSeguimiento({
  graciaMs = 250, // cuanto se conserva una mano que dejo de detectarse
  distMax = 0.22, // distancia maxima (0..1) para considerar que es la misma mano
  distDuplicada = 0.05, // dos detecciones mas cerca que esto son la misma mano
  historialMs = 1200,
} = {}) {
  let tracks = [];
  let siguienteId = 1;

  function nuevoTrack(det, ts) {
    const filtro = crearFiltroMano();
    const puntos = filtro(det.puntos, ts);
    const centro = centroPalma(puntos);
    return {
      id: siguienteId++,
      filtro,
      puntos,
      centro,
      lado: centro.x < 0.5 ? 'izq' : 'der',
      perdida: false,
      creado: ts,
      ultimoVisto: ts,
      v: { x: 0, y: 0 },
      hist: [{ t: ts, x: centro.x, y: centro.y }],
    };
  }

  function actualizarTrack(tr, det, ts) {
    const dt = Math.max(0.001, (ts - tr.ultimoVisto) / 1000);
    tr.puntos = tr.filtro(det.puntos, ts);
    const c = centroPalma(tr.puntos);
    tr.v = { x: (c.x - tr.centro.x) / dt, y: (c.y - tr.centro.y) / dt };
    tr.centro = c;
    tr.perdida = false;
    tr.ultimoVisto = ts;
    // histeresis: no cambia de lado por cruzar apenas el medio
    if (tr.lado === 'izq' && c.x > 0.55) tr.lado = 'der';
    else if (tr.lado === 'der' && c.x < 0.45) tr.lado = 'izq';
    tr.hist.push({ t: ts, x: c.x, y: c.y });
    while (tr.hist.length && ts - tr.hist[0].t > historialMs) tr.hist.shift();
  }

  // detecciones: [{ puntos: [{x,y,z} x21] (ya espejadas en x), puntaje? }]
  function actualizar(detecciones = [], ts = performance.now()) {
    // 1) una sola deteccion por mano real
    const dets = [];
    for (const d of [...detecciones].sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0))) {
      if (!d?.puntos || d.puntos.length < 21) continue;
      const c = centroPalma(d.puntos);
      if (dets.some((o) => Math.hypot(o.c.x - c.x, o.c.y - c.y) < distDuplicada)) continue;
      dets.push({ ...d, c });
    }

    // 2) asociar con los tracks existentes: pares mas cercanos primero
    const pares = [];
    for (const tr of tracks) {
      for (let j = 0; j < dets.length; j++) {
        const d = Math.hypot(tr.centro.x - dets[j].c.x, tr.centro.y - dets[j].c.y);
        // una mano rapida puede recorrer mas entre frames
        const tope = distMax + Math.min(0.2, Math.hypot(tr.v.x, tr.v.y) * 0.05);
        if (d <= tope) pares.push({ tr, j, d });
      }
    }
    pares.sort((a, b) => a.d - b.d);
    const trUsados = new Set();
    const detUsadas = new Set();
    for (const { tr, j } of pares) {
      if (trUsados.has(tr) || detUsadas.has(j)) continue;
      trUsados.add(tr);
      detUsadas.add(j);
      actualizarTrack(tr, dets[j], ts);
    }

    // 3) detecciones sin track -> mano nueva
    dets.forEach((d, j) => {
      if (!detUsadas.has(j)) tracks.push(nuevoTrack(d, ts));
    });

    // 4) tracks sin deteccion: se conservan un rato (perdidos) y despues se van
    for (const tr of tracks) {
      if (tr.ultimoVisto !== ts) tr.perdida = true;
    }
    tracks = tracks.filter((tr) => ts - tr.ultimoVisto <= graciaMs);

    return tracks;
  }

  return {
    actualizar,
    reiniciar() {
      tracks = [];
    },
    get tracks() {
      return tracks;
    },
  };
}
