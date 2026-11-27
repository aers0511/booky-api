const {
  cleanMarcText,
  buildCandidate,
  selectPublication,
  looksLikeMarcXml,
  parseMarcXmlPublication
} = require('./marc');

class KohaError extends Error {
  constructor(message, status = 502, code = 'koha_error') {
    super(message);
    this.name = 'KohaError';
    this.status = status;
    this.code = code;
  }
}

const MARCXML_ACCEPT = 'application/marcxml+xml';
const DEFAULT_MARC_CONCURRENCY = 4;
const DEFAULT_MARC_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h: el catálogo cambia poco
const DEFAULT_MARC_BUDGET_MS = 8000;
const MARC_FAILURE_TTL_MS = 60 * 1000; // evita reintentar de inmediato un registro que falló
const MARC_CACHE_MAX_ENTRIES = 500;

function isConfigured(config) {
  return Boolean(
    config.enabled &&
    config.baseUrl &&
    config.username &&
    config.password
  );
}

function buildAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function httpErrorMessage(status) {
  return status === 401 ? 'Koha rechazó las credenciales de consulta.' :
    status === 403 ? 'La cuenta de Koha no tiene permiso de catálogo.' :
    status === 404 ? 'No se encontró el endpoint solicitado en Koha.' :
    status === 400 ? 'Koha rechazó el formato de búsqueda.' :
    `Koha respondió HTTP ${status}.`;
}

/**
 * Petición GET autenticada a la API REST de Koha. Devuelve el cuerpo como texto
 * (fetch decodifica siempre como UTF-8) y traduce los fallos a KohaError.
 */
async function kohaRequest(config, path, { query = {}, accept = 'application/json', baseUrl } = {}) {
  const root = String(baseUrl || config.baseUrl).replace(/\/+$/, '');
  const url = new URL(
    `${root}${config.apiPath}${path.startsWith('/') ? path : '/' + path}`
  );

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': buildAuthHeader(config.username, config.password),
        'Accept': accept
      },
      signal: controller.signal
    });

    const bodyText = await response.text();

    if (!response.ok) {
      let errorCode = 'koha_http_error';
      try { errorCode = JSON.parse(bodyText)?.error_code || errorCode; } catch { /* cuerpo no JSON */ }
      throw new KohaError(httpErrorMessage(response.status), response.status, errorCode);
    }

    return bodyText;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new KohaError('La consulta al catálogo agotó el tiempo de espera.', 504, 'koha_timeout');
    }
    if (error instanceof KohaError) throw error;
    throw new KohaError('No fue posible conectar con el catálogo Koha.', 502, 'koha_connection_error');
  } finally {
    clearTimeout(timer);
  }
}

async function kohaGet(config, path, query = {}) {
  const bodyText = await kohaRequest(config, path, { query });
  try {
    return bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return bodyText;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.biblios)) return value.biblios;
  return [];
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

// ---------------------------------------------------------------------------
// MARC incluido en la respuesta JSON de búsqueda (si la instalación lo expone)
// ---------------------------------------------------------------------------

function marcSubfieldValues(field, code) {
  const subfields = field?.subfields ?? field?.subfield ?? field?.$;
  if (!subfields) return [];
  if (Array.isArray(subfields)) {
    return subfields.filter(item => String(item?.code ?? item?.tag ?? item?.[0] ?? '').toLowerCase() === code)
      .map(item => item?.value ?? item?.content ?? item?.[1] ?? '');
  }
  if (typeof subfields === 'object') {
    const value = subfields[code] ?? subfields[`$${code}`];
    return Array.isArray(value) ? value : value == null ? [] : [value];
  }
  return [];
}

function marcFieldsOf(marc) {
  if (!marc || typeof marc !== 'object') return [];
  const source = Array.isArray(marc) ? marc : (marc.fields ?? marc.record?.fields ?? marc);
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];

  const fields = [];
  for (const tag of ['264', '260']) {
    const value = source[tag];
    if (Array.isArray(value)) fields.push(...value.map(field => ({ tag, ...field })));
    else if (value) fields.push({ tag, ...(typeof value === 'object' ? value : { value }) });
  }
  return fields;
}

/**
 * Extrae { place, publisher, year } del MARC que Koha incluya en el registro
 * JSON (objeto estructurado o MARCXML como cadena). Comparte las reglas de
 * prioridad con el parser de MARCXML (ver marc.js).
 */
