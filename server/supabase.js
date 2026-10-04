// Cliente de Supabase para guardar puntajes/reacciones. Todas las escrituras
// pasan por el server (nunca desde el navegador) para no exponer la key.
// Sin las variables de entorno seteadas, queda desactivado sin romper nada
// (el resto de la app sigue andando igual, sólo no persiste puntajes).

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = url && key ? createClient(url, key) : null;

if (!supabase) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configuradas: no se van a guardar puntajes ni reacciones.');
}

// Iniciales estilo arcade derivadas del nombre (sin pedirle nada a la gente):
// las primeras 3 letras en mayuscula, o "VOS" si canto en modo libre sin nombre.
export function iniciales(nombre) {
  const limpio = String(nombre ?? '').trim().toUpperCase().replace(/[^A-ZÑÁÉÍÓÚ]/g, '');
  return (limpio.slice(0, 3) || 'VOS').padEnd(3, '·');
}

// Si no hay Internet (o Supabase falla), no se pierde el puntaje: queda en un
// buffer en memoria y se reintenta cada minuto (hasta 50 pendientes).
const pendientes = [];

async function intentarGuardar(datos) {
  const { sesionId, nombre, puntaje, cancion, reacciones } = datos;
  if (!datos.puntajeGuardado) {
    const p = await supabase.from('puntajes').insert({
      sesion_id: sesionId,
      nombre: nombre || null,
      iniciales: iniciales(nombre),
      puntaje,
      cancion_titulo: cancion?.titulo ?? null,
      cancion_artista: cancion?.artista ?? null,
    });
    if (p.error) throw new Error(p.error.message);
    datos.puntajeGuardado = true; // si falla lo de abajo, el reintento no duplica la fila
  }
  if (reacciones && Object.keys(reacciones).length) {
    const r = await supabase.from('reacciones_resumen').insert({
      sesion_id: sesionId,
      corazon: reacciones['❤️'] || 0,
      fuego: reacciones['🔥'] || 0,
      aplausos: reacciones['👏'] || 0,
      risa: reacciones['😂'] || 0,
      estrella: reacciones['⭐'] || 0,
    });
    if (r.error) throw new Error(r.error.message);
  }
}

export async function guardarPuntaje(datos) {
  if (!supabase) return;
  try {
    await intentarGuardar(datos);
  } catch (e) {
    console.warn('[supabase] no se pudo guardar, queda pendiente:', e.message);
    if (pendientes.length < 50) pendientes.push(datos);
  }
}

if (supabase) {
  setInterval(async () => {
    const lote = pendientes.splice(0, pendientes.length);
    for (const d of lote) {
      try {
        await intentarGuardar(d);
      } catch {
        pendientes.push(d);
      }
    }
  }, 60_000).unref();
}

export async function obtenerLeaderboard(limite = 10) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('puntajes')
      .select('iniciales, puntaje, cancion_titulo, cancion_artista, creado_en')
      .order('puntaje', { ascending: false })
      .limit(limite);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[supabase] error leyendo leaderboard:', e.message);
    return [];
  }
}
