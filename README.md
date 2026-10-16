# ASTON OS Omni-Core 8.6.0

## New in 8.6.0

### A) Billing (usage + charge)
- Auto-tracks `ai.chat`, `ai.image`, `agent.run` in the `usage` table
- `GET /v1/billing/usage` — usage + estimated charge
- `POST /v1/billing/charge` — posts charge to ledger (admin)
- Prices (minor units): `PRICE_AI_CHAT_MINOR` (default 1), `PRICE_AI_IMAGE_MINOR` (10), `PRICE_AGENT_RUN_MINOR` (5), `BILLING_CURRENCY` (USD)

### B) Commerce vertical (pilot)
- `POST /v1/commerce/order` — create order (+ optional sales ledger credit)
- `GET /v1/commerce/orders` — list orders
- `POST /v1/commerce/support` — commerce support agent
- `GET /v1/commerce/summary` — orders count + sales by currency
- `POST /v1/commerce/webhook` — ingest commerce events

## Auth
All billing/commerce routes need `Authorization: Bearer <ASTON_API_TOKEN>`.


## Public Agent Gateway (ASTON Intelligence / Shopify)

- `GET /v1/agent/capabilities` reports the public gateway's available advisory capabilities.
- `POST /v1/agent/public` accepts `{"prompt":"...","history":[{"role":"user","content":"..."}],"context":{"page_title":"...","template":"page"}}`.
- The public route is advisory only: it does not call private tenant tools, access private records or ledger data, or execute external actions.
- Requires the Workers AI binding `AI` and Durable Object binding `ASTON_RATE_LIMITER`.
- Enabled by `PUBLIC_AGENT=true`; default per-IP limit is 8 requests per minute, configurable with `PUBLIC_AGENT_RATE_LIMIT_PER_MINUTE`.
- Never place `ASTON_API_TOKEN` or `ASTON_JWT_SECRET` in Shopify Liquid or browser JavaScript. The authenticated `/v1/agent/run` route remains server-side/authenticated.
- The branch must be deployed and tested in Cloudflare before the Shopify preview can use the new endpoint.
