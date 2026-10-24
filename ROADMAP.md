# ASTON OS — Roadmap hacia capacidad máxima (vs Palantir)

## Fase A — Ontology (esta rama)
- [x] Tablas `ontology_entities` / `ontology_relations`
- [x] Módulo `ontology.js` + rutas `/v1/ontology/*`
- [x] DO `AstonOntology` (cache caliente por tenant)
- [x] Tools del agent: `ontology_search`, `ontology_traverse`, `ontology_upsert`
- [ ] Auto-extracción al crear records (siguiente commit)
- [ ] Vectorize sobre entidades (cuando el índice exista)

## Fase B — Orchestrator multi-agent
- DO `AstonOrchestrator` + planes multi-paso
- Agents especializados (Analyst, Compliance, Supplier, Growth)
- Memoria compartida + artefactos R2

## Fase C — Cases / playbooks
- Tabla `cases` + estados
- Playbooks operativos (audit tienda, riesgo proveedor, anomalía ledger)
- Webhooks de cambio de grafo

## Fase D — Gobernanza enterprise
- Scopes por plugin
- RLS estricto tenant+actor
- Lineage de entidades
- Export audit → R2

## Fase E — Voice unificado
- Misma sesión voice + agent + ontology tools
- Extracción de entidades desde transcript

## Fase F — Data fusion
- Conectores Shopify / CSV / webhooks
- Jobs de sync → ontology + Vectorize

---

**Deploy Fase A**

```bash
npm run db:init
npx wrangler deploy
curl -s -H "Authorization: Bearer $TOKEN" https://<worker>/v1/ontology/types
```
