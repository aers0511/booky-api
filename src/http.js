function send(res, status, body) {
  return res.status(status).json(body);
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return { handled: true, forbidden: false };
  }

  if (origin && !allowedOrigins.includes(origin)) {
    send(res, 403, { error: 'Origen no autorizado.' });
    return { handled: true, forbidden: true };
  }

  return { handled: false, forbidden: false };
}

module.exports = { send, applyCors };
