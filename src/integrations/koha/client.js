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

function cleanMarcText(value) {
  return firstText(value)
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\s,;:/.]+$/g, '')
    .trim();
}

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

function extractMarcPublication(record) {
  // Koha puede exponer MARC como objeto estructurado o como MARCXML.
  // El campo 264 con indicadores 3 y 1 (264 31) identifica la publicación:
  // $b contiene la editorial y $c la fecha de publicación.
  const marc = record?.marc ?? record?.marc_record ?? record?.marc_data ?? record?.marcxml;
  const candidates = [];

  const addCandidate = (tag, ind1, ind2, publisher, date) => {
    const publishers = publisher.map(cleanMarcText).filter(Boolean);
    const dates = date.map(cleanMarcText).filter(Boolean);
    if (!publishers.length && !dates.length) return;

    // Priorizar exactamente 264 31; después otros 264 de publicación;
    // finalmente los campos MARC heredados o con indicadores incompletos.
    const priority = tag === '264' && ind1 === '3' && ind2 === '1'
      ? 0
      : tag === '264' && ind2 === '1'
        ? 1
        : tag === '260'
          ? 2
          : 3;
    candidates.push({
      priority,
      publisher: publishers.join('; '),
      year: dates[0] || ''
    });
  };

  const fields = [];
  if (marc && typeof marc === 'object') {
    const source = Array.isArray(marc) ? marc : (marc.fields ?? marc.record?.fields ?? marc);
    if (Array.isArray(source)) {
      fields.push(...source);
    } else if (source && typeof source === 'object') {
      for (const tag of ['264', '260']) {
        const value = source[tag];
        if (Array.isArray(value)) fields.push(...value.map(field => ({ tag, ...field })));
        else if (value) fields.push({ tag, ...(typeof value === 'object' ? value : { value }) });
      }
    }
  }

  for (const field of fields) {
    const tag = String(field?.tag ?? field?.field ?? field?.marcTag ?? '');
    if (tag !== '264' && tag !== '260') continue;
    const ind1 = String(field?.ind1 ?? field?.indicator1 ?? field?.indicators?.[0] ?? field?.indicators?.ind1 ?? '');
    const ind2 = String(field?.ind2 ?? field?.indicator2 ?? field?.indicators?.[1] ?? field?.indicators?.ind2 ?? '');
    if (tag === '264' && ind2 && ind2 !== '1') continue;
    addCandidate(
      tag,
      ind1,
      ind2,
      marcSubfieldValues(field, 'b'),
      marcSubfieldValues(field, 'c')
    );
  }

  // Algunas instalaciones de Koha devuelven el registro como MARCXML.
  const xml = typeof marc === 'string' ? marc : '';
  if (xml) {
    const fieldMatches = [...xml.matchAll(/<datafield\b([^>]*)\btag=["'](264|260)["']([^>]*)>([\s\S]*?)<\/datafield>/gi)];
    for (const match of fieldMatches) {
      const tag = match[2];
      const attrs = `${match[1]} ${match[3]}`;
      const ind1 = attrs.match(/ind1=["']([^"']*)["']/i)?.[1] || '';
      const ind2 = attrs.match(/ind2=["']([^"']*)["']/i)?.[1] || '';
      if (tag === '264' && ind2 && ind2 !== '1') continue;
      const body = match[4];
      const getCode = code => [...body.matchAll(new RegExp(`<subfield\\b[^>]*code=["']${code}["'][^>]*>([\\s\\S]*?)<\\/subfield>`, 'gi'))]
        .map(item => item[1].replace(/<[^>]+>/g, ''));
      addCandidate(tag, ind1, ind2, getCode('b'), getCode('c'));
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const selected = candidates[0];
  return selected
    ? { publisher: selected.publisher, year: selected.year }
    : { publisher: '', year: '' };
}


function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Koha REST /biblios normalmente entrega los campos normalizados, pero no
 * necesariamente el MARC completo. Como respaldo consulta showmarc.pl,
 * que es la misma vista MARC que ofrece el OPAC.
 */
function extractMarcPublicationFromHtml(html) {
  const source = String(html || '');
  if (!source) return { publisher: '', year: '' };

  // Si showmarc devuelve MARCXML incrustado, reutiliza el extractor principal.
  const xmlMatch = source.match(/<record\b[\s\S]*?<\/record>/i);
  if (xmlMatch) {
    const parsed = extractMarcPublication({ marcxml: xmlMatch[0] });
    if (parsed.publisher || parsed.year) return parsed;
  }

  const candidates = [];
  const add = (ind1, ind2, body) => {
    if (ind2 && ind2 !== '1') return;
    const normalized = decodeHtmlEntities(String(body || '').replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ').trim();
    const subfields = [...normalized.matchAll(/(?:\$|‡|\|)\s*([a-z0-9])\s*/gi)];
    const values = {};
    for (let i = 0; i < subfields.length; i++) {
      const code = subfields[i][1].toLowerCase();
      const start = subfields[i].index + subfields[i][0].length;
      const end = i + 1 < subfields.length ? subfields[i + 1].index : normalized.length;
      (values[code] ||= []).push(normalized.slice(start, end).trim());
    }
    const publishers = (values.b || []).map(cleanMarcText).filter(Boolean);
    const dates = (values.c || []).map(cleanMarcText).filter(Boolean);
    if (publishers.length || dates.length) {
      candidates.push({
        priority: ind1 === '3' && ind2 === '1' ? 0 : 1,
        publisher: publishers.join('; '),
        year: dates[0] || ''
      });
    }
  };

  // Vista HTML de Koha: cada campo MARC suele representarse en una fila.
  const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => decodeHtmlEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (cells[0] === '264' && cells.length >= 4) {
      add(cells[1], cells[2], cells.slice(3).join(' '));
    } else {
      const plain = decodeHtmlEntities(row.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
      const match = plain.match(/\b264\s+([0-9 ])\s*([0-9 ])\s*([\s\S]*)/);
      if (match) add(match[1].trim(), match[2].trim(), match[3]);
    }
  }

  // Algunas plantillas presentan los campos MARC en texto preformateado.
  if (!candidates.length) {
    const plain = decodeHtmlEntities(source.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
    const regex = /\b264\s+([0-9 ])\s*([0-9 ])\s*([\s\S]*?)(?=\b(?:245|250|260|300|336|337|338|490|500|650|700|856)\s+[0-9 ]{2}\b|$)/g;
    for (const match of plain.matchAll(regex)) add(match[1].trim(), match[2].trim(), match[3]);
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const selected = candidates[0];
  return selected ? { publisher: selected.publisher, year: selected.year } : { publisher: '', year: '' };
}

async function fetchMarcPublication(config, biblioId) {
  if (!biblioId) return { publisher: '', year: '' };
  const baseUrl = String(config.marcBaseUrl || config.baseUrl).replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/cgi-bin/koha/catalogue/showmarc.pl`);
  url.searchParams.set('id', String(biblioId));
  url.searchParams.set('viewas', 'html');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: buildAuthHeader(config.username, config.password),
        Accept: 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });
    if (!response.ok) return { publisher: '', year: '' };
    return extractMarcPublicationFromHtml(await response.text());
  } catch (_) {
    // El fallo de la vista MARC no debe impedir mostrar el resultado del catálogo.
    return { publisher: '', year: '' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBiblio(record, baseUrl) {
  const id = record?.biblio_id ?? record?.id ?? record?.biblionumber;
  const title = firstText(record?.title, record?.uniform_title, record?.marc?.title);
  const author = firstText(record?.author, record?.main_author, record?.marc?.author);
  const isbn = firstText(record?.isbn, record?.isbn_list, record?.biblioitem?.isbn);
  const marcPublication = extractMarcPublication(record);
  // En el catálogo ITSON, el dato bibliográfico de editorial es 264 $b
  // (segundo indicador 1 = publicación). Priorizar MARC evita que un campo
  // simplificado vacío, genérico o desactualizado lo sobrescriba.
  const publisher = firstText(marcPublication.publisher, record?.publisher, record?.publisher_name);
  const year = firstText(marcPublication.year, record?.publication_year, record?.copyright_date, record?.date);
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

  const biblios = await Promise.all(records.map(async record => {
    const normalized = normalizeBiblio(record, config.baseUrl);
    // La API REST no siempre incluye el MARC. Recupera 264 31 desde
    // showmarc.pl solo cuando faltan editorial o año.
    if (config.marcBaseUrl && (!normalized.publisher || !normalized.year) && normalized.biblioId) {
      const marc = await fetchMarcPublication(config, normalized.biblioId);
      normalized.publisher = firstText(marc.publisher, normalized.publisher) || null;
      normalized.year = firstText(marc.year, normalized.year) || null;
    }
    return normalized;
  }));
  const unique = [...new Map(biblios.map(record => [
    String(record.biblioId || `${record.title}|${record.author}|${record.isbn}`), record
  ])).values()];

  if (options.includeItems === false) {
    return { query, totalReturned: unique.length, pagesFetched, results: unique };
  }

  // Limita la concurrencia para evitar saturar la API REST de Koha.
  const queue = unique;
  const enriched = new Array(queue.length);
  let cursor = 0;
  const workerCount = Math.min(4, queue.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const biblio = queue[index];
      try {
        const items = await getItems(config, biblio.biblioId);
        enriched[index] = { ...biblio, items };
      } catch {
        enriched[index] = { ...biblio, items: [], itemsUnavailable: true };
      }
    }
  }));

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
  searchPatronByCardnumber,
  normalizePatron,
  extractMarcPublication,
  extractMarcPublicationFromHtml,
  normalizeBiblio
};
