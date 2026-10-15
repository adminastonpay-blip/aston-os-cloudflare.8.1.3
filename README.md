# ASTON OS Omni-Core 8.3.0 — Cloudflare Worker (Plugin System)

## Qué hay de nuevo en 8.3.0

- **Sistema de plugins**: cada capacidad se describe como un plugin con bindings requeridos.
- Los plugins se **activan automáticamente** cuando existen los recursos en Cloudflare.
- `GET /v1/plugins` lista todos los plugins y su estado (activo/inactivo).
- Health check muestra resumen de plugins.
- Si falta un binding (ej. AI), responde `plugin_inactive` (503) en lugar de un error confuso.
- Tabla `plugins_state` preparada para configuración futura.

## Plugins incluidos

| ID | Nombre | Requiere | Estado |
|----|--------|----------|--------|
| `core` | ASTON Core | — | Siempre activo |
| `session` | Session (DO) | `ASTON_SESSION` | Auto |
| `ai-chat` | Workers AI Chat | `AI` | Auto |
| `ai-image` | Image Generation | `AI` | Auto |
| `media` | Media Library | `ASTON_DB` | Auto |

## Integración automática

Cuando agregás un binding en Cloudflare (AI, R2, D1, Durable Objects), el plugin correspondiente pasa a `active: true` solo. No hace falta redeploy de lógica extra.

## Endpoints

| Método | Ruta | Plugin |
|--------|------|--------|
| GET | `/` `/health` | core |
| GET | `/v1/plugins` | core |
| POST | `/v1/ai/chat` | ai-chat |
| POST | `/v1/ai/image` | ai-image |
| GET | `/v1/media` | media |
| GET/POST | `/v1/records/:sector` | core |
| POST | `/v1/ingest/:sector` | core |
| POST | `/v1/search` | core |
| POST | `/v1/ledger` | core |
| GET | `/v1/audit` | core |
| GET | `/v1/stats` | core |
| POST | `/v1/diagnostics/storage` | core |
| GET/POST/DELETE | `/v1/session` | session |

## Despliegue

1. Root directory vacío
2. `npm install`
3. `npx wrangler deploy`

## Secretos

- `ASTON_API_TOKEN`
- `ASTON_JWT_SECRET` (opcional)

## Validación

```bash
node --check index.js
npm test
npm run check
```
