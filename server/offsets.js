// Desfase de la letra por cancion: cuanto hay que atrasar (+) o adelantar (-) la letra para que
// caiga con la voz del video. Se guarda en un archivo para que el ajuste que hizo alguien una vez
// valga para todas las pantallas y las veces siguientes (los videos de karaoke tienen intros distintas).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_OFFSET_S = 60;

export function normalizarOffset(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(-MAX_OFFSET_S, Math.min(MAX_OFFSET_S, n)) * 10) / 10;
}

export function crearOffsets({ archivo, log = () => {}, demoraMs = 400 } = {}) {
  let datos = {};
  try {
    const crudo = JSON.parse(readFileSync(archivo, 'utf8'));
    for (const [k, v] of Object.entries(crudo || {})) {
      const n = normalizarOffset(v);
      if (n !== null) datos[k] = n;
    }
  } catch {
    // primer arranque o archivo ilegible: se empieza vacio
  }
  let timer = null;
  function guardar() {
    timer = null;
    try {
      mkdirSync(dirname(archivo), { recursive: true });
      writeFileSync(archivo, JSON.stringify(datos, null, 1));
    } catch (e) {
      log(`[offsets] no se pudo guardar: ${e.message}`);
    }
  }
  return {
    get: (id) => (Object.hasOwn(datos, id) ? datos[id] : null),
    set(id, valor) {
      const n = normalizarOffset(valor);
      if (n === null || !/^[A-Za-z0-9_-]{1,60}$/.test(String(id))) return null;
      datos[id] = n;
      if (!timer) timer = setTimeout(guardar, demoraMs);
      return n;
    },
    guardarAhora() {
      if (timer) clearTimeout(timer);
      guardar();
    },
    todos: () => ({ ...datos }),
  };
}
