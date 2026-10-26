# Deploy ASTON OS 11.3.1 (ahora)

## Hallazgo

`npx wrangler deploy --dry-run` **funciona** con este repo (formato ES Module + Durable Objects OK).

El fallo repetido en **Cloudflare Builds** (`service-worker`) no reproduce en local: es el entorno CI de Cloudflare, no el código.

## Camino recomendado: deploy desde tu PC

```bash
git clone https://github.com/adminastonpay-blip/aston-os-cloudflare.8.1.3.git
cd aston-os-cloudflare.8.1.3
git pull origin main
npm install
npx wrangler login
npm run deploy
```

Verificar:

```bash
curl -s https://aston-os-cloudflare-8-1-3.<subdomain>.workers.dev/health
```

Esperado: `"version":"11.3.1"` y `"format":"es-module"`.

## Si querés seguir con Cloudflare Builds

En el dashboard del Worker → **Settings → Builds**:

1. **Deploy command** cambiar a:

```bash
npm run deploy
```

(no solo `npx wrangler deploy`)

2. **Root directory**: vacío

3. Branch: `main`

## Alternativa: pausar builds automáticos

Desactivá “Automatic deployments” en Cloudflare y desplegá solo con `npm run deploy` en la PC o GitHub Actions con `CLOUDFLARE_API_TOKEN`.
