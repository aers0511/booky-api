const { catalogFeature } = require('./catalog');

// Registro de funcionalidades. Para añadir una nueva función:
// 1. Crea un módulo dentro de src/features/<nombre>/.
// 2. Expón detect() y execute().
// 3. Regístralo en este arreglo.
// Cada módulo decide si procesa el mensaje o deja continuar a Gemini.
const FEATURES = [
  catalogFeature
];

async function runFeature(context) {
  for (const feature of FEATURES) {
    const intent = feature.detect(context);
    if (!intent) continue;

    const result = await feature.execute({ ...context, intent });
    if (result) return { feature: feature.id, ...result };
  }

  return null;
}

module.exports = { FEATURES, runFeature };
