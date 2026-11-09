async function generateText({
  apiKey,
  model,
  baseUrl,
  systemInstruction,
  contents,
  generationConfig = {},
  timeoutMs = 15000
}) {
  const endpoint = `${baseUrl}${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: {
          temperature: 0.65,
          maxOutputTokens: 1000,
          ...generationConfig
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => typeof part.text === 'string' ? part.text : '')
      .join('\n')
      .trim();

    if (!answer) throw new Error('Gemini no devolvió texto.');
    return answer.slice(0, 8000);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateText };
