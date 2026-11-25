const test = require('node:test');
const assert = require('node:assert/strict');
const { searchBiblios } = require('../src/integrations/koha/client');

test('searchBiblios recorre páginas, elimina duplicados y conserva el orden', async () => {
  const originalFetch = global.fetch;
  const requestedPages = [];
  global.fetch = async url => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('_page'));
    requestedPages.push(page);
    const rows = page === 1
      ? [
          { biblio_id: 10, title: 'Administración de inventarios', author: 'A. Autor' },
          { biblio_id: 11, title: 'Control de inventarios', author: 'B. Autor' }
        ]
      : [
          { biblio_id: 11, title: 'Control de inventarios', author: 'B. Autor' },
          { biblio_id: 12, title: 'Gestión de inventarios', author: 'C. Autor' }
        ];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows)
    };
  };

  try {
    const result = await searchBiblios({
      enabled: true,
      baseUrl: 'https://koha.example',
      apiPath: '/api/v1',
      username: 'reader',
      password: 'secret',
      timeoutMs: 1000,
      maxResults: 2,
      maxPages: 2
    }, 'inventarios', { includeItems: false });

    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.totalReturned, 3);
    assert.deepEqual(result.results.map(item => item.biblioId), [10, 11, 12]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('searchBiblios obtiene editorial y fecha desde MARC 264 con segundo indicador 1', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{
      biblio_id: 12620,
      title: 'Ejemplo de título',
      marc: { fields: [
        { tag: '264', ind1: '3', ind2: '1', subfields: [
          { code: 'a', value: 'España :' },
          { code: 'b', value: 'Salamandra,' },
          { code: 'c', value: '2006.' }
        ] }
      ] }
    }])
  });
  try {
    const result = await searchBiblios({
      enabled: true, baseUrl: 'https://koha.example', apiPath: '/api/v1',
      username: 'reader', password: 'secret', timeoutMs: 1000,
      maxResults: 10, maxPages: 1
    }, 'Ejemplo', { includeItems: false });
    assert.equal(result.results[0].publisher, 'Salamandra');
    assert.equal(result.results[0].year, '2006');
  } finally { global.fetch = originalFetch; }
});

test('searchBiblios obtiene editorial desde MARCXML 264', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{
      biblio_id: 12621,
      title: 'Otro título',
      marcxml: '<record><datafield tag="264" ind1="3" ind2="1"><subfield code="a">España :</subfield><subfield code="b">Salamandra,</subfield><subfield code="c">2006.</subfield></datafield></record>'
    }])
  });
  try {
    const result = await searchBiblios({
      enabled: true, baseUrl: 'https://koha.example', apiPath: '/api/v1',
      username: 'reader', password: 'secret', timeoutMs: 1000,
      maxResults: 10, maxPages: 1
    }, 'Otro', { includeItems: false });
    assert.equal(result.results[0].publisher, 'Salamandra');
    assert.equal(result.results[0].year, '2006');
  } finally { global.fetch = originalFetch; }
});

test('prioriza 264 $b y $c del MARC ITSON sobre campos simplificados de Koha', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{
      biblio_id: 12620,
      title: 'Harry potter y el misterio del principe',
      publisher: 'Editorial genérica',
      publication_year: '2005',
      marc: { fields: [{
        tag: '264', ind1: '3', ind2: '1', subfields: [
          { code: 'a', value: 'España :' },
          { code: 'b', value: 'Salamandra,' },
          { code: 'c', value: '2006' }
        ]
      }] }
    }])
  });
  try {
    const result = await searchBiblios({
      enabled: true, baseUrl: 'https://koha.example', apiPath: '/api/v1',
      username: 'reader', password: 'secret', timeoutMs: 1000,
      maxResults: 10, maxPages: 1
    }, 'Harry potter', { includeItems: false });
    assert.equal(result.results[0].publisher, 'Salamandra');
    assert.equal(result.results[0].year, '2006');
  } finally { global.fetch = originalFetch; }
});


test('prioriza 264 31 y conserva todas las editoriales de los subcampos $b', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{
      biblio_id: 2003,
      title: 'Harry Potter',
      publisher: 'Editorial desactualizada',
      publication_year: '2002',
      marc: { fields: [
        { tag: '264', ind1: '2', ind2: '1', subfields: [
          { code: 'b', value: 'Editorial anterior,' },
          { code: 'c', value: '2001.' }
        ] },
        { tag: '264', ind1: '3', ind2: '1', subfields: [
          { code: 'a', value: 'México :' },
          { code: 'b', value: 'Arthur A. Levine Books,' },
          { code: 'b', value: 'Scholastic Press,' },
          { code: 'c', value: '2003,' }
        ] },
        { tag: '260', subfields: [
          { code: 'b', value: 'Editorial antigua' },
          { code: 'c', value: '1999' }
        ] }
      ] }
    }])
  });
  try {
    const result = await searchBiblios({
      enabled: true, baseUrl: 'https://koha.example', apiPath: '/api/v1',
      username: 'reader', password: 'secret', timeoutMs: 1000,
      maxResults: 10, maxPages: 1
    }, 'Harry Potter', { includeItems: false });
    assert.equal(result.results[0].publisher, 'Arthur A. Levine Books; Scholastic Press');
    assert.equal(result.results[0].year, '2003');
  } finally { global.fetch = originalFetch; }
});

test('prioriza 264 31 en MARCXML y conserva múltiples subcampos $b', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{
      biblio_id: 2004,
      title: 'Harry Potter',
      marcxml: '<record><datafield tag="264" ind1="3" ind2="1"><subfield code="a">México :</subfield><subfield code="b">Arthur A. Levine Books,</subfield><subfield code="b">Scholastic Press,</subfield><subfield code="c">2003,</subfield></datafield></record>'
    }])
  });
  try {
    const result = await searchBiblios({
      enabled: true, baseUrl: 'https://koha.example', apiPath: '/api/v1',
      username: 'reader', password: 'secret', timeoutMs: 1000,
      maxResults: 10, maxPages: 1
    }, 'Harry Potter', { includeItems: false });
    assert.equal(result.results[0].publisher, 'Arthur A. Levine Books; Scholastic Press');
    assert.equal(result.results[0].year, '2003');
  } finally { global.fetch = originalFetch; }
});