function extractMarcPublication(record) {
  const marc = record?.marc ?? record?.marc_record ?? record?.marc_data ?? record?.marcxml;

  if (typeof marc === 'string') {
    return parseMarcXmlPublication(marc);
  }

  const candidates = marcFieldsOf(marc).map((field, order) => buildCandidate({
    tag: String(field?.tag ?? field?.field ?? field?.marcTag ?? ''),
    ind1: field?.ind1 ?? field?.indicator1 ?? field?.indicators?.[0] ?? field?.indicators?.ind1 ?? '',
    ind2: field?.ind2 ?? field?.indicator2 ?? field?.indicators?.[1] ?? field?.indicators?.ind2 ?? '',
    places: marcSubfieldValues(field, 'a'),
    publishers: marcSubfieldValues(field, 'b'),
    dates: marcSubfieldValues(field, 'c'),
    order
  }));

  return selectPublication(candidates);
}

// ---------------------------------------------------------------------------
// MARCXML por la API REST de Koha 25.11: GET /api/v1/public/biblios/{biblio_id}
// ---------------------------------------------------------------------------

/**
 * Descarga el registro MARCXML de un biblio. Lanza KohaError si el id no es
 * válido, si Koha responde con error HTTP, si no hay conexión o si el cuerpo
 * está vacío o no es MARCXML.
 */
async function getBiblioMarcXml(config, biblioId) {
  const id = String(biblioId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new KohaError('El identificador bibliográfico no es válido.', 400, 'invalid_biblio_id');
  }

  const body = await kohaRequest(config, `/public/biblios/${id}`, {
    accept: MARCXML_ACCEPT,
    baseUrl: config.marcBaseUrl || config.baseUrl
  });

  if (!body || !body.trim()) {
    throw new KohaError('Koha devolvió un registro MARC vacío.', 502, 'koha_empty_marc');
  }
  if (!looksLikeMarcXml(body)) {
    throw new KohaError('Koha no devolvió un registro MARCXML válido.', 502, 'koha_invalid_marcxml');
  }
  return body;
}

// Caché en memoria por instancia serverless (se reinicia en cada arranque en frío).
// Guarda promesas: varias búsquedas simultáneas del mismo biblio comparten una sola petición.
const marcCache = new Map();

function clearMarcCache() {
  marcCache.clear();
}

function marcCacheKey(config, biblioId) {
  return `${config.marcBaseUrl || config.baseUrl}|${biblioId}`;
}

function rememberMarc(key, entry) {
  marcCache.delete(key);
  marcCache.set(key, entry);
  while (marcCache.size > MARC_CACHE_MAX_ENTRIES) {
    marcCache.delete(marcCache.keys().next().value); // descarta la entrada más antigua
  }
}

/**
 * Devuelve { place, publisher, year } de un biblio usando su MARCXML,
 * con caché y sin repetir peticiones. Propaga el KohaError si falla.
 */
