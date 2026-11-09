const { detectCatalogIntent } = require('./intent');
const { searchBiblios, isConfigured, KohaError } = require('../../integrations/koha/client');
const {
  buildCatalogContext,
  CATALOG_SYSTEM_ADDENDUM,
  noResultsAnswer,
  unavailableAnswer
} = require('./prompt');

const CATALOG_URL = 'https://sib.itson.edu.mx/cgi-bin/koha/opac-search.pl';

function campusClarificationAnswer(query) {
  return [
    `¡Claro! Para revisar la disponibilidad de **${query}**, ¿en qué campus quieres consultar?`,
    '',
    'Responde con el número o el nombre del campus:',
    '1. Obregón Náinari',
    '2. Obregón Centro',
    '3. Guaymas',
    '4. Empalme',
    '5. Navojoa',
    '6. Todos los campus',
    '',
    'También puedes escribir el campus directamente.'
  ].join('\n');
}

function filterByCampus(search, campus) {
  if (!campus) return search;
  if (campus.all) return { ...search, campus };

  const results = search.results
    .map(record => ({
      ...record,
      items: (record.items || []).filter(item => item.branchCode === campus.code)
    }))
    .filter(record => record.items.length > 0);

  return { ...search, results, totalReturned: results.length, campus };
}

function noCampusResultsAnswer(query, campus) {
  return `Encontré registros relacionados con **${query}**, pero Koha no devolvió ejemplares asociados a **${campus.label}**. Esto no significa necesariamente que el libro no exista en el acervo; puedes consultar [el catálogo completo](${CATALOG_URL}) o pedirme que revise todos los campus.`;
}

const catalogFeature = {
  id: 'catalog-search',
  detect({ message, history }) {
    return detectCatalogIntent({ message, history });
  },
  async execute({ intent, config }) {
    if (!isConfigured(config.koha)) {
      return {
        handled: true,
        answer: 'La búsqueda directa en el catálogo todavía no está configurada. Puedes consultar el catálogo de Bibliotecas ITSON aquí: ' + CATALOG_URL,
        context: null
      };
    }

    if (intent.needsCampus && config.koha.askCampus) {
      return {
        handled: true,
        answer: campusClarificationAnswer(intent.query),
        context: null,
        clarification: true
      };
    }

    try {
      let search = await searchBiblios(config.koha, intent.query);
      if (!search.results.length) {
        return {
          handled: true,
          answer: noResultsAnswer(intent.query, CATALOG_URL),
          context: null
        };
      }

      if (intent.campus && !intent.campus.all) {
        search = filterByCampus(search, intent.campus);
        if (!search.results.length) {
          return {
            handled: true,
            answer: noCampusResultsAnswer(intent.query, intent.campus),
            context: null
          };
        }
      }

      return {
        handled: false,
        context: buildCatalogContext(search),
        systemAddendum: CATALOG_SYSTEM_ADDENDUM,
        search
      };
    } catch (error) {
      console.error('Booky Koha catalog error:', {
        code: error?.code || 'unknown',
        status: error?.status || 0,
        message: error?.message || 'unknown'
      });

      return {
        handled: true,
        answer: unavailableAnswer(CATALOG_URL),
        context: null,
        catalogError: error instanceof KohaError ? error.code : 'unknown'
      };
    }
  }
};

module.exports = { catalogFeature, campusClarificationAnswer, filterByCampus };
