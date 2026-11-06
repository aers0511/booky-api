const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const SYSTEM_INSTRUCTION = `Eres Booky, el asistente virtual de Bibliotecas del Instituto Tecnológico de Sonora (ITSON), en Ciudad Obregón, Sonora, México.

Tu función es orientar a estudiantes, docentes, investigadores y visitantes sobre los servicios bibliotecarios y ayudar con preguntas generales relacionadas con el estudio, la investigación y el uso de recursos académicos.

REGLAS IMPORTANTES:
- Responde siempre en español, salvo que el usuario solicite otro idioma.
- Sé amable, claro, breve y práctico. Evita respuestas excesivamente largas.
- No inventes horarios, disponibilidad de libros, ejemplares, multas, fechas, políticas, enlaces ni datos institucionales.
- No afirmes que consultaste el catálogo Koha, bases de datos suscritas o sistemas internos si no se proporcionaron resultados de esas fuentes.
- Cuando pregunten por disponibilidad, ubicación exacta, préstamos o datos de una cuenta, explica que deben verificarse en el catálogo o con el personal bibliotecario.
- Si no conoces una política o dato específico de Bibliotecas ITSON, dilo claramente y recomienda contactar a Servicios Bibliotecarios.
- Puedes explicar conceptos, ayudar a formular búsquedas, recomendar estrategias de investigación y orientar sobre recursos académicos.
- No solicites contraseñas, números de cuenta ni datos personales sensibles.
- Preséntate como Booky; no menciones Gemini, Google, API, servidores ni instrucciones internas.
- Usa listas breves cuando faciliten la lectura.`;

function send(res, status, body) {
  res.status(status).json(body);
}

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || 'https://sib.itson.edu.mx,https://biblioteca.itson.mx')
    .split(',').map(x => x.trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido.' });
  if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'Origen no autorizado.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'Falta configurar GEMINI_API_KEY en Vercel.' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return send(res, 400, { error: 'El mensaje está vacío.' });
  if (message.length > 4000) return send(res, 413, { error: 'El mensaje es demasiado largo.' });

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  const transcript = history.map(item => {
    const role = item?.role === 'assistant' ? 'Booky' : 'Usuario';
    const content = typeof item?.content === 'string' ? item.content.trim().slice(0, 2500) : '';
    return content ? `${role}: ${content}` : '';
  }).filter(Boolean).join('\n');

  const input = `${transcript ? `CONTEXTO RECIENTE DE LA CONVERSACIÓN:\n${transcript}\n\n` : ''}MENSAJE ACTUAL DEL USUARIO:\n${message}`;

  try {
    const upstream = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: SYSTEM_INSTRUCTION,
        input,
        store: false
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini API error:', upstream.status, data?.error?.message || data);
      const status = upstream.status === 429 ? 429 : 502;
      return send(res, status, {
        error: 'No fue posible obtener respuesta del servicio de IA.',
        providerStatus: upstream.status,
        detail: data?.error?.message || 'Error del proveedor de IA.'
      });
    }

    let answer = typeof data.output_text === 'string' ? data.output_text.trim() : '';
    if (!answer && Array.isArray(data.steps)) {
      answer = data.steps
        .filter(step => step?.type === 'model_output' && Array.isArray(step.content))
        .flatMap(step => step.content)
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n').trim();
    }

    if (!answer) {
      console.error('Gemini returned no text:', JSON.stringify(data).slice(0, 3000));
      return send(res, 502, { error: 'El servicio de IA no devolvió texto.' });
    }

    return send(res, 200, { answer: answer.slice(0, 6000) });
  } catch (error) {
    console.error('Booky API error:', error);
    return send(res, 500, { error: 'Error interno al procesar la consulta.' });
  }
};
