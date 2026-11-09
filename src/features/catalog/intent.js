const NEGATIVE_PATTERNS = [
  /\b(c[oó]mo\s+(puedo\s+)?buscar|d[oó]nde\s+(puedo\s+)?buscar|ens[eéñ]ame\s+a\s+buscar|expl[ií]came\s+c[oó]mo\s+buscar)\b/i
];

const SEARCH_PATTERNS = [
  /\b(?:busca(?:r|me)?|encuentra(?:me)?|localiza(?:me)?|consulta(?:r)?|necesito|quiero|tienen|tienes|hay|cuentan\s+con|manejan|recomi[eé]ndame)\b.{0,90}?\b(?:libros?|material(?:es)?|t[ií]tulos?|obras?|tesis|revistas?|art[ií]culos?|recursos?)\b(?:\s+(?:sobre|de|acerca\s+de|relacionad[oa]s?\s+con|del\s+tema))?\s+(.+)/i,
  /\b(?:libros?|material(?:es)?|tesis|art[ií]culos?|revistas?)\s+(?:sobre|de|acerca\s+de)\s+(.+)/i,
  /\b(?:ISBN|autor(?:a)?|t[ií]tulo)\s*[:=]\s*(.+)/i,
  /\b(?:busco|ando\s+buscando)\s+(.+)/i
];

// Códigos de sucursal utilizados por Bibliotecas ITSON.
const CAMPUSES = [
  { code: 'NAI', label: 'Obregón Náinari', aliases: ['nainari', 'náinari', 'campus nainari', 'campus náinari', 'obregon nainari', 'obregón náinari'] },
  { code: 'CEN', label: 'Obregón Centro', aliases: ['campus centro', 'sede centro', 'obregon centro', 'obregón centro', 'centro'] },
  { code: 'GYM', label: 'Guaymas', aliases: ['campus guaymas', 'guaymas'] },
  { code: 'EMPL', label: 'Empalme', aliases: ['campus empalme', 'empalme'] },
  { code: 'NAV', label: 'Navojoa', aliases: ['campus navojoa', 'navojoa'] },
  { code: 'BV', label: 'Biblioteca Virtual', aliases: ['biblioteca virtual', 'biblioteca digital', 'recursos virtuales'] }
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function cleanQuery(value) {
  return String(value || '')
    .replace(/^[\s:¿¡"'“”]+/, '')
    .replace(/[?!. ,"'“”]+$/g, '')
    .replace(/\b(por favor|porfa|gracias)\b/ig, '')
    .trim()
    .slice(0, 120);
}

function detectCampus(message) {
  const normalized = normalizeText(message).replace(/[¿?¡!.,;:]/g, '').trim();

  if (/\b(todos?\s+(?:los\s+)?campus(?:es)?|todas?\s+las\s+sedes|cualquier\s+campus|cualquiera|en\s+general)\b/.test(normalized)) {
    return { all: true, code: null, label: 'Todos los campus' };
  }

  // Permite responder con el número mostrado en la pregunta de aclaración.
  const numeric = normalized.match(/^\s*([1-6])\s*[.!)]?\s*$/);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    if (index === 5) return { all: true, code: null, label: 'Todos los campus' };
    const campus = CAMPUSES[index];
    return { all: false, code: campus.code, label: campus.label };
  }

  for (const campus of CAMPUSES) {
    for (const alias of campus.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exactReply = normalized === alias;
      const explicitLocation = new RegExp(`\\b(?:en|campus|sede)\\s+${escaped}(?:$|\\b)`, 'i').test(normalized);
      const explicitObregon = /\b(?:en|campus|sede)\s+obregon\s+(?:nainari|centro)\b/i.test(normalized) && campus.code === (normalized.includes('nainari') ? 'NAI' : 'CEN');
      if (exactReply || explicitLocation || explicitObregon) {
        return { all: false, code: campus.code, label: campus.label };
      }
    }
  }

  // "En Obregón" no identifica si se refiere a Náinari o Centro.
  if (/\b(?:en|campus|sede)\s+obregon\b/.test(normalized)) return { ambiguous: true };
  return null;
}

function removeCampusFromQuery(query, campus) {
  let result = String(query || '');
  if (campus && !campus.all) {
    const entry = CAMPUSES.find(item => item.code === campus.code);
    const aliases = entry ? entry.aliases : [];
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\s*(?:en|del?|campus|sede)?\\s*${escaped}\\s*`, 'ig'), ' ');
    }
  }
  result = result
    .replace(/\b(?:en\s+)?todos?\s+(?:los\s+)?campus(?:es)?\b/ig, ' ')
    .replace(/\b(?:en\s+)?todas?\s+las\s+sedes\b/ig, ' ')
    .replace(/\b(?:en\s+)?cualquier\s+campus\b/ig, ' ')
    .replace(/\s+\b(?:en|del|de|campus|sede)\s*$/i, '')
    .replace(/\s+/g, ' ');
  return cleanQuery(result);
}

function detectCatalogSearch(message) {
  const text = String(message || '').trim();
  if (!text || NEGATIVE_PATTERNS.some(pattern => pattern.test(text))) return null;

  const campus = detectCampus(text);
  for (const pattern of SEARCH_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const query = removeCampusFromQuery(cleanQuery(match[1]), campus);
      if (query.length >= 2) {
        return {
          type: 'catalog_search',
          query,
          campus: campus && !campus.ambiguous ? campus : null,
          needsCampus: !campus || Boolean(campus.ambiguous)
        };
      }
    }
  }

  return null;
}

function textOf(content) {
  return (content?.parts || [])
    .map(part => typeof part.text === 'string' ? part.text : '')
    .join('\n')
    .trim();
}

/**
 * Reconstruye una búsqueda pendiente usando el historial enviado por el OPAC.
 * No requiere base de datos ni memoria global: la conversación conserva el estado.
 */
function detectCampusFollowUp(history, currentMessage) {
  const currentCampus = detectCampus(currentMessage);
  if (!currentCampus) return null;

  const contents = Array.isArray(history) ? history : [];
  let lastModelIndex = -1;
  for (let i = contents.length - 2; i >= 0; i--) {
    if (contents[i]?.role === 'model') {
      lastModelIndex = i;
      break;
    }
  }
  if (lastModelIndex < 1) return null;

  const clarification = textOf(contents[lastModelIndex]);
  if (!/¿en qué campus quieres consultar\?/i.test(clarification)) return null;

  let previousUser = null;
  for (let i = lastModelIndex - 1; i >= 0; i--) {
    if (contents[i]?.role === 'user') {
      previousUser = textOf(contents[i]);
      break;
    }
  }
  if (!previousUser) return null;

  const originalIntent = detectCatalogSearch(previousUser);
  if (!originalIntent) return null;

  return {
    type: 'catalog_search',
    query: originalIntent.query,
    campus: currentCampus,
    needsCampus: false,
    resumed: true
  };
}

function detectCatalogIntent({ message, history }) {
  return detectCampusFollowUp(history, message) || detectCatalogSearch(message);
}

module.exports = {
  CAMPUSES,
  normalizeText,
  detectCampus,
  detectCatalogSearch,
  detectCampusFollowUp,
  detectCatalogIntent
};
