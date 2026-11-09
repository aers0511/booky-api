# Booky API modular — Bibliotecas ITSON

Backend serverless para Vercel. Mantiene Gemini como motor conversacional y agrega una integración modular de consulta de catálogo Koha.

## Arquitectura

```text
api/
  booky.js                   Punto de entrada HTTP de Booky
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
- `KOHA_MAX_ITEMS`: máximo de ejemplares por registro, por defecto 100 (máximo permitido por esta integración).

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


## Presentación agrupada de ejemplares en OPACcredits

Se añadió agrupación visual por campus, ubicación y clasificación/Cutter. Cada grupo muestra la cantidad disponible y el total de ejemplares, evitando repetir una fila por cada copia. El conteo se calcula con los ejemplares que devuelve Koha. El límite predeterminado por registro se elevó a 100 ejemplares (`KOHA_MAX_ITEMS=100`) para reducir el riesgo de conteos incompletos.
