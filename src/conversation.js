function normalizeHistory(history, currentMessage) {
  const items = Array.isArray(history) ? history.slice(-8) : [];
  const contents = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const text = typeof item?.content === 'string'
      ? item.content.trim().slice(0, 2000)
      : '';

    if (!text) continue;

    const role =
      item?.role === 'assistant' || item?.role === 'model'
        ? 'model'
        : 'user';

    if (
      role === 'user' &&
      text === currentMessage &&
      i === items.length - 1
    ) continue;

    const previous = contents[contents.length - 1];

    if (previous && previous.role === role) {
      previous.parts[0].text += '\n' + text;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  while (contents.length && contents[0].role !== 'user') {
    contents.shift();
  }

  const last = contents[contents.length - 1];

  if (
    last &&
    last.role === 'user' &&
    last.parts[0].text.trim() === currentMessage
  ) {
    // El mensaje actual ya está incluido.
  } else if (last && last.role === 'user') {
    last.parts[0].text += '\n\nMensaje actual: ' + currentMessage;
  } else {
    contents.push({ role: 'user', parts: [{ text: currentMessage }] });
  }

  return contents;
}

function appendToLatestUserMessage(contents, text) {
  const copy = contents.map(item => ({
    role: item.role,
    parts: item.parts.map(part => ({ ...part }))
  }));

  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'user') {
      copy[i].parts[0].text += '\n\n' + text;
      return copy;
    }
  }

  return copy;
}

module.exports = { normalizeHistory, appendToLatestUserMessage };
