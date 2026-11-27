# Booky API modular — Bibliotecas ITSON

Backend serverless para Vercel. Mantiene Gemini como motor conversacional y agrega una integración modular de consulta de catálogo Koha.

## Arquitectura

```text
api/
  booky.js                   Punto de entrada HTTP conversacional de Booky
  adquisiciones.js           Endpoint independiente para validar solicitudes de compra
src/
  config.js                  Variables de entorno
  http.js                    CORS y respuestas HTTP
  conversation.js            Historial conversacional
  ai/
    gemini.js                Cliente de Gemini
    scope.js                 Clasificador del ámbito bibliotecario
    system-instruction.js    Identidad y reglas institucionales de Booky
  features/
    registry.js              Registro de funciones ampliables
    catalog/
      index.js               Función de búsqueda en catálogo
      intent.js              Detección de intención de búsqueda
      prompt.js              Contexto de resultados y reglas anti-alucinación
  integrations/
    koha/
      client.js              Cliente REST Koha (solo GET)
```

## Qué hace la búsqueda de catálogo

Cuando un usuario pide encontrar libros, títulos, materiales, tesis o artículos, Booky:

1. Comprueba que la consulta esté dentro del ámbito de Bibliotecas ITSON.
2. Detecta que se trata de una búsqueda en el catálogo.
3. Consulta `GET /api/v1/biblios` en Koha.
4. Consulta `GET /api/v1/biblios/{biblio_id}/items` para recuperar ejemplares.
5. Si no se especifica campus, pregunta cuál consultar y conserva la búsqueda pendiente en el historial de conversación.
6. Filtra los ejemplares por sucursal cuando el usuario elige un campus.
7. Entrega a Gemini los resultados reales para redactar una respuesta clara.

Si no hay resultados, no inventa títulos. Si Koha no está configurado o no responde, Booky informa que no pudo consultar el catálogo y muestra el enlace público.

La integración usa exclusivamente `GET`. No incluye operaciones de alta, edición, eliminación, préstamos, renovaciones ni reservas.

## Variables de entorno en Vercel

Configura estas variables en Project → Settings → Environment Variables:

### Gemini

- `GEMINI_API_KEY`: clave de Google AI Studio.
- `GEMINI_MODEL`: opcional; por defecto `gemini-3.8-flash`.

### Koha

- `KOHA_ENABLED`: cambia a `true` cuando hayas probado las credenciales.
- `KOHA_ASK_CAMPUS`: `true` para preguntar el campus cuando no se indique; `false` para consultar todos los campus por defecto.
- `KOHA_BASE_URL`: `https://sib.itson.edu.mx`.
- `KOHA_MARC_BASE_URL`: opcional. Por defecto usa `KOHA_BASE_URL` (`https://sib.itson.edu.mx`). Solo cámbialo si el MARCXML debe pedirse a otro dominio.
- `KOHA_MARC_CONCURRENCY`: opcional, consultas MARCXML simultáneas (por defecto 4, máximo 8).
- `KOHA_MARC_CACHE_TTL_MS`: opcional, vigencia de la caché en memoria (por defecto 21600000 = 6 h).
- `KOHA_MARC_BUDGET_MS`: opcional, tiempo máximo para completar datos MARC por búsqueda (por defecto 8000 ms).
- `KOHA_API_PATH`: `/api/v1`.
- `KOHA_API_USERNAME`: usuario técnico de Koha.
- `KOHA_API_PASSWORD`: contraseña de ese usuario.
- `KOHA_TIMEOUT_MS`: tiempo máximo por consulta, por defecto 5000 ms.
- `KOHA_MAX_RESULTS`: máximo de registros, por defecto 5.
- `KOHA_MAX_ITEMS`: máximo de ejemplares por registro, por defecto 40.

No pongas las credenciales en el HTML, Git, README ni mensajes enviados al navegador. Guárdalas únicamente como variables de entorno en Vercel.

### Permisos recomendados para la cuenta técnica

La cuenta debe tener `catalogue: 1` para consultar registros bibliográficos y ejemplares. No debe tener `editcatalogue`, permisos de circulación, usuarios, adquisiciones ni administración.

La API REST de Koha documenta `GET /api/v1/biblios` y `GET /api/v1/biblios/{biblio_id}/items` como operaciones que requieren permiso de catálogo. Consulta la documentación de la versión instalada antes de habilitar la cuenta.

## Despliegue

