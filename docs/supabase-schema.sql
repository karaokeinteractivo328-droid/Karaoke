-- Tablas para puntajes/leaderboard y resumen de reacciones.
-- Correr una sola vez en Supabase: Dashboard -> SQL Editor -> New query -> pegar y Run.

create table if not exists puntajes (
  id uuid primary key default gen_random_uuid(),
  sesion_id text,
  nombre text,
  iniciales text,
  puntaje int,
  cancion_titulo text,
  cancion_artista text,
  creado_en timestamptz default now()
);

create table if not exists reacciones_resumen (
  sesion_id text primary key,
  corazon int default 0,
  fuego int default 0,
  aplausos int default 0,
  risa int default 0,
  estrella int default 0
);

-- El server escribe con la service_role key, que se salta RLS por diseño,
-- asi que no hace falta ninguna policy para que esto funcione.
