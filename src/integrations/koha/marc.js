/**
 * Utilidades puras (sin red ni estado) para interpretar registros MARC21.
 *
 * Responsabilidad única: convertir un MARCXML (o campos MARC ya estructurados)
 * en { place, publisher, year } sin inventar datos.
 *
 * Reglas de selección (de mayor a menor prioridad):
 *   0. 264 con 2.º indicador 1 (función de publicación) y 1.er indicador 3 (actual).
 *   1. 264 con 2.º indicador 1 y 1.er indicador en blanco u otro valor.
 *   2. 264 con 2.º indicador 1 y 1.er indicador 2 (editor intermedio).
 *   3. 260 (campo heredado de publicación).
 *   4. 264 sin 2.º indicador informado (último recurso).
 * Los 264 con 2.º indicador 0, 2, 3 o 4 (producción, distribución,
 * manufactura y copyright) nunca se usan como publicación.
 */

const EMPTY_PUBLICATION = Object.freeze({ place: '', publisher: '', year: '' });

// Valores que MARC/RDA usa cuando el dato NO se conoce: no son editoriales ni lugares.
const PLACEHOLDER_PATTERN = new RegExp(
  '^(?:s\\.?\\s?n\\.?|s\\.?\\s?l\\.?|sine nomine|sine loco|' +
  'publisher not identified|place of publication not identified|' +
  'editorial no identificada|lugar de publicaci[oó]n no identificado|' +
  'no identificad[oa])$',
  'i'
);

// Abreviaturas cuyo punto final forma parte del dato ("S.A.", "Inc.", "Ltd.").
const KEEP_TRAILING_DOT = /(?:\b(?:[A-Za-zÁÉÍÓÚÑáéíóúñ]\.){2,}|\b(?:Inc|Ltd|Ltda|Co|Corp|Cía|Hnos|Bros|Ed|Eds|Edit|Univ|Dept))\.$/;

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => safeCodePoint(Number(num)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // siempre al final para no decodificar dos veces
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Limpia un subcampo ISBD: espacios, corchetes de dato inferido y puntuación
 * final (" :", ",", ";", "/"). Devuelve '' si es un marcador de "no identificado".
 */
function cleanMarcText(value) {
  let text = decodeXmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

  text = text.replace(/[\[\]]/g, '').replace(/\?+\s*$/, '');
  text = text.replace(/[\s,;:/]+$/g, '').trim();
  if (text.endsWith('.') && !KEEP_TRAILING_DOT.test(text)) {
    text = text.slice(0, -1).trim();
  }
  text = text.replace(/^[\s,;:/]+/, '').trim();

  return PLACEHOLDER_PATTERN.test(text) ? '' : text;
}

function uniqueCleaned(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanMarcText(value);
    const key = text.toLocaleLowerCase('es');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/**
 * Extrae el primer año de PUBLICACIÓN de los subcampos $c.
 * Ignora fechas marcadas como copyright o fonograma (c2005, ©2005, ℗2005, cop. 2005).
 */
function extractPublicationYear(values) {
  const token = /(©|℗|\(c\)|\bcop(?:yright)?\.?|\bc|\bp)?\s*\[?\s*(\d{4})(?!\d)/gi;
  for (const value of values) {
    const text = decodeXmlEntities(value);
    for (const match of text.matchAll(token)) {
      if (match[1]) continue; // fecha con marca de copyright / fonograma
      return match[2];
    }
  }
  return '';
}

function buildCandidate({ tag, ind1, ind2, places, publishers, dates, order }) {
  const cleanPlaces = uniqueCleaned(places);
  const cleanPublishers = uniqueCleaned(publishers);
  const year = extractPublicationYear(dates);
  if (!cleanPlaces.length && !cleanPublishers.length && !year) return null;

  const first = String(ind1 ?? '').trim();
  const second = String(ind2 ?? '').trim();

  let priority;
  if (tag === '264') {
    if (second === '1') priority = first === '3' ? 0 : first === '2' ? 2 : 1;
    else if (second === '') priority = 4;
    else return null; // producción, distribución, manufactura o copyright
  } else if (tag === '260') {
    priority = 3;
  } else {
    return null;
  }

  return {
    priority,
    order,
    completeness: Number(cleanPlaces.length > 0) + Number(cleanPublishers.length > 0) + Number(Boolean(year)),
    place: cleanPlaces.join('; '),
    publisher: cleanPublishers.join('; '),
    year
  };
}

/** Elige el mejor candidato: prioridad, luego completitud y luego orden en el registro. */
function selectPublication(candidates) {
  const best = candidates
    .filter(Boolean)
    .sort((a, b) =>
      a.priority - b.priority ||
      b.completeness - a.completeness ||
      a.order - b.order
    )[0];

  return best
    ? { place: best.place, publisher: best.publisher, year: best.year }
    : { ...EMPTY_PUBLICATION };
}

// ---------------------------------------------------------------------------
// MARCXML
// ---------------------------------------------------------------------------

// El prefijo del espacio de nombres es opcional: <datafield>, <marc:datafield>, etc.
const NS = '(?:[\\w.-]+:)?';
const DATAFIELD_REGEX = new RegExp(`<${NS}datafield\\b([^>]*?)(?<!/)>([\\s\\S]*?)</${NS}datafield\\s*>`, 'g');
const SUBFIELD_REGEX = new RegExp(`<${NS}subfield\\b([^>]*?)(?<!/)>([\\s\\S]*?)</${NS}subfield\\s*>`, 'g');
const RECORD_REGEX = new RegExp(`<${NS}record\\b`, 'i');

function readAttribute(attributes, name) {
  const match = String(attributes).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? (match[1] ?? match[2] ?? '') : '';
}

function looksLikeMarcXml(xml) {
  return RECORD_REGEX.test(String(xml || ''));
}

function subfieldsOf(body) {
  const subfields = [];
  for (const match of String(body).matchAll(SUBFIELD_REGEX)) {
    subfields.push({ code: readAttribute(match[1], 'code').toLowerCase(), value: match[2] });
  }
  return subfields;
}

/**
 * Extrae { place, publisher, year } de un MARCXML.
 * Si el documento trae varios <record> (p. ej. <collection>), usa el primero.
 */
function parseMarcXmlPublication(xml) {
  let source = String(xml || '').replace(/^\uFEFF/, '');
  source = source.replace(/<!--[\s\S]*?-->/g, '');

  const recordEnd = source.search(new RegExp(`</${NS}record\\s*>`, 'i'));
  if (recordEnd >= 0) {
    source = source.slice(0, recordEnd);
  }

  const candidates = [];
  let order = 0;
  for (const match of source.matchAll(DATAFIELD_REGEX)) {
    const tag = readAttribute(match[1], 'tag');
    if (tag !== '264' && tag !== '260') continue;

    const subfields = subfieldsOf(match[2]);
    const valuesOf = code => subfields.filter(item => item.code === code).map(item => item.value);
    candidates.push(buildCandidate({
      tag,
      ind1: readAttribute(match[1], 'ind1'),
      ind2: readAttribute(match[1], 'ind2'),
      places: valuesOf('a'),
      publishers: valuesOf('b'),
      dates: valuesOf('c'),
      order: order++
    }));
  }

  return selectPublication(candidates);
}

module.exports = {
  EMPTY_PUBLICATION,
  cleanMarcText,
  extractPublicationYear,
  buildCandidate,
  selectPublication,
  looksLikeMarcXml,
  parseMarcXmlPublication
};
