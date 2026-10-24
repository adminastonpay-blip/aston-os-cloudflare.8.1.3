# Phase H — Truth Receipts

Immutable HMAC-SHA256 signed receipts for autonomous AI decisions (Blue Ocean IP pillar).

## Behavior
- Every completed **orchestrator run** issues a Truth Receipt automatically.
- Chain: each receipt may reference `prev_receipt_id` (tenant chain).
- Verify any receipt with the same secret.

## Secret
Prefer dedicated: `wrangler secret put ASTON_RECEIPT_SECRET`  
Fallback: `ASTON_JWT_SECRET` or `ASTON_API_TOKEN`.

## APIs
| Method | Path |
|--------|------|
| GET | `/v1/receipts/status` |
| GET | `/v1/receipts/list` |
| GET | `/v1/receipts/:id` |
| POST | `/v1/receipts` |
| POST | `/v1/receipts/verify` |

Orchestrator response includes `truth_receipt: { id, signature, alg, ... }`.

## Deploy
```bash
git checkout phase-h-truth-receipts
npm run db:init
npx wrangler secret put ASTON_RECEIPT_SECRET
npx wrangler deploy
```
