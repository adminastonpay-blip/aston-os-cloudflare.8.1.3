# Phase 11 — Object Sets + Saved Views

**Branch:** `phase-11-object-sets`  
**Version:** 12.4.0  
**Stacks on:** Phase 10 Graph Intelligence

## Goal
Named, persisted filters over ontology entities — the operational building block for apps, AIP context, and pipelines (Palantir Object Sets lite).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/object-sets` | Status + endpoint map |
| GET | `/v1/object-sets/list` | List saved sets |
| POST | `/v1/object-sets` | Create set (`name`, `filter`, optional `static_ids`) |
| GET | `/v1/object-sets/:id` | Get set definition |
| PUT | `/v1/object-sets/:id` | Update filter / name / snapshot |
| DELETE | `/v1/object-sets/:id` | Delete |
| GET | `/v1/object-sets/:id/members` | Resolve membership (ACL filtered) |
| POST | `/v1/object-sets/preview` | Dry-run a filter without saving |
| POST | `/v1/object-sets/:id/snapshot` | Freeze current members as static snapshot |

## Filter shape
```json
{
  "type": "supplier",
  "q": "acme",
  "source": "pipeline:secure_ingest",
  "ids": ["ent_…"],
  "props_contains": { "key": "country", "value": "AR" },
  "limit": 50
}
```

## Modes
- **Dynamic** — re-evaluate filter on each `/members` call
- **Snapshot** — frozen `static_ids` from `/snapshot`

## Security
Members always pass `filterEntitiesByAcl`. Denied entities never returned.

## Events
`object_set.created` · `object_set.updated` · `object_set.deleted` · `object_set.snapshot`
