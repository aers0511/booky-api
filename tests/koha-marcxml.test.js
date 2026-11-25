const test = require('node:test');
const assert = require('node:assert/strict');
const {
  searchBiblios,
  getBiblioMarcXml,
  clearMarcCache,
  KohaError
} = require('../src/integrations/koha/client');
const { parseMarcXmlPublication } = require('../src/integrations/koha/marc');
const { getConfig } = require('../src/config');

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = 'xmlns="http://www.loc.gov/MARC21/slim"';

const field = (tag, ind1, ind2, subfields) =>
  `<datafield tag="${tag}" ind1="${ind1}" ind2="${ind2}">` +
  subfields.map(([code, value]) => `<subfield code="${code}">${value}</subfield>`).join('') +
  '</datafield>';

const record = (...fields) =>
  `${XML_HEADER}<record ${NS}><leader>00751nam a22002657a 4500</leader>${fields.join('')}</record>`;

// Registro real 45506 descrito en el requerimiento.
const RECORD_45506 = record(
  field('100', '1', ' ', [['a', 'Rowling, J.K.,'], ['e', 'autor']]),
  field('264', '3', '1', [['a', 'España :'], ['b', 'Salamandra,'], ['c', '2006']])
);

const baseConfig = (overrides = {}) => ({
  enabled: true,
  baseUrl: 'https://koha.example',
  apiPath: '/api/v1',
  username: 'reader',
  password: 'secret',
  timeoutMs: 1000,
  maxResults: 10,
  maxPages: 1,
  ...overrides
});

/**
 * Simula fetch: el listado JSON (/biblios) y el MARCXML (/biblios/{id}).
 * Usa objetos Response reales para que la decodificación UTF-8 sea la del runtime.
 */
function installFetch({ rows = [], marc = {} }) {
  const original = global.fetch;
  const calls = { search: [], marc: [] };
  let active = 0;
  calls.maxActive = 0;

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const idMatch = parsed.pathname.match(/\/api\/v1\/biblios\/(\d+)$/);

    if (!idMatch) {
      calls.search.push({ url: parsed, options });
      return new Response(JSON.stringify(rows), { status: 200 });
    }

    const id = idMatch[1];
    calls.marc.push({ id, url: parsed, options });
    active++;
    calls.maxActive = Math.max(calls.maxActive, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      const handler = marc[id];
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'number') return new Response('{"error":"x"}', { status: handler });
      return new Response(Buffer.from(handler ?? '', 'utf8'), {
        status: 200,
        headers: { 'content-type': 'application/marcxml+xml' }
      });
    } finally {
      active--;
    }
  };

  return { calls, restore: () => { global.fetch = original; } };
}

test.beforeEach(() => clearMarcCache());

// ---------------------------------------------------------------------------
// Parser MARCXML
// ---------------------------------------------------------------------------

test('extrae lugar, editorial y año desde un MARCXML válido (registro 45506)', () => {
  assert.deepEqual(parseMarcXmlPublication(RECORD_45506), {
    place: 'España',
    publisher: 'Salamandra',
    year: '2006'
  });
});

test('soporta varios subcampos $b y evita duplicados', () => {
  const xml = record(field('264', '3', '1', [
    ['a', 'México :'],
    ['b', 'Arthur A. Levine Books,'],
    ['b', 'Scholastic Press,'],
    ['b', 'scholastic press,'],
    ['c', '2003']
  ]));
  const result = parseMarcXmlPublication(xml);
  assert.equal(result.publisher, 'Arthur A. Levine Books; Scholastic Press');
  assert.equal(result.year, '2003');
});

test('conserva caracteres UTF-8 al recibir el MARCXML por HTTP', async () => {
  const fetchMock = installFetch({ marc: { 45506: RECORD_45506 } });
  try {
    const xml = await getBiblioMarcXml(baseConfig(), 45506);
    assert.ok(xml.includes('España'));
    assert.ok(!xml.includes('EspaÃ±a'));
    assert.equal(parseMarcXmlPublication(xml).place, 'España');
  } finally { fetchMock.restore(); }
});

