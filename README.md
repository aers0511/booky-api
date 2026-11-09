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
