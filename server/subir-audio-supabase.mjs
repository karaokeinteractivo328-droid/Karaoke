// Script de una sola vez: sube los .m4a de server/canciones/ a un bucket
// publico de Supabase Storage, asi el audio tambien funciona en la version
// online (Render nunca tuvo los .m4a porque .gitignore los excluye a
// proposito, para no subir musica con copyright a un repo publico).
import { createClient } from '@supabase/supabase-js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}
const supabase = createClient(url, key);
const BUCKET = 'canciones';
const CANCIONES_DIR = join(import.meta.dirname, 'canciones');

async function asegurarBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (buckets?.some((b) => b.name === BUCKET)) {
    console.log(`[bucket] "${BUCKET}" ya existe`);
    return;
  }
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error) throw error;
  console.log(`[bucket] "${BUCKET}" creado (publico)`);
}

async function subirCarpeta(id) {
  const dir = join(CANCIONES_DIR, id);
  const archivos = await readdir(dir).catch(() => []);
  const m4a = archivos.find((f) => f.endsWith('.m4a'));
  if (!m4a) { console.log(`[${id}] sin .m4a, salteado`); return null; }
  const buf = await readFile(join(dir, m4a));
  const destino = `${id}/${m4a}`;
  const { error } = await supabase.storage.from(BUCKET).upload(destino, buf, {
    contentType: 'audio/mp4',
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(destino);
  console.log(`[${id}] subido -> ${data.publicUrl}`);
  return data.publicUrl;
}

await asegurarBucket();
const ids = (await readdir(CANCIONES_DIR)).filter((f) => !f.includes('.'));
const resultado = {};
for (const id of ids) {
  const publicUrl = await subirCarpeta(id);
  if (publicUrl) resultado[id] = publicUrl;
}
console.log('\n--- URLs publicas (para pegar en canciones.json) ---');
console.log(JSON.stringify(resultado, null, 2));
