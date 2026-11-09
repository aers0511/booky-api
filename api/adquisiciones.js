const crypto = require('node:crypto');
const { getConfig } = require('../src/config');
const { send, applyCors } = require('../src/http');
const { normalizeBooks } = require('../src/features/acquisitions/normalize');
const { validateBookAgainstCatalog } = require('../src/features/acquisitions/validate');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function cleanBook(book, index) {
  if (!book || typeof book !== 'object' || Array.isArray(book)) {
    throw new Error(`El libro ${index + 1} no tiene un formato válido.`);
  }
  const fields = ['title', 'author', 'publisher', 'edition', 'year', 'identifier'];
  const result = {};
  for (const field of fields) {
    const value = book[field];
    result[field] = typeof value === 'string' || typeof value === 'number'
      ? String(value).trim().slice(0, 500) : '';
  }
  result.identifier_type = ['ISBN', 'ISSN', 'UNKNOWN'].includes(book.identifier_type)
    ? book.identifier_type : 'UNKNOWN';
  result.quantities = book.quantities && typeof book.quantities === 'object' && !Array.isArray(book.quantities)
    ? book.quantities : {};
  if (!result.title) throw new Error(`El libro ${index + 1} necesita un título.`);
  return result;
}

module.exports = async function handler(req, res) {
  const config = getConfig();
  const cors = applyCors(req, res, config.http.allowedOrigins);
  if (cors.handled) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return send(res, 405, { error: 'Método no permitido. Utiliza POST.' });
  }

  if (!config.acquisitions.apiKey) {
    return send(res, 503, { error: 'El endpoint de adquisiciones no está habilitado. Configura ACQUISITIONS_API_KEY en Vercel.' });
  }

  const suppliedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!safeEqual(suppliedKey, config.acquisitions.apiKey)) {
    return send(res, 401, { error: 'No autorizado.' });
  }

  if (!config.gemini.apiKey) {
    return send(res, 503, { error: 'La normalización con IA no está configurada.' });
  }

  let books;
  try {
    const rawBooks = Array.isArray(req.body?.books)
      ? req.body.books
      : req.body?.book ? [req.body.book] : [];
    if (!rawBooks.length) return send(res, 400, { error: 'Envía al menos un libro en el campo books.' });
    if (rawBooks.length > config.acquisitions.maxBooks) {
      return send(res, 413, { error: `Puedes validar hasta ${config.acquisitions.maxBooks} libros por solicitud.` });
    }
    books = rawBooks.map(cleanBook);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }

  try {
    const normalized = await normalizeBooks({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      baseUrl: config.gemini.baseUrl,
      books: books.map(({ quantities, ...book }) => book),
      timeoutMs: Math.min(15000, config.http.requestTimeoutMs)
    });

    const results = [];
    for (let i = 0; i < books.length; i++) {
      const original = books[i];
      const normalizedBook = normalized[i];
      const catalog = await validateBookAgainstCatalog(config, normalizedBook);
      const warnings = [...normalizedBook.notes];

      if (catalog.status === 'exact_match') {
        warnings.push('Se encontró una coincidencia bibliográfica fuerte en el catálogo. Puedes solicitar ejemplares adicionales, pero se recomienda justificar la necesidad.');
      } else if (catalog.status === 'possible_match') {
        warnings.push('Se encontraron registros con información bibliográfica similar. Valora cuidadosamente si cada resultado corresponde realmente al libro que estás solicitando. Verifica especialmente el autor, la editorial, la edición, el año y el ISBN; no asumas que se trata del mismo libro únicamente porque el título coincida.');
      } else if (catalog.status === 'not_found') {
        warnings.push('No se encontraron coincidencias con los criterios consultados. Esto no sustituye la revisión bibliotecaria.');
      } else {
        warnings.push('La validación del catálogo quedó pendiente. No se puede confirmar si el material existe.');
      }

      results.push({
        index: i,
        status: catalog.status,
        original: {
          title: original.title,
          author: original.author,
          publisher: original.publisher,
          edition: original.edition,
          year: original.year,
          identifier: original.identifier
        },
        normalized: normalizedBook,
        quantities: original.quantities,
        validation: {
          catalog_checked: catalog.catalog_checked,
          identifier: catalog.identifier_validation || null,
          matches_found: catalog.matches_found ?? catalog.matches.length,
          matches_returned: catalog.matches.length,
          decision: catalog.status === 'pending' ? 'pending_review' :
            catalog.status === 'not_found' ? 'no_match_found' : 'review_match'
        },
        matches: catalog.matches,
        warnings
      });
    }

    return send(res, 200, {
      success: true,
      endpoint: 'adquisiciones',
      catalog_scope: 'all_branches',
      books_checked: results.length,
      results
    });
  } catch (error) {
    console.error('Booky acquisitions error:', {
      name: error?.name,
      status: error?.status,
      message: error?.message
    });
    return send(res, 502, {
      error: 'No fue posible normalizar los datos bibliográficos. No se realizó una validación del catálogo.',
      detail: error?.status === 429 ? 'gemini_rate_limit' : 'normalization_error'
    });
  }
};
