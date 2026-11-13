/******************************************************
 * SISTEMA DE SOLICITUDES BIBLIOGRÁFICAS - ITSON
 * Backend: Google Apps Script
 * Modelo de datos: Opción B
 ******************************************************/

const CONFIG = {
  SPREADSHEET_ID: '12pTuf4xPNFLhD6pLftxtNhfYQFWlsqmcsbv1IM-WeNw',

  // Agregar aquí los correos autorizados cuando estén disponibles.
  ADMIN_EMAILS: [
  'jose.arrayales54814@potros.itson.edu.mx'
],

  DOMAIN_ADMIN: '@potros.itson.edu.mx',

  SHEET_SOLICITUDES: 'Solicitudes',
  SHEET_DETALLES: 'DetalleLibros',
  SHEET_HISTORICA: 'Requerimientos',

  CAMPUS: [
    'Centro',
    'Náinari',
    'Guaymas',
    'Navojoa',
    'Empalme'
  ]
};

const HEADERS_SOLICITUDES = [
  'Folio',
  'Fecha',
  'Hora',
  'Correo',
  'Solicitante',
  'Extensión',
  'Programa educativo',
  'Materia',
  'Justificación',
  'Estado',
  'Cardnumber Koha',
  'Borrowernumber Koha'
];

const HEADERS_DETALLES = [
  'Folio',
  'Número de libro',
  'Título',
  'Autor',
  'Editorial',
  'Edición',
  'Año',
  'ISBN/ISSN',
  'Centro',
  'Náinari',
  'Guaymas',
  'Navojoa',
  'Empalme',
  'Total'
];


/******************************************************
 * NAVEGACIÓN ENTRE FORMULARIO Y ADMINISTRACIÓN
 ******************************************************/

function doGet(e) {
  const vista = e && e.parameter ? e.parameter.vista : '';

  const archivo = vista === 'admin' ? 'Admin' : 'Index';

  return HtmlService.createTemplateFromFile(archivo)
    .evaluate()
    .setTitle('Solicitudes de Material Bibliográfico - ITSON')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(nombreArchivo) {
  return HtmlService.createHtmlOutputFromFile(nombreArchivo).getContent();
}


/******************************************************
 * CONEXIÓN CON GOOGLE SHEETS
 ******************************************************/

function obtenerLibro_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/**
 * Prepara exclusivamente las dos pestañas nuevas.
 * No modifica ni sobrescribe la pestaña histórica.
 */
function prepararBaseDatos() {
  const libro = obtenerLibro_();

  crearHojaSiNoExiste_(
    libro,
    CONFIG.SHEET_SOLICITUDES,
    HEADERS_SOLICITUDES
  );

  crearHojaSiNoExiste_(
    libro,
    CONFIG.SHEET_DETALLES,
    HEADERS_DETALLES
  );

  asegurarEncabezadosSolicitudes_(
    libro.getSheetByName(CONFIG.SHEET_SOLICITUDES)
  );

  return 'Base de datos preparada correctamente.';
}

function crearHojaSiNoExiste_(libro, nombre, encabezados) {
  let hoja = libro.getSheetByName(nombre);

  if (!hoja) {
    hoja = libro.insertSheet(nombre);
    hoja.getRange(1, 1, 1, encabezados.length)
      .setValues([encabezados]);

    hoja.setFrozenRows(1);
    hoja.getRange(1, 1, 1, encabezados.length)
      .setFontWeight('bold');

  } else if (hoja.getLastRow() === 0) {
    hoja.getRange(1, 1, 1, encabezados.length)
      .setValues([encabezados]);

    hoja.setFrozenRows(1);
  }
}


/**
 * Agrega columnas nuevas al final sin alterar el orden ni los datos históricos.
 */
function asegurarEncabezadosSolicitudes_(hoja) {
  if (!hoja) throw new Error('No se encontró la hoja de solicitudes.');

  const ultimaColumna = Math.max(hoja.getLastColumn(), HEADERS_SOLICITUDES.length);
  const actuales = hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0];
  const faltantes = HEADERS_SOLICITUDES.filter(encabezado =>
    actuales.indexOf(encabezado) === -1
  );

  if (faltantes.length) {
    const columnaInicial = hoja.getLastColumn() + 1;
    hoja.getRange(1, columnaInicial, 1, faltantes.length)
      .setValues([faltantes])
      .setFontWeight('bold');
  }

  hoja.setFrozenRows(1);
}