function getBiblioPublication(config, biblioId) {
  const key = marcCacheKey(config, biblioId);
  const cached = marcCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const configuredTtl = config.marcCacheTtlMs == null ? NaN : Number(config.marcCacheTtlMs);
  const ttl = Number.isFinite(configuredTtl) && configuredTtl >= 0
    ? configuredTtl
    : DEFAULT_MARC_CACHE_TTL_MS;

  const promise = getBiblioMarcXml(config, biblioId).then(parseMarcXmlPublication);
  const entry = { promise, expiresAt: Date.now() + ttl };
  rememberMarc(key, entry);

  promise.catch(() => {
    // Un fallo solo se recuerda brevemente: permite recuperarse pronto sin saturar a Koha.
    entry.expiresAt = Math.min(entry.expiresAt, Date.now() + MARC_FAILURE_TTL_MS);
  });
  return promise;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function needsMarcPublication(biblio) {
  // El lugar se completa de paso cuando se consulta el MARC, pero por sí solo
  // no justifica una petición extra.
  return Boolean(biblio.biblioId) && (!biblio.publisher || !biblio.year);
}

/**
 * Completa editorial, año y lugar faltantes con el MARCXML de la API REST.
 * - Solo consulta registros a los que les falta editorial o año.
 * - Nunca sobrescribe un dato válido que ya traiga el registro.
 * - Un fallo individual deja el registro intacto y no interrumpe la búsqueda.
 */
async function enrichWithMarcPublication(config, biblios) {
  const pending = biblios.filter(needsMarcPublication);
  if (!pending.length) return biblios;

  const concurrency = Number(config.marcConcurrency) || DEFAULT_MARC_CONCURRENCY;
  const budgetMs = Number(config.marcBudgetMs) > 0 ? Number(config.marcBudgetMs) : DEFAULT_MARC_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  await mapWithConcurrency(pending, concurrency, async biblio => {
    if (Date.now() > deadline) return; // presupuesto agotado: se entrega lo que ya hay
    try {
      const marc = await getBiblioPublication(config, biblio.biblioId);
      biblio.publisher = firstText(biblio.publisher, marc.publisher) || null;
      biblio.year = firstText(biblio.year, marc.year) || null;
      biblio.place = firstText(biblio.place, marc.place) || null;
    } catch (error) {
      console.warn('Booky Koha MARCXML no disponible:', {
        biblioId: biblio.biblioId,
        code: error?.code || 'unknown',
        status: error?.status || 0
      });
    }
  });

  return biblios;
}

function normalizeBiblio(record, baseUrl) {
  const id = record?.biblio_id ?? record?.id ?? record?.biblionumber;
  const title = firstText(record?.title, record?.uniform_title, record?.marc?.title);
  const author = firstText(record?.author, record?.main_author, record?.marc?.author);
  const isbn = firstText(record?.isbn, record?.isbn_list, record?.biblioitem?.isbn);
  const marcPublication = extractMarcPublication(record);
  // Si el JSON ya trae MARC (264 con 2.º indicador 1), tiene prioridad sobre los
  // campos simplificados. La fecha de copyright NO se usa como año de publicación.
  const publisher = firstText(marcPublication.publisher, record?.publisher, record?.publisher_name);
  const year = firstText(marcPublication.year, record?.publication_year, record?.date);
  const place = firstText(marcPublication.place, record?.publication_place, record?.place);
  const edition = firstText(record?.edition_statement, record?.edition);
  const url = id
    ? `${baseUrl}/cgi-bin/koha/opac-detail.pl?biblionumber=${encodeURIComponent(id)}`
    : '';

  return {
    biblioId: id ?? null,
    title: title || 'Título no proporcionado por la API',
    author: author || 'Autor no proporcionado',
    isbn: isbn || null,
    publisher: publisher || null,
    place: place || null,
    year: year || null,
    edition: edition || null,
    url
  };
}

function campusName(code) {
  const names = {
    NAI: 'Obregón Náinari',
    CEN: 'Obregón Centro',
    GYM: 'Guaymas',
    EMP: 'Empalme',
    EMPL: 'Empalme',
    NAV: 'Navojoa',
    BV: 'Biblioteca Virtual'
  };
  const normalized = String(code || '').trim().toUpperCase();
  return names[normalized] || (code ? String(code) : 'Ubicación no indicada');
}

function normalizeItem(item) {
  const branch = item?.holding_library_id || item?.home_library_id || '';
  const location = firstText(item?.location, item?.permanent_location);
  const callnumber = firstText(item?.callnumber, item?.call_number);
  const checkedOut = Boolean(item?.checked_out_date);
  const lost = Number(item?.lost_status || 0) > 0;
  const withdrawn = Number(item?.withdrawn || 0) > 0;
  const notForLoan = Number(
    item?.effective_not_for_loan_status ?? item?.not_for_loan_status ?? 0
  ) > 0;

  let status = 'Disponible según los datos actuales de Koha';
  if (checkedOut) status = 'Prestado';
  else if (lost) status = 'Registrado como extraviado';
  else if (withdrawn) status = 'Retirado del acervo';
  else if (notForLoan) status = 'No disponible para préstamo';

  return {
    campus: campusName(branch),
    branchCode: branch || null,
    location: location || null,
    callnumber: callnumber || null,
    status
  };
}

async function getItems(config, biblioId) {
  if (!biblioId) return [];
  const data = await kohaGet(
    config,
    `/biblios/${encodeURIComponent(biblioId)}/items`,
    { _per_page: config.maxItemsPerBiblio, _page: 1 }
  );
  return asArray(data).map(normalizeItem);
}

async function searchBiblios(config, rawQuery, options = {}) {
  if (!isConfigured(config)) {
    throw new KohaError(
      'La conexión de consulta al catálogo aún no está configurada.',
      503,
      'koha_not_configured'
    );
  }

  const query = String(rawQuery || '').trim().slice(0, 120);
  if (query.length < 2) {
    throw new KohaError('Escribe al menos dos caracteres para buscar.', 400, 'query_too_short');
  }

  const filter = [
    { title: { '-like': `%${query}%` } },
    { author: { '-like': `%${query}%` } },
    { isbn: { '-like': `%${query}%` } }
  ];
  const perPage = Math.min(Math.max(Number(config.maxResults) || 10, 1), 50);
  const maxPages = Math.min(Math.max(Number(config.maxPages) || 3, 1), 5);
  let records = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await kohaGet(config, '/biblios', {
        q: JSON.stringify(filter),
        _per_page: perPage,
        _page: page
      });
    } catch (error) {
      if (page !== 1 || !(error instanceof KohaError) || error.status !== 400) throw error;
      // Compatibilidad con instalaciones que no admiten OR entre campos.
      data = await kohaGet(config, '/biblios', {
        q: JSON.stringify({ title: { '-like': `%${query}%` } }),
        _per_page: perPage,
        _page: page
      });
    }
    const batch = asArray(data);
    pagesFetched++;
    records.push(...batch);
    if (batch.length < perPage) break;
  }

  const normalized = records.map(record => normalizeBiblio(record, config.baseUrl));
  const unique = [...new Map(normalized.map(record => [
    String(record.biblioId || `${record.title}|${record.author}|${record.isbn}`), record
  ])).values()];

  // Se completa después de eliminar duplicados para no consultar dos veces el mismo registro.
  await enrichWithMarcPublication(config, unique);

  if (options.includeItems === false) {
    return { query, totalReturned: unique.length, pagesFetched, results: unique };
  }

  // Limita la concurrencia para evitar saturar la API REST de Koha.
  const enriched = await mapWithConcurrency(unique, 4, async biblio => {
    try {
      const items = await getItems(config, biblio.biblioId);
      return { ...biblio, items };
    } catch {
      return { ...biblio, items: [], itemsUnavailable: true };
    }
  });

  return { query, totalReturned: enriched.length, pagesFetched, results: enriched };
}

