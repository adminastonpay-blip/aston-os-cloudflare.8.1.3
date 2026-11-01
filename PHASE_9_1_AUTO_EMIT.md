# Phase 9.1 — Auto-emit change events

**Branch:** `phase-9-1-auto-emit`  
**Version:** 12.2.1

## Objetivo
Cerrar el loop Palantir-style: cualquier mutación relevante en ontology / AIP / pipelines escribe automáticamente al change feed y dispara webhooks outbound (HMAC).

## Wired emitters

| Module | Events |
|--------|--------|
| Ontology POST entities | `entity.created` / `entity.updated` |
| Ontology POST relations | `relation.created` |
| AIP plan create | `aip.plan.proposed` |
| AIP approve | `aip.plan.approved` |
| AIP reject | `aip.plan.rejected` |
| AIP execute start | `aip.plan.executing` |
| AIP execute done | `aip.plan.executed` |
| AIP execute fail | `aip.plan.failed` |
| Pipelines upsert entity (via stage) | `entity.created` / `entity.updated` |
| Pipelines run done | `pipeline.completed` |
| Pipelines run fail | `pipeline.failed` |

Todos usan `emitChangeEvent` de `events_feed.js` → tabla `change_events` + `dispatchWebhooks`.

## Smoke test sugerido
1. `POST /v1/ontology/entities` → `GET /v1/events/feed?event=entity.created`
2. `POST /v1/aip/plan` → feed `aip.plan.proposed`
3. `POST /v1/pipelines/run/secure_ingest` con items → `pipeline.completed` + entity events
4. Webhook con `events: ["*"]` o lista específica → entrega firmada `x-aston-signature`

## Notas
- Emisión best-effort (`try/catch`); no rompe la mutación principal si el feed falla.
- Version alineada: worker / package / ontology / aip / pipelines = **12.2.1**.