/******************************************************
 * IDENTIFICACIÓN Y PERMISOS
 ******************************************************/

function obtenerCorreoUsuario_() {
  return String(
    Session.getActiveUser().getEmail() || ''
  ).trim().toLowerCase();
}

function validarAdministrador_() {
  const correo = obtenerCorreoUsuario_();

  if (!correo) {
    throw new Error(
      'No fue posible identificar tu cuenta institucional. ' +
      'Verifica el despliegue de la aplicación.'
    );
  }

  if (!correo.endsWith(CONFIG.DOMAIN_ADMIN)) {
    throw new Error('Tu cuenta no tiene autorización administrativa.');
  }

  const autorizados = CONFIG.ADMIN_EMAILS.map(
    correo => correo.toLowerCase().trim()
  );

  if (!autorizados.includes(correo)) {
    throw new Error(
      'Tu cuenta institucional todavía no está autorizada como administradora.'
    );
  }

  return correo;
}


/******************************************************
 * GENERACIÓN DE FOLIOS
 ******************************************************/

function generarFolio_(hoja) {
  const anio = new Date().getFullYear();
  const ultimaFila = hoja.getLastRow();

  let consecutivo = 1;

  if (ultimaFila >= 2) {
    const folios = hoja
      .getRange(2, 1, ultimaFila - 1, 1)
      .getDisplayValues()
      .flat();

    const prefijo = 'RB-' + anio + '-';

    const consecutivos = folios
      .filter(folio => folio.startsWith(prefijo))
      .map(folio => Number(folio.substring(prefijo.length)))
      .filter(numero => Number.isFinite(numero));

    if (consecutivos.length > 0) {
      consecutivo = Math.max(...consecutivos) + 1;
    }
  }

  return 'RB-' + anio + '-' +
    String(consecutivo).padStart(6, '0');
}



/******************************************************
 * CONEXIÓN SEGURA CON BOOKY API
 * La clave se guarda en Propiedades del script.
 ******************************************************/

const BOOKY_API_BASE_URL = 'https://booky-api.vercel.app';

function bookyApiRequest_(ruta, opciones) {
  const propiedades = PropertiesService.getScriptProperties();
  const apiKey = propiedades.getProperty('BOOKY_ACQUISITIONS_API_KEY');

  if (!apiKey) {
    throw new Error(
      'Falta configurar BOOKY_ACQUISITIONS_API_KEY en las Propiedades del script.'
    );
  }

  const respuesta = UrlFetchApp.fetch(BOOKY_API_BASE_URL + ruta, {
    method: opciones.method || 'get',
    contentType: 'application/json',
    headers: Object.assign({}, opciones.headers || {}, {
      'x-api-key': apiKey
    }),
    payload: opciones.payload,
    muteHttpExceptions: true
  });

  const codigo = respuesta.getResponseCode();
  const texto = respuesta.getContentText();
  let datos;

  try {
    datos = texto ? JSON.parse(texto) : {};
  } catch (error) {
    throw new Error('Booky API devolvió una respuesta que no es JSON válido.');
  }

  if (codigo < 200 || codigo >= 300) {
    throw new Error(
      datos.error ||
      datos.detail ||
      ('Booky API respondió con el código HTTP ' + codigo + '.')
    );
  }

  return datos;
}

/**
 * Busca una persona por número de tarjeta en Koha.
 * Esta función se ejecuta en Apps Script, nunca desde el navegador directamente.
 */
function buscarSolicitante(cardnumber) {
  const tarjeta = String(cardnumber || '').trim();

  if (!tarjeta || tarjeta.length > 64) {
    throw new Error('Captura un número de tarjeta válido.');
  }

  const ruta = '/api/adquisiciones/usuarios?cardnumber=' +
    encodeURIComponent(tarjeta);

  const resultado = bookyApiRequest_(ruta, { method: 'get' });

  // La API puede responder con success/found y results.
  // No se exige found cuando el backend devuelve una lista de resultados válida.
  if (!resultado || typeof resultado !== 'object') {
    throw new Error('Booky API devolvió una respuesta vacía o inválida.');
  }

  if (resultado.success === false) {
    throw new Error(
      resultado.error || resultado.message ||
      'Booky API no pudo consultar los usuarios de Koha.'
    );
  }

  if (!Array.isArray(resultado.results)) {
    throw new Error(
      resultado.error || 'La respuesta de usuarios no contiene una lista results.'
    );
  }

  return resultado;
}