function normalizePatron(record, searchedCardnumber = '') {
  const borrowernumber = record?.borrowernumber ?? record?.patron_id ?? record?.id;
  // Koha puede filtrar por cardnumber y, aun así, omitir ese campo en la
  // respuesta por las reglas de visibilidad de la cuenta técnica.
  // El fallback solo se usa porque el registro ya fue filtrado por Koha
  // mediante cardnumber + _match=exact en la petición.
  const cardnumber = firstText(record?.cardnumber, searchedCardnumber);
  const firstname = firstText(record?.firstname);
  const surname = firstText(record?.surname);
  const branchcode = firstText(record?.branchcode);
  const categoryId = firstText(record?.category_id);
  const sort2 = firstText(record?.sort2);

  return {
    borrowernumber: borrowernumber ?? null,
    cardnumber: cardnumber || null,
    firstname: firstname || null,
    surname: surname || null,
    full_name: [firstname, surname].filter(Boolean).join(' ') || 'Nombre no disponible',
    branchcode: branchcode || null,
    category_id: categoryId || null,
    sort2: sort2 || null
  };
}

async function searchPatronByCardnumber(config, rawCardnumber) {
  if (!isConfigured(config)) {
    throw new KohaError(
      'La búsqueda de usuarios de Koha no está habilitada o no tiene credenciales propias.',
      503,
      'koha_patrons_not_configured'
    );
  }

  const cardnumber = String(rawCardnumber || '').trim();
  if (!cardnumber || cardnumber.length > 64 || /[\u0000-\u001F\u007F]/.test(cardnumber)) {
    throw new KohaError(
      'Proporciona un cardnumber válido (máximo 64 caracteres).',
      400,
      'invalid_cardnumber'
    );
  }

  // Koha REST filtra colecciones mediante el parámetro q (JSON).
  // Enviar cardnumber como parámetro independiente puede ser ignorado por
  // algunas versiones y terminar devolviendo usuarios que no corresponden.
  const data = await kohaGet(config, '/patrons', {
    q: JSON.stringify({ cardnumber }),
    _per_page: 5,
    _page: 1
  });

  // Si Koha oculta cardnumber por permisos, confiamos en el filtro q aplicado
  // en el servidor. Si el campo sí viene visible, exigimos igualdad exacta.
  const records = asArray(data).filter(record => {
    const returnedCardnumber = firstText(record?.cardnumber);
    return !returnedCardnumber ||
      returnedCardnumber.toLowerCase() === cardnumber.toLowerCase();
  });

  return {
    query: { cardnumber },
    found: records.length > 0,
    total: records.length,
    results: records.slice(0, 5).map(record => normalizePatron(record, cardnumber))
  };
}

module.exports = {
  KohaError,
  isConfigured,
  searchBiblios,
  getItems,
  getBiblioMarcXml,
  getBiblioPublication,
  enrichWithMarcPublication,
  clearMarcCache,
  searchPatronByCardnumber,
  normalizePatron,
  extractMarcPublication,
  parseMarcXmlPublication,
  cleanMarcText,
  normalizeBiblio
};
