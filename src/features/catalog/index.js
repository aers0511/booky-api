const { detectCatalogIntent, CAMPUSES } = require('./intent');
const { searchBiblios, isConfigured, KohaError } = require('../../integrations/koha/client');
const { noResultsAnswer, unavailableAnswer } = require('./prompt');

const CATALOG_URL = 'https://sib.itson.edu.mx/cgi-bin/koha/opac-search.pl';

function campusClarificationAnswer(query) {
  return `Encontré el tema de tu búsqueda: “${query}”. Para revisar dónde hay ejemplares, ¿en qué campus quieres consultar? Puedes elegir Náinari, Centro, Guaymas, Empalme, Navojoa o todos los campus.`;
}

function filterByCampus(search, campus) {
  if (!campus || campus.all) return { ...search, campus };

  const results = search.results
    .map(record => ({
      ...record,
      items: (record.items || []).filter(item => item.branchCode === campus.code)
    }))
    .filter(record => record.items.length > 0);

  return { ...search, results, totalReturned: results.length, campus };
}

function noCampusResultsAnswer(query, campus) {
  return `El catálogo sí devolvió registros relacionados con “${query}”, pero no aparecen ejemplares asociados a ${campus.label} en esta consulta. Puedes revisar todas las bibliotecas para localizar otras copias.`;
}

const CAMPUS_OPTIONS = CAMPUSES
  .filter(campus => campus.code !== 'BV')
  .map(campus => ({ code: campus.code, label: campus.label }));
CAMPUS_OPTIONS.push({ code: 'ALL', label: 'Todos los campus' });

const catalogFeature = {
  id: 'catalog-search',
  detect({ message, history }) {
    return detectCatalogIntent({ message, history });
  },
  async execute({ intent, config }) {
    if (!isConfigured(config.koha)) {
      return {
        handled: true,
        answer: 'La búsqueda directa en el catálogo todavía no está configurada. Puedes consultar el catálogo de Bibliotecas ITSON directamente.',
        ui: { type: 'catalog_unavailable', catalogUrl: CATALOG_URL }
      };
    }

    if (intent.needsCampus && config.koha.askCampus) {
      return {
        handled: true,
        answer: campusClarificationAnswer(intent.query),
        ui: {
          type: 'catalog_clarification',
          query: intent.query,
          campuses: CAMPUS_OPTIONS,
          catalogUrl: CATALOG_URL
        },
        clarification: true
      };
    }

    try {
      let search = await searchBiblios(config.koha, intent.query);

      if (intent.campus && !intent.campus.all) {
        search = filterByCampus(search, intent.campus);
      }

      if (!search.results.length) {
        const answer = intent.campus && !intent.campus.all
          ? noCampusResultsAnswer(intent.query, intent.campus)
          : noResultsAnswer(intent.query, CATALOG_URL);

        return {
          handled: true,
          answer,
          ui: {
            type: 'catalog_empty',
            query: intent.query,
            campus: intent.campus?.label || 'Todos los campus',
            catalogUrl: CATALOG_URL
          }
        };
      }

      const campusLabel = intent.campus?.label || 'Todos los campus';
      const answer = `La búsqueda de “${intent.query}” devolvió ${search.totalReturned} registro${search.totalReturned === 1 ? '' : 's'} bibliográfico${search.totalReturned === 1 ? '' : 's'} en ${campusLabel}. Revisa las tarjetas para ver los ejemplares y su disponibilidad por biblioteca; los datos corresponden a la consulta realizada en Koha.`;

      return {
        handled: true,
        answer,
        ui: {
          type: 'catalog_results',
          query: intent.query,
          campus: campusLabel,
          totalReturned: search.totalReturned,
          results: search.results,
          catalogUrl: CATALOG_URL
        }
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
        ui: {
          type: 'catalog_error',
          catalogUrl: CATALOG_URL,
          message: error instanceof KohaError ? error.message : ''
        },
        catalogError: error instanceof KohaError ? error.code : 'unknown'
      };
    }
  }
};

module.exports = { catalogFeature, campusClarificationAnswer, filterByCampus };
