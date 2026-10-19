// Almacen clave -> objeto JSON en un archivo (con escritura diferida). Guarda, por ejemplo, que video
// se eligio para cada cancion: asi un reinicio del server no vuelve a gastar cuota de YouTube.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function crearAlmacen({ archivo, log = () => {}, demoraMs = 400, max = 2000 } = {}) {
  let datos = {};
  try {
    const crudo = JSON.parse(readFileSync(archivo, 'utf8'));
    if (crudo && typeof crudo === 'object' && !Array.isArray(crudo)) datos = crudo;
  } catch {
    // primer arranque o archivo ilegible: se empieza vacio
  }
  let timer = null;
  function guardar() {
    timer = null;
    try {
      mkdirSync(dirname(archivo), { recursive: true });
      writeFileSync(archivo, JSON.stringify(datos));
    } catch (e) {
      log(`[almacen] no se pudo guardar: ${e.message}`);
    }
  }
  const programar = () => { if (!timer) timer = setTimeout(guardar, demoraMs); };
  return {
    get: (k) => (Object.hasOwn(datos, k) ? datos[k] : null),
    set(k, v) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(k))) return;
      datos[k] = v;
      const claves = Object.keys(datos);
      if (claves.length > max) delete datos[claves[0]];
      programar();
    },
    delete(k) { if (Object.hasOwn(datos, k)) { delete datos[k]; programar(); } },
    guardarAhora() { if (timer) clearTimeout(timer); guardar(); },
  };
}
