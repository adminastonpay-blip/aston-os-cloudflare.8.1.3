# Phase 5 — Decision Twin (+5%) · Roadmap Complete

**Version:** 10.10.0  
**Routes:** `/v1/twin/*`

## Capabilities
- Snapshot live ontology (entities + edges)
- Branch scenarios with pure mutations (never touch live DB)
- What-if ops: `set_prop`, `scale_prop`, `add_entity`, `remove_entity`, `add_edge`, `set_status`
- Score scenarios (risk / revenue / delay / capacity / critical)
- Compare multiple scenarios → winner ranking
- HMAC-signed decision receipts (immutable audit)
- Decide / reject without mutating production ontology

## API
- `GET /v1/twin/status`
- `POST /v1/twin/snapshot`
- `GET|POST /v1/twin/scenarios`
- `GET /v1/twin/scenarios/:id`
- `POST /v1/twin/scenarios/:id/simulate`
- `POST /v1/twin/scenarios/:id/decide`
- `POST /v1/twin/compare`
- `GET /v1/twin/receipts/:id`

## Flow
1. Create scenario (optional mutations)
2. Simulate → score + receipt
3. Compare candidates
4. Decide (approve/reject) → second receipt
