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
