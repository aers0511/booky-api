const { searchBiblios, getItems, isConfigured } = require('../../integrations/koha/client');

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function compactIdentifier(value) {
  return String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
}

function meaningfulTokens(value) {
  const ignored = new Set(['a', 'an', 'and', 'de', 'del', 'la', 'las', 'el', 'los', 'y', 'the', 'of']);
  return [...new Set(fold(value).split(' ').filter(token => token.length > 1 && !ignored.has(token)))];
}

function overlapRatio(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter(token => rightSet.has(token)).length;
  return overlap / Math.min(left.length, right.length);
}

function validIsbn(value) {
  const id = compactIdentifier(value);
  if (/^\d{13}$/.test(id)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(id[i]) * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === Number(id[12]);
  }
  if (/^\d{9}[\dX]$/.test(id)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (id[i] === 'X' ? 10 : Number(id[i]));
    return sum % 11 === 0;
  }
  return false;
}

function validIssn(value) {
  const id = compactIdentifier(value);
  if (!/^\d{7}[\dX]$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(id[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? 'X' : String(check)) === id[7];
}

function identifierStatus(book) {
  const id = compactIdentifier(book.identifier);
  if (!id) return { value: null, type: book.identifier_type || 'UNKNOWN' };
  const type = book.identifier_type === 'ISSN' || (!book.identifier_type || book.identifier_type === 'UNKNOWN') && id.length <= 8
    ? 'ISSN' : 'ISBN';
  return {
    value: type === 'ISSN' ? validIssn(id) : validIsbn(id),
    type
  };
}

function scoreMatch(request, record) {
  const reqTitle = fold(request.title);
  const recTitle = fold(record.title);
  const reqTitleTokens = meaningfulTokens(request.title);
  const recTitleTokens = meaningfulTokens(record.title);
  const reqAuthorTokens = meaningfulTokens(request.author);
  const recAuthorTokens = meaningfulTokens(record.author);
  const reqId = compactIdentifier(request.identifier);
  const recId = compactIdentifier(record.isbn);

  const identifierExact = Boolean(reqId && recId && reqId === recId);
  const titleExact = Boolean(reqTitle && recTitle && reqTitle === recTitle);
  const titleOverlap = overlapRatio(reqTitleTokens, recTitleTokens);
  const titleSimilar = Boolean(titleOverlap >= 0.75);
  const authorOverlap = overlapRatio(reqAuthorTokens, recAuthorTokens);
  const authorSimilar = Boolean(
    reqAuthorTokens.length && recAuthorTokens.length && authorOverlap >= 0.6
  );

  if (!identifierExact && !titleSimilar) return null;

  // Un título idéntico sin autor coincidente no se declara exacto:
  // puede tratarse de otra obra con el mismo título.
  const exact = identifierExact || (titleExact && authorSimilar);
  const score = identifierExact ? 100
    : exact ? 97
    : titleExact && !reqAuthorTokens.length ? 90
    : titleExact ? 84
    : titleSimilar && authorSimilar ? 78
    : titleSimilar ? 62 : 0;

  return {
    level: exact ? 'exact_match' : 'possible_match',
    score,
    identifierExact,
    titleExact,
    titleSimilar,
    authorSimilar
  };
}

function dedupeRecords(records) {
  const map = new Map();
  for (const record of records) {
    const key = String(record.biblioId || `${fold(record.title)}|${fold(record.author)}`);
    if (!map.has(key)) map.set(key, record);
  }
  return [...map.values()];
}

/**
 * Consolida los ejemplares por biblioteca, ubicación, clasificación y estado.
 * No elimina ejemplares repetidos: los cuenta en quantity.
 */
function summarizeHoldings(items = []) {
  const groups = new Map();

  for (const item of items) {
    const normalized = {
      campus: item.campus || 'Ubicación no indicada',
      branch_code: item.branchCode || null,
      location: item.location || null,
      callnumber: item.callnumber || null,
      status: item.status || 'Estado no informado'
    };
    const key = [
      normalized.branch_code || normalized.campus,
      normalized.location || '',
      normalized.callnumber || '',
      normalized.status
    ].join('|');

    const current = groups.get(key);
    if (current) current.quantity += 1;
    else groups.set(key, { ...normalized, quantity: 1 });
  }

  return [...groups.values()].sort((a, b) =>
    String(a.campus).localeCompare(String(b.campus), 'es') ||
    String(a.status).localeCompare(String(b.status), 'es')
  );
}

async function validateBookAgainstCatalog(config, book) {
  if (!isConfigured(config.koha)) {
    return {
      status: 'pending',
      catalog_checked: false,
      matches: [],
      matches_found: 0,
      message: 'La conexión con el catálogo Koha no está configurada.'
    };
  }

  const queries = [];
  if (book.identifier) queries.push(book.identifier);
  if (book.title) queries.push(book.title);
  const results = [];

  try {
    // Sin filtro de sucursal: consulta el catálogo bibliográfico completo de ITSON.
    const kohaConfig = {
      ...config.koha,
      maxResults: config.acquisitions?.maxResults || 10
    };
    const searches = await Promise.all(
      [...new Set(queries)].map(query => searchBiblios(kohaConfig, query, { includeItems: false }))
    );
    searches.forEach(search => results.push(...search.results));

    const ranked = dedupeRecords(results)
      .map(record => {
        const match = scoreMatch(book, record);
        return match ? { ...record, match } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.match.score - a.match.score);

    // Recupera ejemplares solo para las coincidencias más relevantes.
    const withHoldings = await Promise.all(ranked.slice(0, 5).map(async record => {
      try {
        const items = await getItems(kohaConfig, record.biblioId);
        return { ...record, items };
      } catch {
        return { ...record, items: [], itemsUnavailable: true };
      }
    }));

    const idCheck = identifierStatus(book);
    return {
      status: ranked.some(item => item.match.level === 'exact_match')
        ? 'exact_match'
        : ranked.length ? 'possible_match' : 'not_found',
      catalog_checked: true,
      identifier_validation: idCheck,
      matches_found: ranked.length,
      matches: withHoldings.map(record => {
        const holdings = summarizeHoldings(record.items || []);
        return {
          biblio_id: record.biblioId,
          title: record.title,
          author: record.author,
          isbn: record.isbn,
          publisher: record.publisher,
          edition: record.edition,
          year: record.year,
          url: record.url,
          match: record.match,
          total_items: (record.items || []).length,
          holdings,
          holdings_unavailable: Boolean(record.itemsUnavailable)
        };
      })
    };
  } catch (error) {
    return {
      status: 'pending',
      catalog_checked: false,
      matches: [],
      matches_found: 0,
      message: 'No fue posible completar la consulta a Koha. La solicitud requiere validación posterior.',
      catalog_error: error?.code || 'koha_error'
    };
  }
}

module.exports = {
  validateBookAgainstCatalog,
  identifierStatus,
  validIsbn,
  validIssn,
  scoreMatch,
  summarizeHoldings
};