/**
 * Revalida en el servidor que el cardnumber y borrowernumber correspondan.
 * No se confía únicamente en los campos ocultos enviados por el navegador.
 */
function verificarSolicitanteKoha_(cardnumber, borrowernumber) {
  const resultado = buscarSolicitante(cardnumber);

  if (
    resultado.found === false ||
    !Array.isArray(resultado.results) ||
    resultado.results.length === 0
  ) {
    throw new Error('No se encontró el número de tarjeta en Koha.');
  }

  const coincidencias = resultado.results.filter(usuario =>
    String(usuario.cardnumber || '').trim() === String(cardnumber || '').trim()
  );

  if (coincidencias.length !== 1) {
    throw new Error(
      'La búsqueda no devolvió un usuario único. Verifica el número de tarjeta con Bibliotecas.'
    );
  }

  const usuario = coincidencias[0];

  if (
    String(usuario.borrowernumber) !== String(borrowernumber) ||
    !usuario.borrowernumber
  ) {
    throw new Error(
      'Los datos del solicitante ya no coinciden con Koha. Vuelve a buscarlo.'
    );
  }

  return usuario;
}

/**
 * Valida los libros de la solicitud contra el catálogo mediante Booky API.
 * La validación es informativa y no impide registrar la solicitud.
 */
function validarLibrosBooky(librosFormulario) {
  if (!Array.isArray(librosFormulario) || librosFormulario.length === 0) {
    throw new Error('Agrega al menos un libro antes de validarlo.');
  }

  const codigosCampus = {
    'Centro': 'CEN',
    'Náinari': 'NAI',
    'Guaymas': 'GYM',
    'Navojoa': 'NAV',
    'Empalme': 'EMPL'
  };

  const books = librosFormulario.map((libro, indice) => {
    const cantidades = {};
    Object.keys(codigosCampus).forEach(campus => {
      cantidades[codigosCampus[campus]] =
        Number((libro.cantidades || {})[campus] || 0);
    });

    const identificador = String(libro.isbn || '').trim();
    let tipoIdentificador = 'UNKNOWN';

    if (/^(97[89])?\d{9}[\dXx]$/.test(identificador)) {
      tipoIdentificador = 'ISBN';
    } else if (/^\d{7}[\dXx]$/.test(identificador)) {
      tipoIdentificador = 'ISSN';
    }

    return {
      title: String(libro.titulo || '').trim(),
      author: String(libro.autor || '').trim(),
      publisher: String(libro.editorial || '').trim(),
      edition: String(libro.edicion || '').trim(),
      year: String(libro.anio || '').trim(),
      identifier: identificador,
      identifier_type: tipoIdentificador,
      quantities: cantidades
    };
  });

  const respuesta = bookyApiRequest_('/api/adquisiciones', {
    method: 'post',
    payload: JSON.stringify({ books: books })
  });

  if (!respuesta || respuesta.success !== true) {
    throw new Error('Booky API no pudo validar los libros.');
  }

  return respuesta;
}

/******************************************************
 * REGISTRO DE UNA SOLICITUD
 ******************************************************/

