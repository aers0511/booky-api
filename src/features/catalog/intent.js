const NEGATIVE_PATTERNS = [
  /\b(c[oó]mo\s+(puedo\s+)?buscar|d[oó]nde\s+(puedo\s+)?buscar|ens[eéñ]ame\s+a\s+buscar|expl[ií]came\s+c[oó]mo\s+buscar)\b/i
];

const SEARCH_PATTERNS = [
  /\b(?:busca(?:r|me)?|encuentra(?:me)?|localiza(?:me)?|consulta(?:r)?|necesito|quiero|tienen|tienes|hay|cuentan\s+con|manejan|recomi[eé]ndame)\b.{0,90}?\b(?:libros?|material(?:es)?|t[ií]tulos?|obras?|tesis|revistas?|art[ií]culos?|recursos?)\b(?:\s+(?:sobre|de|acerca\s+de|relacionad[oa]s?\s+con|del\s+tema))?\s+(.+)/i,
  /\b(?:libros?|material(?:es)?|tesis|art[ií]culos?|revistas?)\s+(?:sobre|de|acerca\s+de)\s+(.+)/i,
  /\b(?:ISBN|autor(?:a)?|t[ií]tulo)\s*[:=]\s*(.+)/i,
  /\b(?:busco|ando\s+buscando)\s+(.+)/i
];

function cleanQuery(value) {
  return String(value || '')
    .replace(/^[\s:¿¡"'“”]+/, '')
    .replace(/[?!.,"'“”]+$/g, '')
    .replace(/\b(por favor|porfa|gracias)\b/ig, '')
    .trim()
    .slice(0, 120);
}

function detectCatalogSearch(message) {
  const text = String(message || '').trim();
  if (!text || NEGATIVE_PATTERNS.some(pattern => pattern.test(text))) return null;

  for (const pattern of SEARCH_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const query = cleanQuery(match[1]);
      if (query.length >= 2) return { type: 'catalog_search', query };
    }
  }

  return null;
}

module.exports = { detectCatalogSearch };