test('respeta espacios de nombres con prefijo y atributos con comillas simples', () => {
  const xml = `${XML_HEADER}<marc:collection xmlns:marc="http://www.loc.gov/MARC21/slim"><marc:record>` +
    `<marc:datafield ind2='1' tag='264' ind1='3'>` +
    `<marc:subfield code='a'>Perú :</marc:subfield>` +
    `<marc:subfield code='b'>Fondo Editorial &amp; Cía.,</marc:subfield>` +
    `<marc:subfield code='c'>2018.</marc:subfield>` +
    `</marc:datafield></marc:record></marc:collection>`;
  assert.deepEqual(parseMarcXmlPublication(xml), {
    place: 'Perú',
    publisher: 'Fondo Editorial & Cía.',
    year: '2018'
  });
});

test('prioriza 264 con segundo indicador 1 sobre 264 de otra función y sobre 260', () => {
  const xml = record(
    field('260', ' ', ' ', [['a', 'Madrid :'], ['b', 'Editorial Antigua,'], ['c', '1999']]),
    field('264', ' ', '4', [['c', 'c2010']]),
    field('264', ' ', '3', [['a', 'Toluca :'], ['b', 'Imprenta Z,'], ['c', '2011']]),
    field('264', '3', '1', [['a', 'España :'], ['b', 'Salamandra,'], ['c', '2006']])
  );
  assert.deepEqual(parseMarcXmlPublication(xml), {
    place: 'España',
    publisher: 'Salamandra',
    year: '2006'
  });
});

test('entre varios 264 de publicación prefiere el de primer indicador 3 (actual)', () => {
  const xml = record(
    field('264', '2', '1', [['b', 'Editorial anterior,'], ['c', '2001']]),
    field('264', '3', '1', [['b', 'Editorial actual,'], ['c', '2003']])
  );
  const result = parseMarcXmlPublication(xml);
  assert.equal(result.publisher, 'Editorial actual');
  assert.equal(result.year, '2003');
});

test('usa el campo 260 como alternativa cuando no existe 264 de publicación', () => {
  const xml = record(field('260', ' ', ' ', [
    ['a', 'Buenos Aires :'], ['b', 'Paidós,'], ['c', '1998.']
  ]));
  assert.deepEqual(parseMarcXmlPublication(xml), {
    place: 'Buenos Aires',
    publisher: 'Paidós',
    year: '1998'
  });
});

test('no inventa datos cuando el registro no tiene 264 ni 260', () => {
  const xml = record(field('100', '1', ' ', [['a', 'Rowling, J.K.,']]));
  assert.deepEqual(parseMarcXmlPublication(xml), { place: '', publisher: '', year: '' });
  assert.deepEqual(parseMarcXmlPublication(''), { place: '', publisher: '', year: '' });
});

test('no confunde la fecha de copyright con la de publicación', () => {
  const copyrightOnly = record(field('264', ' ', '4', [['c', '©2010']]));
  assert.equal(parseMarcXmlPublication(copyrightOnly).year, '');

  const mixed = record(field('264', ' ', '1', [
    ['b', 'Pearson,'], ['c', 'c2005'], ['c', '2007']
  ]));
  assert.equal(parseMarcXmlPublication(mixed).year, '2007');

  const copyrightInPublication = record(field('264', ' ', '1', [['b', 'Pearson,'], ['c', 'c2005']]));
  assert.equal(parseMarcXmlPublication(copyrightInPublication).year, '');
});

test('ignora marcadores de dato desconocido como [s.n.] y [S.l.]', () => {
  const xml = record(field('264', ' ', '1', [
    ['a', '[S.l.] :'], ['b', '[s.n.],'], ['c', '[2015?]']
  ]));
  assert.deepEqual(parseMarcXmlPublication(xml), { place: '', publisher: '', year: '2015' });
});

// ---------------------------------------------------------------------------
// Cliente REST: GET /api/v1/biblios/{biblio_id}
// ---------------------------------------------------------------------------

