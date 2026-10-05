// Parser de archivos .lrc -> [{ tiempo: segundos, texto }]
export function parsearLRC(textoLRC) {
  const lineas = String(textoLRC).split(/\r?\n/);
  const resultado = [];
  const tiempoRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const linea of lineas) {
    tiempoRe.lastIndex = 0;
    const marcas = [...linea.matchAll(tiempoRe)];
    if (marcas.length === 0) continue; // metadata [ti:], [ar:], ...
    const texto = linea.replace(tiempoRe, '').trim();
    for (const m of marcas) {
      const min = parseInt(m[1], 10);
      const seg = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      resultado.push({ tiempo: min * 60 + seg + frac, texto });
    }
  }
  resultado.sort((a, b) => a.tiempo - b.tiempo);
  return resultado;
}

// Indice de la linea vigente para el tiempo t (-1 si aun no arranco).
export function indiceActual(letras, t) {
  let lo = 0;
  let hi = letras.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (letras[mid].tiempo <= t) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

// Tiempo en que empieza cada palabra de una linea. La letra del .lrc solo trae
// el comienzo de LINEA: se reparte por largo de palabra, pero la parte "cantada"
// no puede ser mas larga que lo que dura de verdad una linea (si despues hay un
// instrumental largo, las ultimas palabras no deben quedarse estiradas hasta
// la linea siguiente).
export function tiemposPalabras(texto, inicio, siguienteInicio) {
  const palabras = String(texto).split(/\s+/).filter(Boolean);
  if (!palabras.length) return [];
  const pesos = palabras.map((w) => Math.max(2, w.length));
  const total = pesos.reduce((a, b) => a + b, 0);
  const hueco = Number.isFinite(siguienteInicio) ? Math.max(0.6, siguienteInicio - inicio) : 4;
  const cantada = Math.min(hueco, total * 0.11 + 0.4); // ~9 letras por segundo cantando
  let acc = 0;
  return palabras.map((palabra, i) => {
    const t0 = inicio + (acc / total) * cantada;
    acc += pesos[i];
    return { palabra, t0 };
  });
}
