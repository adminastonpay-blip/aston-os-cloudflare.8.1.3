# Phase 12 — Functions on Objects / Transforms

**Branch:** `phase-12-functions`  
**Version:** 12.5.0  
**Stacks on:** Phase 11 Object Sets

## Goal
Declarative transforms over object sets or entity lists with optional writeback — Foundry Functions lite.

## Catalog

| id | Writeback | Description |
|----|-----------|-------------|
| `tag_prop` | yes | Set props[key]=value |
| `score_risk` | yes | Heuristic risk_score |
| `normalize_name` | yes | Trim/collapse name |
| `flag_missing_props` | yes | Mark missing required keys |
| `count_by_type` | no | Aggregate counts |
| `derive_summary` | yes | Create metric entity summarizing set |

## Endpoints

| Method | Path |
|--------|------|
| GET | `/v1/functions/catalog` |
| POST | `/v1/functions/run` or `/v1/functions/run/:id` |
| GET | `/v1/functions/runs` |

### Run body
```json
{
  "function_id": "score_risk",
  "object_set_id": "oset_…",
  "entity_ids": ["ent_…"],
  "filter": { "type": "supplier" },
  "params": { "key": "reviewed", "value": true },
  "dry_run": false,
  "limit": 50
}
```
Provide one of: `object_set_id` | `entity_ids` | `filter`.

## Security
- Members filtered by ACL before run
- Each write gated with `gateEntityWrite`
- Emits `entity.updated` / `entity.created` / `function.completed`

## Limits
≤ 100 entities per run · dry_run supported