test('pide el MARCXML a /api/v1/biblios/{id} con Basic y Accept marcxml', async () => {
  const fetchMock = installFetch({ marc: { 45506: RECORD_45506 } });
  try {
    await getBiblioMarcXml(baseConfig({ baseUrl: 'https://sib.itson.edu.mx' }), 45506);
    const [call] = fetchMock.calls.marc;
    assert.equal(call.url.href, 'https://sib.itson.edu.mx/api/v1/biblios/45506');
    assert.equal(call.options.headers.Accept, 'application/marcxml+xml');
    assert.equal(
      call.options.headers.Authorization,
      'Basic ' + Buffer.from('reader:secret').toString('base64')
    );
    assert.ok(!call.url.pathname.includes('showmarc'));
    assert.ok(!call.url.pathname.includes('/public/'));
  } finally { fetchMock.restore(); }
});

test('usa KOHA_BASE_URL como dominio de MARCXML por defecto', () => {
  const previous = { base: process.env.KOHA_BASE_URL, marc: process.env.KOHA_MARC_BASE_URL };
  delete process.env.KOHA_BASE_URL;
  delete process.env.KOHA_MARC_BASE_URL;
  try {
    const { koha } = getConfig();
    assert.equal(koha.baseUrl, 'https://sib.itson.edu.mx');
    assert.equal(koha.marcBaseUrl, 'https://sib.itson.edu.mx');
  } finally {
    if (previous.base !== undefined) process.env.KOHA_BASE_URL = previous.base;
    if (previous.marc !== undefined) process.env.KOHA_MARC_BASE_URL = previous.marc;
  }
});

test('rechaza identificadores bibliográficos no numéricos sin hacer peticiones', async () => {
  const fetchMock = installFetch({});
  try {
    await assert.rejects(
      getBiblioMarcXml(baseConfig(), '45506/../../patrons'),
      error => error instanceof KohaError && error.code === 'invalid_biblio_id'
    );
    assert.equal(fetchMock.calls.marc.length, 0);
  } finally { fetchMock.restore(); }
});

test('traduce HTTP 404 y 401 de MARCXML a KohaError', async () => {
  const fetchMock = installFetch({ marc: { 1: 404, 2: 401 } });
  try {
    await assert.rejects(getBiblioMarcXml(baseConfig(), 1),
      error => error instanceof KohaError && error.status === 404);
    await assert.rejects(getBiblioMarcXml(baseConfig(), 2),
      error => error instanceof KohaError && error.status === 401 &&
        /credenciales/.test(error.message));
  } finally { fetchMock.restore(); }
});

test('traduce errores de conexión y tiempo de espera', async () => {
  const fetchMock = installFetch({ marc: { 3: new Error('ECONNRESET') } });
  try {
    await assert.rejects(getBiblioMarcXml(baseConfig(), 3),
      error => error instanceof KohaError && error.code === 'koha_connection_error');
  } finally { fetchMock.restore(); }

  const original = global.fetch;
  global.fetch = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      reject(abort);
    });
  });
  try {
    await assert.rejects(getBiblioMarcXml(baseConfig({ timeoutMs: 20 }), 4),
      error => error instanceof KohaError && error.code === 'koha_timeout');
  } finally { global.fetch = original; }
});

test('detecta respuestas vacías o que no son MARCXML', async () => {
  const fetchMock = installFetch({ marc: { 5: '', 6: '<html><body>login</body></html>' } });
  try {
    await assert.rejects(getBiblioMarcXml(baseConfig(), 5),
      error => error.code === 'koha_empty_marc');
    await assert.rejects(getBiblioMarcXml(baseConfig(), 6),
      error => error.code === 'koha_invalid_marcxml');
  } finally { fetchMock.restore(); }
});

// ---------------------------------------------------------------------------
// Integración con searchBiblios
// ---------------------------------------------------------------------------

test('completa editorial, año y lugar faltantes desde MARCXML', async () => {
  const fetchMock = installFetch({
    rows: [{ biblio_id: 45506, title: 'Harry Potter y el misterio del príncipe', author: 'Rowling, J.K.' }],
    marc: { 45506: RECORD_45506 }
  });
  try {
    const result = await searchBiblios(baseConfig(), 'Harry Potter', { includeItems: false });
    const [biblio] = result.results;
    assert.equal(biblio.publisher, 'Salamandra');
    assert.equal(biblio.year, '2006');
    assert.equal(biblio.place, 'España');
    assert.equal(biblio.title, 'Harry Potter y el misterio del príncipe');
    assert.equal(biblio.biblioId, 45506);
    assert.equal(fetchMock.calls.marc.length, 1);
  } finally { fetchMock.restore(); }
});