1. Sube el contenido de este proyecto a tu repositorio de GitHub.
2. Importa el repositorio en Vercel.
3. Configura las variables de Gemini y los orígenes permitidos.
4. Despliega con `KOHA_ENABLED=false`.
5. Agrega las credenciales de la cuenta técnica de Koha en Vercel.
6. Cambia `KOHA_ENABLED=true` y vuelve a desplegar.

El endpoint principal se mantiene igual:

`https://TU-PROYECTO.vercel.app/api/booky`

El frontend incluido en el paquete ya interpreta las respuestas estructuradas (`ui`) de catálogo. Reemplaza el fragmento OPACcredits por el archivo `booky-opaccredits-bibliotecas-itson.html` incluido en el paquete. Conserva la misma URL del endpoint. El frontend sigue enviando:

```json
{
  "message": "¿Tienen libros sobre administración de inventarios?",
  "history": [],
  "page": "/"
}
```

## Prueba de búsqueda

Prueba desde el chat de Booky con consultas como:

- `Busca libros sobre administración de inventarios`
- `¿Tienen libros de cálculo?`
- `Encuentra materiales del autor ...`
- `Busca este ISBN: ...`

Si Booky pregunta el campus, selecciona una de las tarjetas de campus o escribe el nombre. La opción “Todos los campus” consulta todas las sedes. Para omitir esta aclaración y buscar en todas las sedes por defecto, configura `KOHA_ASK_CAMPUS=false`.

Verifica que el título y el enlace correspondan a registros reales en Koha y que la disponibilidad coincida con los ejemplares actuales.

## Agregar funciones en el futuro

Cada módulo nuevo debe vivir en `src/features/<nombre>/` y exponer:

- `detect(context)`: determina si la consulta corresponde a la función.
- `execute(context)`: ejecuta la operación y devuelve un resultado.

Después agrega el módulo al arreglo `FEATURES` en `src/features/registry.js`.

Ejemplos futuros: consulta de recursos digitales, ayuda para APA, información de horarios desde una fuente dinámica o integración de servicios institucionales. Las operaciones que modifiquen datos deben diseñarse como módulos separados, con autenticación y autorización explícitas; no se deben añadir permisos de escritura a la cuenta de búsqueda de catálogo.

## Consideraciones técnicas

- Node.js 20 o superior.
- No requiere dependencias npm adicionales.
- CORS limita los orígenes del navegador, pero CORS por sí solo no es un sistema de autenticación.
- La búsqueda de Koha usa el filtro JSON del parámetro `q` documentado por Koha REST API. Los campos bibliográficos pueden variar por versión/configuración; si la instalación devuelve `invalid_query`, hay que ajustar los campos de búsqueda a la respuesta real de ITSON.
- Las respuestas de catálogo se renderizan con el mismo sistema de tarjetas de Booky tanto si el usuario inicia la búsqueda escribiendo como si la inicia desde el botón “Buscar en catálogo”. El botón de búsqueda ya no utiliza el extractor HTML local de Koha para mostrar resultados.
- La integración no se ha probado contra el servidor de producción de ITSON porque no se proporcionaron credenciales ni se realizó una consulta autenticada.
- Cuando `/api/v1/biblios` deja vacíos editorial o año, Booky consulta `GET /api/v1/public/biblios/{biblio_id}` con `Accept: application/marcxml+xml` y las mismas credenciales Basic (ruta documentada para MARCXML en Koha 25.11). No se hace scraping HTML. Extrae lugar (`$a`), editorial (`$b`, varios permitidos) y año (`$c`) de `264` con segundo indicador 1 (prioridad al primer indicador 3) y usa `260` como alternativa. Las fechas de copyright no se toman como año de publicación y no se inventan datos. Solo se completan campos vacíos, se evitan consultas repetidas (caché y deduplicación) y un fallo en un registro no interrumpe la búsqueda.


## Endpoint independiente de adquisiciones

Se agrega `POST /api/adquisiciones` sin modificar el endpoint conversacional `/api/booky` ni el registro de funciones existentes.

Está diseñado para que Google Apps Script envíe uno o varios libros de una solicitud institucional. Para cada libro:

