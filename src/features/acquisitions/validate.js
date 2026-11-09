const { searchBiblios, getItems, isConfigured } = require('../../integrations/koha/client');

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function compactIdentifier(value) {
  return String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
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
  const reqAuthor = fold(request.author);
  const recAuthor = fold(record.author);
  const reqId = compactIdentifier(request.identifier);
  const recId = compactIdentifier(record.isbn);

  const identifierExact = Boolean(reqId && recId && reqId === recId);
  const titleExact = Boolean(reqTitle && recTitle && reqTitle === recTitle);
  const titleSimilar = Boolean(reqTitle && recTitle && (
    reqTitle.includes(recTitle) || recTitle.includes(reqTitle) ||
    reqTitle.split(' ').filter(word => word.length > 2 && recTitle.includes(word)).length >= Math.min(3, reqTitle.split(' ').length)
  ));
  const authorSimilar = Boolean(reqAuthor && recAuthor && (
    reqAuthor === recAuthor || reqAuthor.includes(recAuthor) || recAuthor.includes(reqAuthor)
  ));

  let level = 'possible_match';
  if (identifierExact || (titleExact && (!reqAuthor || authorSimilar))) level = 'exact_match';
  else if (!titleSimilar && !authorSimilar) return null;

  return {
    level,
    score: identifierExact ? 100 : titleExact && authorSimilar ? 95 : titleExact ? 85 : titleSimilar && authorSimilar ? 75 : titleSimilar ? 60 : 40,
    identifierExact,
    titleExact,
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

async function validateBookAgainstCatalog(config, book) {
  if (!isConfigured(config.koha)) {
    return {
      status: 'pending',
      catalog_checked: false,
      matches: [],
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
      matches: withHoldings.map(record => ({
        biblio_id: record.biblioId,
        title: record.title,
        author: record.author,
        isbn: record.isbn,
        publisher: record.publisher,
        edition: record.edition,
        year: record.year,
        url: record.url,
        match: record.match,
        holdings: (record.items || []).map(item => ({
          campus: item.campus,
          branch_code: item.branchCode,
          location: item.location,
          callnumber: item.callnumber,
          status: item.status
        })),
        holdings_unavailable: Boolean(record.itemsUnavailable)
      }))
    };
  } catch (error) {
    return {
      status: 'pending',
      catalog_checked: false,
      matches: [],
      message: 'No fue posible completar la consulta a Koha. La solicitud requiere validación posterior.',
      catalog_error: error?.code || 'koha_error'
    };
  }
}

module.exports = { validateBookAgainstCatalog, identifierStatus, validIsbn, validIssn, scoreMatch };
