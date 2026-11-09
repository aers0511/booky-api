const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCatalogSearch,
  detectCampus,
  detectCampusFollowUp
} = require('../src/features/catalog/intent');

test('detecta búsqueda por tema', () => {
  assert.deepEqual(
    detectCatalogSearch('Busca libros sobre administración de inventarios'),
    {
      type: 'catalog_search',
      query: 'administración de inventarios',
      campus: null,
      needsCampus: true
    }
  );
});

test('detecta búsqueda de libros y campus especificado', () => {
  const result = detectCatalogSearch('¿Tienen libros de cálculo en Náinari?');
  assert.equal(result.query, 'cálculo');
  assert.equal(result.campus.code, 'NAI');
  assert.equal(result.needsCampus, false);
});

test('no convierte una pregunta de cómo buscar en búsqueda automática', () => {
  assert.equal(detectCatalogSearch('¿Cómo puedo buscar libros en el catálogo?'), null);
});

test('reconoce todos los campus', () => {
  assert.equal(detectCampus('todos los campus').all, true);
});

test('recupera la búsqueda pendiente al responder con un número', () => {
  const history = [
    { role: 'user', parts: [{ text: 'Busca libros sobre administración de inventarios' }] },
    { role: 'model', parts: [{ text: 'Para revisar la disponibilidad de “administración de inventarios”, necesito saberlo: ¿en qué campus quieres consultar?' }] },
    { role: 'user', parts: [{ text: '1' }] }
  ];
  const result = detectCampusFollowUp(history, '1');
  assert.equal(result.query, 'administración de inventarios');
  assert.equal(result.campus.code, 'NAI');
  assert.equal(result.resumed, true);
});

test('recupera la búsqueda pendiente al responder con todos los campus', () => {
  const history = [
    { role: 'user', parts: [{ text: '¿Tienen libros de cálculo?' }] },
    { role: 'model', parts: [{ text: '¿En qué campus quieres consultar?' }] },
    { role: 'user', parts: [{ text: 'Todos los campus' }] }
  ];
  const result = detectCampusFollowUp(history, 'Todos los campus');
  assert.equal(result.query, 'cálculo');
  assert.equal(result.campus.all, true);
});


test('no interpreta la palabra centro como campus dentro del tema buscado', () => {
  const result = detectCatalogSearch('Busca libros sobre centro de gravedad');
  assert.equal(result.needsCampus, true);
  assert.equal(result.query, 'centro de gravedad');
});

test('no interpreta Guaymas como campus cuando forma parte del tema sin preposición de ubicación', () => {
  const result = detectCatalogSearch('Busca libros sobre Guaymas');
  assert.equal(result.needsCampus, true);
  assert.equal(result.query, 'Guaymas');
});


test('quita la selección de todos los campus del término de búsqueda', () => {
  const result = detectCatalogSearch('Busca libros sobre administración de inventarios en todos los campus');
  assert.equal(result.query, 'administración de inventarios');
  assert.equal(result.campus.all, true);
  assert.equal(result.needsCampus, false);
});

test('reanuda la búsqueda cuando el campus se elige desde la tarjeta conversacional', () => {
  const query = 'Busca libros sobre administración de inventarios';
  const history = [
    { role: 'user', parts: [{ text: query }] },
    { role: 'model', parts: [{ text: 'Para revisar la disponibilidad de “administración de inventarios”, necesito saberlo: ¿en qué campus quieres consultar?' }] },
    { role: 'user', parts: [{ text: 'Obregón Náinari' }] }
  ];
  const result = detectCampusFollowUp(history, 'Obregón Náinari');
  assert.equal(result.query, 'administración de inventarios');
  assert.equal(result.campus.code, 'NAI');
  assert.equal(result.needsCampus, false);
});
