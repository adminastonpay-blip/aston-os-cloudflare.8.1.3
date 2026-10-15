# ASTON OS Omni-Core 8.1.3 — Cloudflare Worker

## Corrección de empaquetado
Este ZIP está preparado con los archivos directamente en la raíz del proyecto. Al subirlo a GitHub, la estructura debe quedar así (sin una carpeta extra envolviendo todo):

```text
wrangler.toml
package.json
schema.sql
src/index.js
test/run.mjs
```

El error `The entry-point file at "src/index.js" was not found` ocurre cuando Cloudflare está ejecutando Wrangler desde una raíz que no contiene `src/index.js`, normalmente por una carpeta raíz mal seleccionada o porque el ZIP se subió con una carpeta contenedora adicional.

## GitHub / Cloudflare
1. Descargá y extraé el ZIP.
2. Subí **el contenido** del ZIP al nivel raíz del repositorio (no la carpeta contenedora).
3. En Cloudflare Workers > Settings > Builds, dejá Root directory vacío o configurado en la carpeta donde están `wrangler.toml` y `src/index.js`.
4. Build command: `npm install` (o `bun install`, si el proyecto usa Bun).
5. Deploy command: `npx wrangler deploy`.
6. Verificá que `wrangler.toml` tenga `main = "src/index.js"` y que el archivo exista en esa misma raíz.

## Validación local
```bash
npm install
npm test
npm run check
```
`npm run check` requiere dependencias instaladas y valida el bundle de Wrangler sin publicar el Worker. `npm run deploy` sí publica; ejecutalo solo cuando estés listo.

## Recursos Cloudflare
`wrangler.toml` conserva los bindings y los identificadores configurados en la versión de trabajo. Antes de desplegar, confirmá que los nombres e IDs correspondan a los recursos de tu cuenta. No compartas API tokens ni secretos en el repositorio o el chat.

## Seguridad operativa
- No se incluyen API tokens ni secretos.
- No se modifica Shopify ni se publica ningún tema de Shopify.
- Los recursos externos y el despliegue remoto no se pueden certificar solo con pruebas locales.
