// Utilidades de texto compartidas (catalogo, puntuacion karaoke).

// minusculas, sin acentos, sin parentesis ni signos: para comparar titulos
export const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "PT3M45S" / "PT1H2M3S" -> segundos (la duracion que devuelve YouTube)
export function duracionISO(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

// YouTube devuelve entidades HTML en los titulos (&amp; &#39; ...)
export function decodificarHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
