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

export async function guardarPuntaje({ sesionId, nombre, puntaje, cancion, reacciones }) {
  if (!supabase) return;
  try {
    await supabase.from('puntajes').insert({
      sesion_id: sesionId,
      nombre: nombre || null,
      iniciales: iniciales(nombre),
      puntaje,
      cancion_titulo: cancion?.titulo ?? null,
      cancion_artista: cancion?.artista ?? null,
    });
    if (reacciones && Object.keys(reacciones).length) {
      await supabase.from('reacciones_resumen').insert({
        sesion_id: sesionId,
        corazon: (reacciones['❤️'] || 0),
        fuego: (reacciones['🔥'] || 0),
        aplausos: (reacciones['👏'] || 0),
        risa: (reacciones['😂'] || 0),
        estrella: (reacciones['⭐'] || 0),
      });
    }
  } catch (e) {
    console.warn('[supabase] error guardando puntaje/reacciones:', e.message);
  }
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