1. Conserva los datos originales recibidos.
2. Usa Gemini para corregir formato, capitalización, acentos y errores evidentes, sin inventar campos ausentes.
3. Consulta el catálogo Koha por identificador y título, sin filtrar por campus.
4. Devuelve coincidencias bibliográficas y ejemplares/sucursales cuando Koha los proporciona.
5. Distingue `exact_match`, `possible_match`, `not_found` y `pending`.
6. Nunca bloquea la solicitud: las coincidencias generan advertencias para que el docente pueda justificar la compra de más ejemplares.

### Seguridad y configuración

Configura en Vercel:

- `ACQUISITIONS_API_KEY`: clave secreta larga y aleatoria, exclusiva para este endpoint.
- `ACQUISITIONS_MAX_BOOKS`: máximo de libros por petición (15 por defecto).
- `ACQUISITIONS_MAX_RESULTS`: máximo de registros consultados por búsqueda (10 por defecto).
- Las variables existentes `GEMINI_API_KEY`, `KOHA_ENABLED`, `KOHA_API_USERNAME` y `KOHA_API_PASSWORD`.

Google Apps Script debe enviar la clave en el encabezado `x-api-key`. Guarda la clave en **Propiedades del script**; no la incrustes en una página HTML pública. CORS no sustituye esta autenticación.

### Ejemplo de petición

```json
{
  "books": [
    {
      "title": "administracion de inventarios",
      "author": "carlos a garcia",
      "publisher": "mc graw hill",
      "edition": "segunda edicion",
      "year": "2022",
      "identifier": "9786071500000",
      "identifier_type": "ISBN",
      "quantities": {
        "CEN": 2,
        "NAI": 1,
        "GYM": 0,
        "NAV": 0,
        "EMPL": 0
      }
    }
  ]
}
```

### Ejemplo de llamada desde Apps Script

```javascript
function validarLibrosEnBooky_(books) {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('BOOKY_ACQUISITIONS_API_KEY');

  if (!apiKey) throw new Error('Falta BOOKY_ACQUISITIONS_API_KEY en Propiedades del script.');

  const response = UrlFetchApp.fetch(
    'https://booky-api.vercel.app/api/adquisiciones',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey },
      payload: JSON.stringify({ books: books }),
      muteHttpExceptions: true
    }
  );

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());

  if (status < 200 || status >= 300) {
    throw new Error(body.error || 'No fue posible validar los libros en Booky.');
  }

  return body;
}
```

### Respuesta

Cada elemento de `results` incluye `original`, `normalized`, `quantities`, `validation`, `matches` y `warnings`. Los estados posibles son:

- `exact_match`: coincidencia fuerte por identificador o título/autor.
- `possible_match`: coincidencia parcial que requiere revisión.
- `not_found`: no se encontraron coincidencias en las búsquedas realizadas.
- `pending`: Koha no pudo consultarse; no se debe interpretar como ausencia del libro.

`not_found` no garantiza que el material no exista: significa que las consultas ejecutadas no devolvieron coincidencias. Las búsquedas están limitadas por `ACQUISITIONS_MAX_RESULTS` por consulta; ajusta ese límite si el volumen del catálogo lo requiere.

El endpoint solo consulta Koha mediante las operaciones GET ya utilizadas por el cliente existente. No crea registros bibliográficos, ejemplares, solicitudes de compra ni modifica datos en Koha.


### Ajustes de coincidencias y existencias (adquisiciones)

- Una coincidencia por título idéntico ya no se clasifica como exacta si el autor proporcionado no coincide. La coincidencia exacta requiere ISBN/ISSN idéntico o título y autor coincidentes.
- La comparación de autores ignora acentos, orden de apellidos/nombres e iniciales aisladas; compartir únicamente una inicial no basta para considerar autores similares.
- Los ejemplares se agrupan en `holdings` por biblioteca, ubicación, clasificación y estado. El campo `quantity` indica cuántos ejemplares hay en ese grupo y `total_items` indica el total recuperado para el registro.
- `validation.matches_found` representa el total de coincidencias encontradas por la búsqueda; `validation.matches_returned` indica cuántas se incluyen en la respuesta (máximo cinco).
- Se reconoce `EMP` como código alternativo de Empalme, además de `EMPL`.


## API de adquisiciones: uso desde el frontend

El módulo expone dos operaciones. Ambas requieren la misma clave `ACQUISITIONS_API_KEY`, enviada en el encabezado `x-api-key`.

### 1. Buscar usuario por número de tarjeta

`GET /api/adquisiciones/usuarios?cardnumber=NUMERO_TARJETA`

Ejemplo de respuesta cuando existe:

