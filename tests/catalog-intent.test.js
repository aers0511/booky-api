const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCatalogSearch } = require('../src/features/catalog/intent');

test('detecta búsqueda por tema', () => {
  assert.deepEqual(
    detectCatalogSearch('Busca libros sobre administración de inventarios'),
    { type: 'catalog_search', query: 'administración de inventarios' }
  );
});

test('detecta búsqueda de libros', () => {
  assert.equal(detectCatalogSearch('¿Tienen libros de cálculo?').query, 'cálculo');
});

test('no convierte una pregunta de cómo buscar en búsqueda automática', () => {
  assert.equal(detectCatalogSearch('¿Cómo puedo buscar libros en el catálogo?'), null);
});
