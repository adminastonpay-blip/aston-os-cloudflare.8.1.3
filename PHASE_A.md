# Phase A — Ontology (ACTIVE)

## Status
Mounted via `worker.js` entry wrapper → `/v1/ontology/*` without requiring a full `index.js` rewrite.

## Deploy
```bash
npm run db:init
npx wrangler deploy
```

Migration `v4-ontology` registers DO class `AstonOntology`.

## APIs

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/ontology/types` | read |
| GET | `/v1/ontology/entities?type=&q=&limit=` | read |
| POST | `/v1/ontology/entities` | write |
| POST | `/v1/ontology/relations` | write |
| GET | `/v1/ontology/query?entity_id=&depth=` | read |
| POST | `/v1/ontology/extract` | write |

## Smoke
```bash
export TOKEN=...
export HOST=https://aston-os-cloudflare-8-1-3.<account>.workers.dev

curl -s -H "Authorization: Bearer $TOKEN" "$HOST/v1/ontology/types" | jq .

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$HOST/v1/ontology/entities" \
  -d '{"type":"organization","name":"ASTON Commerce","props":{"sector":"commerce"}}' | jq .

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$HOST/v1/ontology/extract" \
  -d '{"text":"Order ORD-9981 from Acme Corp Inc account ACC-44","persist":true}' | jq .
```

## Agent tools
`ontology_search` · `ontology_traverse` · `ontology_upsert`

## Next
Phase B — multi-agent orchestrator (`AstonOrchestrator`)
