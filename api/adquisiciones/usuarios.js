const crypto = require('node:crypto');
const { getConfig } = require('../../src/config');
const { send, applyCors } = require('../../src/http');
const { searchPatronByCardnumber } = require('../../src/integrations/koha/client');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

module.exports = async function handler(req, res) {
  const config = getConfig();
  res.setHeader('Cache-Control', 'no-store');
  const cors = applyCors(req, res, config.http.allowedOrigins);
  if (cors.handled) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return send(res, 405, { error: 'Método no permitido. Utiliza GET.' });
  }

  if (!config.acquisitions.apiKey) {
    return send(res, 503, { error: 'El módulo de adquisiciones no está habilitado.' });
  }

  const suppliedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!safeEqual(suppliedKey, config.acquisitions.apiKey)) {
    return send(res, 401, { error: 'No autorizado.' });
  }

  try {
    const result = await searchPatronByCardnumber(config.kohaPatrons, req.query?.cardnumber);
    return send(res, 200, {
      success: true,
      endpoint: 'adquisiciones.usuarios',
      ...result
    });
  } catch (error) {
    const status = Number(error?.status) || 502;
    if (status >= 500) {
      console.error('Booky acquisitions patron search error:', {
        name: error?.name,
        status,
        code: error?.code
      });
    }
    return send(res, status, {
      success: false,
      error: error.message || 'No fue posible consultar el usuario en Koha.',
      code: error.code || 'patron_search_error'
    });
  }
};
