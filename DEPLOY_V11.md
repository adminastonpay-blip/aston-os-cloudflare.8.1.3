# Desplegar ASTON OS 11 (sin tocar el v9 en producción)

**Criterio:** el Worker viejo (v9, media/voz/academia) se deja como está.
El código `main` despliega un Worker **nuevo**: `aston-os-v11`.

## Una sola vez en tu PC

```bash
git clone https://github.com/adminastonpay-blip/aston-os-cloudflare.8.1.3.git
cd aston-os-cloudflare.8.1.3
git pull origin main
npm install
npx wrangler login
```

## Secretos (obligatorios para v11)

```bash
npx wrangler secret put SOVEREIGN_MASTER_KEY --name aston-os-v11
npx wrangler secret put ASTON_API_TOKEN --name aston-os-v11
npx wrangler secret put ASTON_RECEIPT_SECRET --name aston-os-v11
```

(Si wrangler ya usa el nombre del toml, podés omitir `--name`.)

## Deploy

```bash
npx wrangler deploy
```

URL típica:
`https://aston-os-v11.<tu-subdominio>.workers.dev`

## Verificar

```bash
curl -s https://aston-os-v11.<subdominio>.workers.dev/health
# "version": "11.3.0"

curl -s https://aston-os-v11.<subdominio>.workers.dev/v1/native/capabilities
curl -s https://aston-os-v11.<subdominio>.workers.dev/v1/billing/rate-card
```

## Qué queda

| Worker | Versión | Uso |
|--------|---------|-----|
| el de siempre (nombre viejo) | 9.0.0 | voz, media, academia |
| **aston-os-v11** | 11.3.0 | swarm, twin, gov, PoE, billing, sovereign |

Cuando quieras unificar, se hace un merge de entrypoints; hasta entonces conviven.
