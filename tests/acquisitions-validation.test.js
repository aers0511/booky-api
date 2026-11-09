const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validIsbn,
  validIssn,
  identifierStatus,
  scoreMatch,
  summarizeHoldings
} = require('../src/features/acquisitions/validate');

test('valida ISBN-13', () => {
  assert.equal(validIsbn('978-0-306-40615-7'), true);
  assert.equal(validIsbn('978-0-306-40615-8'), false);
});

test('valida ISBN-10', () => {
  assert.equal(validIsbn('0-8044-2957-X'), true);
});

test('valida ISSN', () => {
  assert.equal(validIssn('0378-5955'), true);
  assert.equal(validIssn('0378-5956'), false);
});

test('prioriza coincidencia exacta de identificador', () => {
  const match = scoreMatch(
    { title: 'Otro título', author: '', identifier: '9780306406157' },
    { title: 'Libro en Koha', author: '', isbn: '9780306406157' }
  );
  assert.equal(match.level, 'exact_match');
  assert.equal(match.score, 100);
});

test('reconoce título y autor equivalentes ignorando acentos y mayúsculas', () => {
  const match = scoreMatch(
    { title: 'Administracion de inventarios', author: 'Carlos Garcia', identifier: '' },
    { title: 'Administración de inventarios', author: 'Carlos García', isbn: '' }
  );
  assert.equal(match.level, 'exact_match');
});

test('no declara exacto un título idéntico con autor diferente', () => {
  const match = scoreMatch(
    { title: 'Administración de inventarios', author: 'Carlos A. García', identifier: '' },
    { title: 'Administración de inventarios', author: 'Matthew A. Waller', isbn: '9786073241137' }
  );
  assert.equal(match.level, 'possible_match');
  assert.equal(match.authorSimilar, false);
  assert.equal(match.score, 84);
});

test('reconoce autores con inicial omitida y orden distinto', () => {
  const match = scoreMatch(
    { title: 'Administración de inventarios', author: 'Carlos A García', identifier: '' },
    { title: 'Administración de inventarios', author: 'García, Carlos', isbn: '' }
  );
  assert.equal(match.level, 'exact_match');
});

test('no considera autor parecido por compartir solamente una inicial', () => {
  const match = scoreMatch(
    { title: 'Administración de inventarios', author: 'Carlos A García', identifier: '' },
    { title: 'Administración de inventarios', author: 'Matthew A Waller', isbn: '' }
  );
  assert.equal(match.level, 'possible_match');
  assert.equal(match.authorSimilar, false);
});

test('consolida ejemplares por biblioteca sin perder el conteo', () => {
  const summary = summarizeHoldings([
    { campus: 'Guaymas', branchCode: 'GYM', callnumber: '658.871 W198a', status: 'Disponible' },
    { campus: 'Guaymas', branchCode: 'GYM', callnumber: '658.871 W198a', status: 'Disponible' },
    { campus: 'Navojoa', branchCode: 'NAV', callnumber: '658.871 W198a', status: 'Prestado' }
  ]);
  assert.equal(summary.length, 2);
  assert.equal(summary.find(item => item.branch_code === 'GYM').quantity, 2);
  assert.equal(summary.find(item => item.branch_code === 'NAV').quantity, 1);
});
