# ASTON OS Omni-Core 8.1.6 — Cloudflare Worker

## Corrección del punto de entrada

Esta versión elimina la carpeta duplicada `src/` para evitar ambigüedades. El punto de entrada es `index.js` en la raíz y `wrangler.toml` declara `main = "index.js"`.

La estructura del repositorio debe quedar exactamente así (con los archivos directamente en la raíz del ZIP):

```text
wrangler.toml
index.js
package.json
schema.sql
test/run.mjs
.gitignore
```

## Pasos para GitHub y Cloudflare

1. Descargá y extraé este ZIP.
2. En el repositorio destinado al Worker, reemplazá los archivos del proyecto por el contenido del ZIP. No subas la carpeta contenedora ni mezcles versiones anteriores.
3. En Cloudflare Workers Builds, configurá `Root directory` como vacío si los archivos están en la raíz del repositorio.
4. Build command: `npm install` (o `bun install`).
5. Deploy command: `npx wrangler deploy`.
6. Confirmá en el log que Wrangler carga `main = "index.js"`, no `src/index.js`.

## Validación local

```bash
node --check index.js
npm test
npm run check
```

`npm run check` hace un dry-run y no publica el Worker. `npm run deploy` publica el Worker.

## Recursos y secretos

El `wrangler.toml` conserva los IDs de recursos configurados en la versión de trabajo. Confirmá que esos IDs y nombres coincidan con tu cuenta Cloudflare antes de desplegar. Los secretos `ASTON_API_TOKEN` y `ASTON_JWT_SECRET` deben configurarse como secrets de Cloudflare, nunca dentro del repositorio. No pegues tokens en el chat.

El código utiliza los bindings `ASTON_DB`, `ASTON_DB_BACKUP`, `ASTON_KV`, `ASTON_R2`, `AI` y Durable Objects definidos en `wrangler.toml`. Verificá que los recursos existan en la cuenta seleccionada.

Esta entrega corrige el empaquetado; no demuestra por sí sola que el despliegue remoto haya finalizado ni que todas las integraciones estén habilitadas. No modifica ni publica temas de Shopify.