```json
{
  "success": true,
  "endpoint": "adquisiciones.usuarios",
  "query": { "cardnumber": "12345" },
  "found": true,
  "total": 1,
  "results": [
    {
      "borrowernumber": 456,
      "cardnumber": "12345",
      "firstname": "Nombre",
      "surname": "Apellidos",
      "full_name": "Nombre Apellidos",
      "branchcode": "NAI",
      "category_id": "ST"
    }
  ]
}
```

Si no existe, responde `200` con `found: false`, `total: 0` y `results: []`. Los errores de validación, autenticación o Koha se devuelven con su código HTTP y un objeto `error`/`code`.

La consulta utiliza el parámetro `cardnumber` y `_match=exact` de Koha REST API. La cuenta de Koha debe tener `borrowers → list_borrowers`. Para mantener separadas las funciones, configura una cuenta técnica exclusiva para esta búsqueda; no agregues permisos de usuarios a la cuenta de catálogo si no los necesita.

Variables nuevas en Vercel:

- `KOHA_PATRONS_ENABLED=true`
- `KOHA_PATRONS_API_USERNAME`: usuario técnico exclusivo para consulta de usuarios.
- `KOHA_PATRONS_API_PASSWORD`: contraseña de esa cuenta.

La URL base y la ruta REST se comparten con la configuración existente (`KOHA_BASE_URL` y `KOHA_API_PATH`). La búsqueda permanece deshabilitada por defecto.

### 2. Validar libros de una solicitud

`POST /api/adquisiciones`

Envía `books` como arreglo, o `book` para un solo registro. Cada libro admite `title`, `author`, `publisher`, `edition`, `year`, `identifier`, `identifier_type` y `quantities`. La respuesta conserva los datos originales y devuelve `normalized`, `validation`, `matches` y `warnings` para cada libro.

### Ejemplo completo desde Google Apps Script

Si la interfaz está construida con HTML Service de Google Apps Script, el navegador debe llamar a funciones de Apps Script y nunca conocer la clave privada.

**Código del servidor (`Code.gs`):**

```javascript
const BOOKY_API_BASE = 'https://booky-api.vercel.app/api';

function bookyRequest_(path, options) {
  const apiKey = PropertiesService.getScriptProperties()
    .getProperty('BOOKY_ACQUISITIONS_API_KEY');
  if (!apiKey) throw new Error('Falta BOOKY_ACQUISITIONS_API_KEY en Script Properties.');

  const response = UrlFetchApp.fetch(BOOKY_API_BASE + path, {
    ...options,
    contentType: 'application/json',
    headers: { ...(options.headers || {}), 'x-api-key': apiKey },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const data = JSON.parse(response.getContentText() || '{}');
  if (status < 200 || status >= 300) {
    throw new Error(data.error || 'No fue posible completar la operación.');
  }
  return data;
}

// Función invocada por la interfaz para buscar al solicitante.
function buscarSolicitante(cardnumber) {
  const params = `?cardnumber=${encodeURIComponent(String(cardnumber || '').trim())}`;
  return bookyRequest_('/adquisiciones/usuarios' + params, { method: 'get' });
}

// Función invocada por la interfaz para validar los libros.
function validarLibros(books) {
  return bookyRequest_('/adquisiciones', {
    method: 'post',
    payload: JSON.stringify({ books })
  });
}
```

Guarda `BOOKY_ACQUISITIONS_API_KEY` en **Configuración del proyecto → Propiedades del script**.

**Código del cliente (`Index.html`):**

```javascript
function consultarSolicitante() {
  const cardnumber = document.getElementById('cardnumber').value.trim();
  if (!cardnumber) return mostrarError('Captura el número de tarjeta.');

  google.script.run
    .withSuccessHandler(data => {
      if (!data.found) return mostrarError('No se encontró ese usuario.');
      // Si hay varios registros, mostrar opciones para que la persona
      // seleccione y confirme el registro correcto.
      mostrarOpcionesSolicitante(data.results, user => {
        document.getElementById('solicitante').textContent =
          `${user.full_name} · ${user.cardnumber}`;
        document.getElementById('borrowernumber').value = user.borrowernumber;
        document.getElementById('cardnumber_confirmado').value = user.cardnumber;
      });
    })
    .withFailureHandler(error => mostrarError(error.message))
    .buscarSolicitante(cardnumber);
}

function revisarLibros(books) {
  google.script.run
    .withSuccessHandler(data => mostrarResultados(data.results))
    .withFailureHandler(error => mostrarError(error.message))
    .validarLibros(books);
}
```

