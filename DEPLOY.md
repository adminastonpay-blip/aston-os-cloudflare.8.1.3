# ASTON OS — Deploy canónico (v10.5.0)

Código en `main` incluye fases **A–L**. El deploy solo puede hacerse con la cuenta Cloudflare del proyecto.

## 1. Pull
```bash
git clone https://github.com/adminastonpay-blip/aston-os-cloudflare.8.1.3.git
cd aston-os-cloudflare.8.1.3
git checkout main && git pull origin main
npm install
```

## 2. Secretos
```bash
npx wrangler login
npx wrangler secret put ASTON_API_TOKEN
npx wrangler secret put ASTON_RECEIPT_SECRET
# opcional:
# npx wrangler secret put ASTON_JWT_SECRET
```

## 3. Base de datos
```bash
npm run db:init
```
(Ajustá nombres D1 en `package.json` / `wrangler.toml` si difieren en tu cuenta.)

## 4. Deploy
```bash
npx wrangler deploy
```

## 5. Verificar
```bash
# UI
open https://<worker-host>/ui

# PoV demo (reemplazar TOKEN y HOST)
curl -sS -X POST "https://<worker-host>/v1/pov/demo" \
  -H "Authorization: Bearer $ASTON_API_TOKEN" \
  -H "X-Tenant: default" \
  -H "Content-Type: application/json" \
  -d '{"run_orchestrator":true}'

curl -sS "https://<worker-host>/v1/metrics/bench" \
  -X POST -H "Authorization: Bearer $ASTON_API_TOKEN" -H "X-Tenant: default" -d '{}'
```

## Qué NO hace este repo solo
- No despliega a Cloudflare sin `wrangler` + login de la cuenta.
- No registra C-Corp ni patentes (legal externo).
- Bench edge_core ≠ latencia e2e del LLM/orchestrator.
