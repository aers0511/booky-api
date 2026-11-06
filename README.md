# Booky API (Vercel + Gemini)

Endpoint serverless compatible con el frontend actual de Booky. Recibe `{ message, history, page }` y responde `{ answer }`.

## Variables de entorno en Vercel

- `GEMINI_API_KEY`: clave de Google AI Studio. Guardarla como Environment Variable, nunca en el frontend ni en Git.
- `GEMINI_MODEL`: opcional. Valor inicial `gemini-3.8-flash`.
- `ALLOWED_ORIGINS`: opcional. Orígenes permitidos separados por coma. Por defecto `https://sib.itson.edu.mx,https://biblioteca.itson.mx`.

## Despliegue

Importar este proyecto en Vercel y agregar las variables de entorno antes de desplegar. La ruta quedará como `https://TU-PROYECTO.vercel.app/api/booky`.

En el frontend actual de Booky, cambiar `CONFIG.aiEndpoint` por la URL absoluta del endpoint de Vercel. No incluir la clave de Gemini en el HTML.

## Prueba

Enviar un POST JSON a `/api/booky` con `Content-Type: application/json` y cuerpo:

```json
{"message":"Hola, Booky","history":[],"page":"/"}
```

Respuesta esperada: `{"answer":"..."}`.
