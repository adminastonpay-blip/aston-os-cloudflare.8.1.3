# Phase Commerce — Multi-revenue until large contracts

**Version:** 11.1.0  
**Routes:** `/v1/billing/*`

## Rate card

| Plan | Setup | Monthly | Path |
|------|-------|---------|------|
| Pilot | $3,500 | — (30d) | Entry |
| Core | — | $1,500 | SaaS |
| Ops | — | $3,000 | + Swarm + Twin |
| Trust | — | $5,000 | + Auto-Gov + Audit |
| Enterprise | — | from $50k/yr | Large contracts |

Add-ons: Swarm $800 · Twin $700 · Gov $1,200 · Fraud $1,500 · Setup $8,000

## API
- `GET /v1/billing/rate-card` (public)
- `POST /v1/billing/subscribe` `{ "plan_id": "core" }`
- `POST /v1/billing/add-on` `{ "add_on_id": "addon_swarm" }`
- `GET /v1/billing/me`
- `POST /v1/billing/check-feature`
- `GET /v1/billing/events`

## Strategy
Pilot + Core MRR finance Ops/Trust upsell → Enterprise annual when ROI receipts exist.
