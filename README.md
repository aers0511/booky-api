# Booky API (Vercel + Gemini)

Backend serverless para el frontend de Booky. Recibe `POST { message, history, page }` y responde `{ answer }`.

## Variables de entorno en Vercel

- `GEMINI_API_KEY`: clave de Google AI Studio. Guardarla como Environment Variable; nunca en el frontend ni en Git.
- `GEMINI_MODEL`: opcional; por defecto `gemini-3.8-flash`.
- `ALLOWED_ORIGINS`: opcional; orígenes separados por coma. Por defecto `https://sib.itson.edu.mx,https://biblioteca.itson.mx`.

## Despliegue

Importa este proyecto en Vercel, configura las variables de entorno y despliega. El endpoint será `https://TU-PROYECTO.vercel.app/api/booky`.

En el HTML de Booky, configura `aiEndpoint` con la URL absoluta del endpoint. Nunca incluyas la clave de Gemini en el HTML.

La función usa la API REST `models.generateContent` de Gemini y devuelve errores estructurados si el proveedor falla o tarda demasiado.
