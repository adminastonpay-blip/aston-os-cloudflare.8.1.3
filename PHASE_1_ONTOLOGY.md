# Phase 1 — Ontology / Foundry core (Palantir gap)

**Branch:** `phase-1-ontology`  
**Version target:** 11.4.0  
**Goal:** Operational object graph on the edge — entities, links, path, Foundry object view + actions.

## What landed

1. **Router wiring** — `/v1/ontology/*`, `/v1/foundry/*`, `/v1/search` are live again via `routes.js` (were orphaned).
2. **Shared auth** — `auth.js` (`Authorization: Bearer` + optional `X-Tenant` / `X-Aston-Actor`).
3. **Ontology API**
   - Types, list/upsert entities, relations
   - `GET /v1/ontology/entities/:id` with in/out relations
   - Graph neighborhood (depth ≤ 3)
   - Shortest path `GET /v1/ontology/path?from=&to=`
   - Extract (heuristic + optional Workers AI)
4. **Foundry** — existing object types, actions, approvals, search remain available through the same auth gate.
5. **Capabilities** — `GET /v1/capabilities` lists Phase 1 surface.

## Smoke (after deploy)

```bash
export BASE=https://aston-os-cloudflare-8-1-3.<account>.workers.dev
export TOKEN=<ASTON_API_TOKEN>

curl -s "$BASE/v1/capabilities" | jq .

curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"type":"organization","name":"Acme Corp","props":{"country":"AR"}}' \
  "$BASE/v1/ontology/entities"

curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  "$BASE/v1/ontology/entities?q=Acme"

curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  "$BASE/v1/foundry/types"
```

## Still not Palantir (honest)

- No full typed property validation / ontology versioning UI
- Pathfinding is BFS on D1 (fine for small graphs; not billion-edge)
- Object-level ACL and data markings → Phase 3 security
- Workshop low-code → later phase

## Next inside Phase 1 (optional follow-ups)

- [ ] Wire cases/orchestrator the same way
- [ ] Entity delete + soft-delete
- [ ] Vectorize hybrid search when index bound
- [ ] Merge `worker.mjs` / `index.js` version constants to 11.4.0
