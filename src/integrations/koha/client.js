class KohaError extends Error {
  constructor(message, status = 502, code = 'koha_error') {
    super(message);
    this.name = 'KohaError';
    this.status = status;
    this.code = code;
  }
}

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

async function kohaGet(config, path, query = {}) {
  const url = new URL(
    `${config.baseUrl}${config.apiPath}${path.startsWith('/') ? path : '/' + path}`
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
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    const bodyText = await response.text();
    let data = null;

    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = bodyText;
    }

    if (!response.ok) {
      const safeMessage =
        response.status === 401 ? 'Koha rechazó las credenciales de consulta.' :
        response.status === 403 ? 'La cuenta de Koha no tiene permiso de catálogo.' :
        response.status === 404 ? 'No se encontró el endpoint solicitado en Koha.' :
        response.status === 400 ? 'Koha rechazó el formato de búsqueda.' :
        `Koha respondió HTTP ${response.status}.`;

      throw new KohaError(safeMessage, response.status, data?.error_code || 'koha_http_error');
    }

    return data;
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

function normalizeBiblio(record, baseUrl) {
  const id = record?.biblio_id ?? record?.id ?? record?.biblionumber;
  const title = firstText(record?.title, record?.uniform_title, record?.marc?.title);
  const author = firstText(record?.author, record?.main_author, record?.marc?.author);
  const isbn = firstText(record?.isbn, record?.isbn_list, record?.biblioitem?.isbn);
  const publisher = firstText(record?.publisher, record?.publisher_name);
  const year = firstText(record?.publication_year, record?.copyright_date, record?.date);
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

  // Koha REST API utiliza filtros JSON en el parámetro q.
  // Los campos se consultan con OR para ampliar coincidencias de título,
  // autor e ISBN. Todas las operaciones del cliente son GET.
  const filter = [
    { title: { '-like': `%${query}%` } },
    { author: { '-like': `%${query}%` } },
    { isbn: { '-like': `%${query}%` } }
  ];

  let data;
  try {
    data = await kohaGet(config, '/biblios', {
      q: JSON.stringify(filter),
      _per_page: config.maxResults,
      _page: 1
    });
  } catch (error) {
    // Algunas instalaciones o personalizaciones no exponen todos los
    // campos del objeto bibliográfico. Se intenta una búsqueda por título.
    if (!(error instanceof KohaError) || error.status !== 400) throw error;

    data = await kohaGet(config, '/biblios', {
      q: JSON.stringify({ title: { '-like': `%${query}%` } }),
      _per_page: config.maxResults,
      _page: 1
    });
  }

  const records = asArray(data).slice(0, config.maxResults);
  const biblios = records.map(record => normalizeBiblio(record, config.baseUrl));

  // Recupera ejemplares con concurrencia limitada para no saturar Koha.
  // El endpoint de adquisiciones puede solicitar primero solo bibliografía
  // y recuperar ejemplares únicamente para coincidencias relevantes.
  if (options.includeItems === false) {
    return {
      query,
      totalReturned: biblios.length,
      results: biblios
    };
  }

  const enriched = await Promise.all(biblios.map(async biblio => {
    try {
      const items = await getItems(config, biblio.biblioId);
      return { ...biblio, items };
    } catch (error) {
      return {
        ...biblio,
        items: [],
        itemsUnavailable: true
      };
    }
  }));

  return {
    query,
    totalReturned: enriched.length,
    results: enriched
  };
}

module.exports = {
  KohaError,
  isConfigured,
  searchBiblios,
  getItems
};
