const { detectCatalogSearch } = require('./intent');
const { searchBiblios, isConfigured, KohaError } = require('../../integrations/koha/client');
const {
  buildCatalogContext,
  CATALOG_SYSTEM_ADDENDUM,
  noResultsAnswer,
  unavailableAnswer
} = require('./prompt');

const CATALOG_URL = 'https://sib.itson.edu.mx/cgi-bin/koha/opac-search.pl';

const catalogFeature = {
  id: 'catalog-search',
  detect({ message }) {
    return detectCatalogSearch(message);
  },
  async execute({ intent, config }) {
    if (!isConfigured(config.koha)) {
      return {
        handled: true,
        answer: 'La búsqueda directa en el catálogo todavía no está configurada. Puedes consultar el catálogo de Bibliotecas ITSON aquí: ' + CATALOG_URL,
        context: null
      };
    }

    try {
      const search = await searchBiblios(config.koha, intent.query);
      if (!search.results.length) {
        return {
          handled: true,
          answer: noResultsAnswer(intent.query, CATALOG_URL),
          context: null
        };
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

module.exports = { catalogFeature };