function registrarSolicitud(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new Error('No se recibieron los datos de la solicitud.');
  }

  const correo = obtenerCorreoUsuario_();

  if (!correo) {
    throw new Error(
      'No fue posible identificar tu correo institucional. ' +
      'Verifica que hayas iniciado sesión.'
    );
  }

  const campos = [
    'solicitante',
    'extension',
    'programa',
    'materia',
    'cardnumber',
    'borrowernumber'
  ];

  campos.forEach(campo => {
    if (!String(datos[campo] || '').trim()) {
      throw new Error('Falta completar el campo: ' + campo);
    }
  });

  if (!Array.isArray(datos.libros) || datos.libros.length === 0) {
    throw new Error('Debes agregar al menos un libro.');
  }

  // Verificación real contra Koha para evitar identidades manipuladas en el navegador.
  const usuarioKoha = verificarSolicitanteKoha_(
    datos.cardnumber,
    datos.borrowernumber
  );

  const nombreKoha = String(usuarioKoha.full_name || '').trim();
  if (!nombreKoha || nombreKoha !== String(datos.solicitante || '').trim()) {
    throw new Error(
      'El nombre del solicitante no coincide con Koha. Vuelve a buscar al profesor.'
    );
  }

  const libros = datos.libros.map((libro, indice) => {
    if (!String(libro.titulo || '').trim()) {
      throw new Error(
        'El libro número ' + (indice + 1) + ' necesita un título.'
      );
    }

    const cantidades = CONFIG.CAMPUS.map(campus => {
      const cantidad = Number(
        libro.cantidades && libro.cantidades[campus] || 0
      );

      if (!Number.isInteger(cantidad) || cantidad < 0) {
        throw new Error(
          'La cantidad indicada para ' + campus + ' no es válida.'
        );
      }

      return cantidad;
    });

    const total = cantidades.reduce((suma, cantidad) => suma + cantidad, 0);

    if (total <= 0) {
      throw new Error(
        'Indica al menos una cantidad para el libro: ' + libro.titulo
      );
    }

    return {
      titulo: String(libro.titulo).trim(),
      autor: String(libro.autor || '').trim(),
      editorial: String(libro.editorial || '').trim(),
      edicion: String(libro.edicion || '').trim(),
      anio: String(libro.anio || '').trim(),
      isbn: String(libro.isbn || '').trim(),
      cantidades: cantidades,
      total: total
    };
  });

  const bloqueo = LockService.getScriptLock();
  bloqueo.waitLock(30000);

  try {
    const libro = obtenerLibro_();
    const hojaSolicitudes = libro.getSheetByName(CONFIG.SHEET_SOLICITUDES);
    const hojaDetalles = libro.getSheetByName(CONFIG.SHEET_DETALLES);

    if (!hojaSolicitudes || !hojaDetalles) {
      throw new Error(
        'Primero debe prepararse la base de datos del sistema.'
      );
    }

    asegurarEncabezadosSolicitudes_(hojaSolicitudes);

    const folio = generarFolio_(hojaSolicitudes);
    const fecha = new Date();
    const zonaHoraria = Session.getScriptTimeZone();
    const hora = Utilities.formatDate(fecha, zonaHoraria, 'HH:mm:ss');

    const filaSolicitud = [[
      folio,
      fecha,
      hora,
      correo,
      String(datos.solicitante).trim(),
      String(datos.extension).trim(),
      String(datos.programa).trim(),
      String(datos.materia).trim(),
      String(datos.justificacion || '').trim(),
      'Recibida',
      String(datos.cardnumber).trim(),
      String(datos.borrowernumber).trim()
    ]];

    hojaSolicitudes.getRange(
      hojaSolicitudes.getLastRow() + 1,
      1,
      1,
      HEADERS_SOLICITUDES.length
    ).setValues(filaSolicitud);

    const filasDetalles = libros.map((item, indice) => [
      folio,
      indice + 1,
      item.titulo,
      item.autor,
      item.editorial,
      item.edicion,
      item.anio,
      item.isbn,
      ...item.cantidades,
      item.total
    ]);

    hojaDetalles.getRange(
      hojaDetalles.getLastRow() + 1,
      1,
      filasDetalles.length,
      HEADERS_DETALLES.length
    ).setValues(filasDetalles);

    return {
      correcto: true,
      folio: folio,
      mensaje: 'La solicitud se registró correctamente.'
    };

  } finally {
    bloqueo.releaseLock();
  }
}


/******************************************************
 * CONSULTA ADMINISTRATIVA
 ******************************************************/