test('no sobrescribe datos válidos del JSON: solo completa lo que falta', async () => {
  const fetchMock = installFetch({
    rows: [{ biblio_id: 7, title: 'Libro', publisher: 'Editorial del JSON' }],
    marc: { 7: RECORD_45506 }
  });
  try {
    const [biblio] = (await searchBiblios(baseConfig(), 'Libro', { includeItems: false })).results;
    assert.equal(biblio.publisher, 'Editorial del JSON');
    assert.equal(biblio.year, '2006');
  } finally { fetchMock.restore(); }
});

test('no consulta MARCXML cuando el registro ya tiene editorial y año', async () => {
  const fetchMock = installFetch({
    rows: [
      { biblio_id: 1, title: 'A', publisher: 'Pearson', publication_year: '2010' },
      { biblio_id: 2, title: 'B', publisher: 'McGraw-Hill', publication_year: '2011' }
    ]
  });
  try {
    const result = await searchBiblios(baseConfig(), 'inventarios', { includeItems: false });
    assert.equal(fetchMock.calls.marc.length, 0);
    assert.equal(result.results[0].place, null);
  } finally { fetchMock.restore(); }
});

test('no usa la fecha de copyright del JSON como año de publicación', async () => {
  const fetchMock = installFetch({
    rows: [{ biblio_id: 8, title: 'Libro', publisher: 'Pearson', copyright_date: '2001' }],
    marc: { 8: record(field('264', ' ', '1', [['b', 'Pearson,'], ['c', '2004']])) }
  });
  try {
    const [biblio] = (await searchBiblios(baseConfig(), 'Libro', { includeItems: false })).results;
    assert.equal(biblio.year, '2004');
  } finally { fetchMock.restore(); }
});

test('un fallo de MARCXML en un registro no interrumpe la búsqueda', async () => {
  const fetchMock = installFetch({
    rows: [
      { biblio_id: 10, title: 'Sin permiso' },
      { biblio_id: 11, title: 'Sin conexión' },
      { biblio_id: 12, title: 'No existe' },
      { biblio_id: 13, title: 'Correcto' }
    ],
    marc: { 10: 401, 11: new Error('ECONNRESET'), 12: 404, 13: RECORD_45506 }
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await searchBiblios(baseConfig(), 'libro', { includeItems: false });
    assert.equal(result.totalReturned, 4);
    assert.deepEqual(result.results.map(item => item.title),
      ['Sin permiso', 'Sin conexión', 'No existe', 'Correcto']);
    assert.equal(result.results[0].publisher, null);
    assert.equal(result.results[1].year, null);
    assert.equal(result.results[3].publisher, 'Salamandra');
  } finally {
    console.warn = originalWarn;
    fetchMock.restore();
  }
});

test('no repite consultas MARCXML del mismo biblio_id (caché y duplicados)', async () => {
  const fetchMock = installFetch({
    rows: [
      { biblio_id: 45506, title: 'Harry Potter' },
      { biblio_id: 45506, title: 'Harry Potter (duplicado)' }
    ],
    marc: { 45506: RECORD_45506 }
  });
  try {
    await searchBiblios(baseConfig(), 'Harry', { includeItems: false });
    await searchBiblios(baseConfig(), 'Harry', { includeItems: false });
    assert.equal(fetchMock.calls.marc.length, 1);
  } finally { fetchMock.restore(); }
});

test('limita la concurrencia de consultas MARCXML', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ biblio_id: 100 + index, title: `Libro ${index}` }));
  const marc = Object.fromEntries(rows.map(row => [row.biblio_id, RECORD_45506]));
  const fetchMock = installFetch({ rows, marc });
  try {
    await searchBiblios(baseConfig({ marcConcurrency: 3 }), 'libro', { includeItems: false });
    assert.equal(fetchMock.calls.marc.length, 12);
    assert.ok(fetchMock.calls.maxActive <= 3, `máximo simultáneo: ${fetchMock.calls.maxActive}`);
  } finally { fetchMock.restore(); }
});
