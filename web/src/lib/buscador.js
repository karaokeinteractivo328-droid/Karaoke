// Buscador de canciones del celu: "🎵 ¿QUÉ QUERÉS CANTAR?".
//
// - DEBOUNCE: no se le pega a la API por cada tecla; se espera a que la persona deje de
//   escribir (350 ms) y recien ahi se consulta. La misma consulta dos veces no se repite.
// - Un pedido nuevo CANCELA el anterior (si se escribio mas, el resultado viejo ya no sirve).
// - Estados explicitos para que la interfaz nunca quede "colgada":
//     'cargando' | 'ok' | 'vacio' | 'error'
//   y `error` con boton de reintento.
// - PAGINACION con el `nextPageToken` (opaco) de YouTube: `masResultados()` agrega la pagina
//   siguiente (scroll infinito).
// - Consulta vacia = la biblioteca local (lo que se puede cantar ya).

export function crearBuscador({
  base = '',
  fetchFn = (...a) => globalThis.fetch(...a),
  debounceMs = 350,
  minimo = 2,
  onCambio = () => {},
} = {}) {
  let timer = null;
  let ctl = null;
  let generacion = 0;
  const st = { q: '', items: [], nextPageToken: null, hayMas: false, estado: 'cargando', error: null, errorCodigo: null, remoto: true, cargandoMas: false };

  const cambio = () => onCambio({ ...st, items: [...st.items] });

  async function pedir(q, pageToken, reemplazar) {
    ctl?.abort();
    ctl = new AbortController();
    const mia = ++generacion;
    if (reemplazar) {
      st.estado = 'cargando';
      st.error = null;
      st.errorCodigo = null;
      st.nextPageToken = null;
    } else {
      st.cargandoMas = true;
    }
    cambio();
    try {
      const url = `${base}/api/buscar?q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetchFn(url, { signal: ctl.signal });
      if (r.status === 429) throw new Error('Demasiadas búsquedas seguidas, esperá un segundo');
      if (!r.ok) throw new Error('No se pudo buscar');
      const j = await r.json();
      if (mia !== generacion) return; // llego tarde: ya hay una consulta mas nueva
      st.items = reemplazar ? j.items : [...st.items, ...j.items.filter((x) => !st.items.some((y) => y.id === x.id))];
      st.nextPageToken = j.nextPageToken || null;
      st.hayMas = !!j.nextPageToken;
      st.remoto = j.remoto !== false;
      // error parcial: hay resultados locales pero YouTube fallo (cuota, red, falta de clave...)
      st.error = j.error?.mensaje || null;
      st.errorCodigo = j.error?.codigo || null;
      st.estado = st.items.length ? 'ok' : j.error ? 'error' : 'vacio';
    } catch (e) {
      if (e.name === 'AbortError' || mia !== generacion) return;
      st.estado = reemplazar || !st.items.length ? 'error' : 'ok';
      st.error = String(e.message || 'No se pudo buscar');
      st.errorCodigo = 'red';
    } finally {
      if (mia === generacion) {
        st.cargandoMas = false;
        cambio();
      }
    }
  }

  function consultar(texto, { ya = false } = {}) {
    const q = String(texto ?? '').trim();
    clearTimeout(timer);
    if (q === st.q && st.estado !== 'error' && !ya && generacion > 0) return; // misma consulta: nada que hacer
    st.q = q;
    // una letra sola no justifica pegarle a la red: se espera a que haya algo para buscar
    if (q.length > 0 && q.length < minimo) {
      ctl?.abort();
      generacion++;
      st.estado = 'ok';
      st.error = null;
      cambio();
      return;
    }
    if (ya) return pedir(q, null, true);
    st.estado = 'cargando';
    cambio();
    timer = setTimeout(() => pedir(q, null, true), debounceMs);
  }

  return {
    consultar,
    iniciar: () => consultar('', { ya: true }),
    masResultados: () => {
      if (st.estado !== 'ok' || !st.hayMas || st.cargandoMas) return;
      return pedir(st.q, st.nextPageToken, false);
    },
    reintentar: () => pedir(st.q, null, true),
    get estado() {
      return { ...st, items: [...st.items] };
    },
    cancelar() {
      clearTimeout(timer);
      ctl?.abort();
    },
  };
}