function obtenerSolicitudesAdmin() {
  validarAdministrador_();

  const libro = obtenerLibro_();
  const hojaSolicitudes = libro.getSheetByName(CONFIG.SHEET_SOLICITUDES);
  const hojaDetalles = libro.getSheetByName(CONFIG.SHEET_DETALLES);

  if (!hojaSolicitudes || !hojaDetalles) {
    throw new Error('No se encontró la base de datos.');
  }

  asegurarEncabezadosSolicitudes_(hojaSolicitudes);

  const solicitudes = hojaSolicitudes.getLastRow() > 1
    ? hojaSolicitudes.getRange(
        2, 1,
        hojaSolicitudes.getLastRow() - 1,
        HEADERS_SOLICITUDES.length
      ).getValues()
    : [];

  const detalles = hojaDetalles.getLastRow() > 1
    ? hojaDetalles.getRange(
        2, 1,
        hojaDetalles.getLastRow() - 1,
        HEADERS_DETALLES.length
      ).getValues()
    : [];

  const mapaDetalles = {};

  detalles.forEach(fila => {
    const folio = String(fila[0]);

    if (!mapaDetalles[folio]) {
      mapaDetalles[folio] = [];
    }

    mapaDetalles[folio].push({
      numero: fila[1],
      titulo: fila[2],
      autor: fila[3],
      editorial: fila[4],
      edicion: fila[5],
      anio: fila[6],
      isbn: fila[7],
      cantidades: {
        Centro: fila[8],
        'Náinari': fila[9],
        Guaymas: fila[10],
        Navojoa: fila[11],
        Empalme: fila[12]
      },
      total: fila[13]
    });
  });


return solicitudes.map(fila => ({
  folio: fila[0],

  fecha: fila[1] instanceof Date
    ? Utilities.formatDate(
        fila[1],
        Session.getScriptTimeZone(),
        'dd/MM/yyyy'
      )
    : String(fila[1] || ''),

  hora: fila[2] instanceof Date
    ? Utilities.formatDate(
        fila[2],
        Session.getScriptTimeZone(),
        'HH:mm'
      )
    : String(fila[2] || ''),

  correo: fila[3],
  solicitante: fila[4],
  extension: fila[5],
  programa: fila[6],
  materia: fila[7],
  justificacion: fila[8],
  estado: fila[9],
  cardnumber: fila[10] || '',
  borrowernumber: fila[11] || '',
  libros: mapaDetalles[String(fila[0])] || []
})).reverse();

}


/******************************************************
 * ACTUALIZACIÓN DE ESTADO
 ******************************************************/

function actualizarEstadoSolicitud(folio, nuevoEstado) {
  validarAdministrador_();

  const estadosPermitidos = [
    'Recibida',
    'En revisión',
    'Autorizada',
    'En proceso',
    'Atendida',
    'No autorizada'
  ];

  if (!estadosPermitidos.includes(nuevoEstado)) {
    throw new Error('El estado indicado no es válido.');
  }

  const bloqueo = LockService.getScriptLock();
  bloqueo.waitLock(30000);

  try {
    const hoja = obtenerLibro_().getSheetByName(
      CONFIG.SHEET_SOLICITUDES
    );

    if (!hoja || hoja.getLastRow() < 2) {
      throw new Error('No hay solicitudes registradas.');
    }

    const folios = hoja.getRange(
      2, 1, hoja.getLastRow() - 1, 1
    ).getDisplayValues().flat();

    const indice = folios.indexOf(String(folio));

    if (indice === -1) {
      throw new Error('No se encontró el folio indicado.');
    }

    hoja.getRange(indice + 2, 10).setValue(nuevoEstado);

    return {
      correcto: true,
      mensaje: 'El estado se actualizó correctamente.'
    };

  } finally {
    bloqueo.releaseLock();
  }
}
function diagnosticoDatos() {
  const libro = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  const solicitudes = libro.getSheetByName('Solicitudes');
  const detalles = libro.getSheetByName('DetalleLibros');

  Logger.log('Archivo: ' + libro.getName());
  Logger.log('ID utilizado: ' + CONFIG.SPREADSHEET_ID);

  Logger.log(
    'Filas en Solicitudes: ' +
    (solicitudes ? solicitudes.getLastRow() : 'PESTAÑA NO ENCONTRADA')
  );

  Logger.log(
    'Filas en DetalleLibros: ' +
    (detalles ? detalles.getLastRow() : 'PESTAÑA NO ENCONTRADA')
  );

  if (solicitudes && solicitudes.getLastRow() >= 2) {
    Logger.log(
      'Primer folio registrado: ' +
      solicitudes.getRange(2, 1).getDisplayValue()
    );
  }
}