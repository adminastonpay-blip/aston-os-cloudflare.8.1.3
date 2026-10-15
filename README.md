# ASTON OS Omni-Core 8.2.0 — Cloudflare Worker

## Qué hay de nuevo en 8.2.0

- **Hardening (Etapa 1)**: detección automática de capacidades, degradación elegante si falta un binding, CORS más flexible, respuestas siempre estructuradas.
- **Generación de imágenes** (`POST /v1/ai/image`): usa Workers AI, guarda en R2 cuando está disponible y registra metadatos en D1.
- Tabla `media` para historial de imágenes generadas.
- Endpoint `GET /v1/media` para listar imágenes del tenant.
- Health check ahora expone `capabilities` reales.

## Estructura del repositorio

Los archivos deben estar en la **raíz** del repositorio:

```text
wrangler.toml
index.js
package.json
schema.sql
run.mjs
.gitignore
README.md
```

## Despliegue en Cloudflare

1. Root directory: vacío (archivos en la raíz).
2. Build command: `npm install`
3. Deploy command: `npx wrangler deploy`
4. Confirmá en el log que Wrangler carga `main = "index.js"`.

## Secretos necesarios

Configurá en Cloudflare (nunca en el repo):

- `ASTON_API_TOKEN`
- `ASTON_JWT_SECRET` (opcional)

## Variables opcionales

| Variable | Descripción |
|----------|-------------|
| `AI_MODEL` | Modelo de chat (default `@cf/meta/llama-3.1-8b-instruct`) |
| `AI_IMAGE_MODEL` | Modelo de imagen (default `@cf/black-forest-labs/flux-1-schnell`) |
| `PUBLIC_CHAT` | `"true"` para permitir chat sin auth |
| `ALLOWED_ORIGIN` | Origen CORS permitido |
| `RATE_LIMIT_PER_MINUTE` | Límite por minuto (default 120) |

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` o `/health` | Health + capabilities |
| POST | `/v1/ai/chat` | Chat con Workers AI |
| POST | `/v1/ai/image` | **Generar imagen** |
| GET | `/v1/media` | Listar imágenes generadas |
| GET/POST | `/v1/records/:sector` | Registros por sector |
| POST | `/v1/ingest/:sector` | Ingestión masiva |
| POST | `/v1/search` | Búsqueda keyword |
| POST | `/v1/ledger` | Movimientos financieros |
| GET | `/v1/audit` | Auditoría |
| GET | `/v1/stats` | Estadísticas |
| POST | `/v1/diagnostics/storage` | Diagnóstico de recursos |

### Ejemplo de generación de imagen

```bash
curl -X POST https://TU-WORKER.workers.dev/v1/ai/image \
  -H "Authorization: Bearer TU_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A futuristic city at sunset, cinematic lighting",
    "return_base64": false
  }'
```

Respuesta típica:

```json
{
  "ok": true,
  "id": "uuid",
  "model": "@cf/black-forest-labs/flux-1-schnell",
  "stored_in_r2": true,
  "r2_key": "default/images/uuid.png",
  "size_bytes": 123456
}
```

## Validación local

```bash
node --check index.js
npm test
npm run check
```

`npm run check` hace dry-run y no publica. `npm run deploy` publica el Worker.

## Notas de seguridad

Los secretos `ASTON_API_TOKEN` y `ASTON_JWT_SECRET` deben configurarse como secrets de Cloudflare. Nunca los pegues en el chat ni los subas al repositorio.