`mostrarError` y `mostrarResultados` representan las funciones de presentación de tu interfaz. El `borrowernumber` y el `cardnumber` confirmados se conservan en campos ocultos/estado del formulario; cuando se implemente el guardado de la solicitud, se enviarán al backend de persistencia.

Si el frontend no utiliza Google Apps Script, aplica el mismo patrón con tu backend: el navegador llama a tu servidor y este servidor añade `x-api-key` al comunicarse con Booky. Nunca expongas la clave en JavaScript público, HTML, variables `VITE_*` ni repositorios.

### Flujo recomendado de la interfaz

1. La persona captura el `cardnumber` del docente/solicitante.
2. El frontend consulta el endpoint de usuarios.
3. Muestra el nombre y la tarjeta encontrados para confirmar la identidad.
4. Guarda en el estado del formulario `borrowernumber` y `cardnumber`.
5. La persona captura uno o varios libros.
6. El frontend envía los libros al endpoint de adquisiciones.
7. Presenta por libro el estado de validación, coincidencias y advertencias.
8. Cuando el sistema de solicitudes tenga una operación de guardado, envía también el `borrowernumber` seleccionado para asociar la solicitud.

**Alcance actual:** estos endpoints buscan usuarios y validan libros; no crean ni guardan solicitudes de adquisición. El `borrowernumber` se conserva en el frontend para relacionarlo cuando exista un endpoint de registro. No debe confundirse la validación bibliográfica con la autorización o aprobación de una compra.


## Actualización 2.1.0 (19-11-2026)

### Cambios incluidos
- La validación de adquisiciones ya no selecciona ni completa automáticamente la primera coincidencia de Koha. El docente debe elegir explícitamente el registro bibliográfico en cada libro.
- El selector muestra título, autor, edición, año, ISBN y número de registro cuando están disponibles. La elección confirmada actualiza los datos bibliográficos y el resumen de existencias de ese libro.
- Si se modifica la captura después de validar, se limpian las existencias consultadas para evitar mostrar datos desactualizados.
- La búsqueda de biblios pagina hasta `KOHA_MAX_PAGES` páginas, con límites configurables y eliminación de registros duplicados.
- La recuperación de ejemplares usa concurrencia limitada.
- La validación de adquisiciones procesa hasta tres libros en paralelo para reducir el tiempo sin saturar Koha.
- Se amplió a diez el máximo de coincidencias que pueden mostrarse con existencias en el módulo de adquisiciones.
- Se añadió estilo para el selector bibliográfico. Se retiró de la lista administrativa una dirección malformada que contenía una coma; hay que confirmar y volver a agregar el correo correcto del tercer administrador antes de desplegar.
- Se validan cantidades por campus como enteros de 0 a 100 y se descartan propiedades de campus no permitidas.

### Configuración nueva
`KOHA_MAX_PAGES=3` controla cuántas páginas se consultan por búsqueda bibliográfica. El valor permitido por el backend está limitado de 1 a 5. Cada página usa `KOHA_MAX_RESULTS` (limitado de 1 a 50). Esto reduce, pero no elimina, la posibilidad de que existan registros más allá del límite configurado.

### Despliegue
1. Actualiza los archivos de Vercel con el contenido de `src/`, `api/`, `package.json` y `vercel.json`.
2. Conserva las variables secretas existentes en Vercel; no copies claves reales al repositorio. Agrega `KOHA_MAX_PAGES=3` si deseas configurar explícitamente la paginación.
3. En Apps Script, actualiza `Index.html` y `Styles.html`. `Code.gs` también contiene la corrección de formato de la lista administrativa; confirma primero el correo indicado en `ADMIN_EMAILS`.
4. Ejecuta `npm test` y despliega una nueva versión de Apps Script.
5. Prueba con títulos duplicados, ediciones distintas, un ISBN exacto, un título sin autor y un libro sin coincidencias. Verifica además que los totales por campus coincidan con Koha.

### Límites de validación
Las pruebas automatizadas no sustituyen una prueba autenticada con la instancia productiva de Koha ni con las credenciales de Vercel/Apps Script. La paginación depende de que la instalación Koha soporte `_page` y `_per_page` en el endpoint `/biblios`. Las existencias siguen siendo una consulta informativa y pueden cambiar después de la validación.
