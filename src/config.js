const DEFAULT_ORIGINS = [
  'https://sib.itson.edu.mx',
  'https://biblioteca.itson.mx'
];

function csv(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function getConfig() {
  const kohaBase = (process.env.KOHA_BASE_URL || 'https://sib.itson.edu.mx')
    .trim()
    .replace(/\/+$/, '');

  return {
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/'
    },
    acquisitions: {
      apiKey: process.env.ACQUISITIONS_API_KEY || '',
      maxBooks: Math.min(Math.max(Number(process.env.ACQUISITIONS_MAX_BOOKS || 15), 1), 30),
      maxResults: Math.min(Math.max(Number(process.env.ACQUISITIONS_MAX_RESULTS || 10), 1), 20)
    },
    http: {
      allowedOrigins: csv(process.env.ALLOWED_ORIGINS, DEFAULT_ORIGINS),
      requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 27000)
    },
    koha: {
      enabled: String(process.env.KOHA_ENABLED || 'false').toLowerCase() === 'true',
      askCampus: String(process.env.KOHA_ASK_CAMPUS || 'true').toLowerCase() === 'true',
      baseUrl: kohaBase,
      apiPath: (process.env.KOHA_API_PATH || '/api/v1').replace(/^\/?/, '/').replace(/\/+$/, ''),
      username: process.env.KOHA_API_USERNAME || '',
      password: process.env.KOHA_API_PASSWORD || '',
      timeoutMs: Number(process.env.KOHA_TIMEOUT_MS || 5000),
      maxResults: Math.min(Math.max(Number(process.env.KOHA_MAX_RESULTS || 5), 1), 10),
      maxItemsPerBiblio: Math.min(Math.max(Number(process.env.KOHA_MAX_ITEMS || 40), 1), 100)
    }
  };
}

module.exports = { getConfig };
