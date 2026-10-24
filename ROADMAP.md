# ASTON OS — Roadmap (capacidad máxima vs Palantir)

## Fase A — Ontology ✅
- Entities / relations / extract / agent tools / DO cache
- Rutas `/v1/ontology/*` vía worker entry

## Fase B — Orchestrator ✅ (esta rama)
- [x] DO `AstonOrchestrator`
- [x] Roles: analyst, compliance, supplier, growth + synthesizer
- [x] Plan multi-paso + persistencia `orchestrator_runs`
- [x] Artefactos R2 opcionales
- [x] Rutas `/v1/orchestrator/*`

## Fase C — Cases / playbooks
- Tabla `cases` + estados
- Playbooks (audit tienda, riesgo proveedor, anomalía ledger)
- Webhooks de cambio de grafo / caso

## Fase D — Gobernanza enterprise
- Scopes por plugin
- RLS estricto
- Lineage de entidades
- Export audit → R2

## Fase E — Voice unificado
- Voice session + agent + ontology + orchestrator tools

## Fase F — Data fusion
- Conectores Shopify / CSV / webhooks → ontology + Vectorize

---
```bash
npm run db:init && npx wrangler deploy
```
