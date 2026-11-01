# Phase 9 — Change Feed + Webhooks

**Branch:** `phase-9-webhooks-feed`  
**Version:** 12.2.0

## Change feed (poll)

```bash
GET /v1/events/feed?since=2026-11-01T00:00:00.000Z&limit=50
GET /v1/events/feed?event=entity.updated
```

Returns `cursor` (last `created_at`) for pagination.

## Webhooks

```bash
POST /v1/webhooks
{
  "url": "https://example.com/hook",
  "secret": "optional-hmac-secret",
  "events": ["entity.created", "aip.plan.executed", "*"]
}

POST /v1/webhooks/:id/test
DELETE /v1/webhooks/:id   # soft deactivate
```

Delivery headers:
- `x-aston-event`
- `x-aston-event-id`
- `x-aston-signature: sha256=...` (if secret set)

After 20 consecutive failures the webhook is auto-deactivated.

## Emit (manual / integrations)

```bash
POST /v1/events/emit
{ "event": "entity.created", "resource_kind": "entity", "resource_id": "ent_…", "payload": {} }
```

Programmatic: `import { emitChangeEvent } from "./events_feed.js"`
