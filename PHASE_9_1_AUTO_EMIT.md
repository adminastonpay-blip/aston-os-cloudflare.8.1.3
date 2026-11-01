# Phase 9.1 — Auto-emit change events

**Branch:** `phase-9-1-auto-emit`  
**Version:** 12.2.1

## Wired emitters

| Module | Events |
|--------|--------|
| Ontology POST entities | `entity.created` / `entity.updated` |
| Ontology POST relations | `relation.created` |
| AIP plan / approve / reject / execute | `aip.plan.*` |
| Pipelines run done | `pipeline.completed` |

Uses `emitChangeEvent` → change feed + webhooks.
