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
