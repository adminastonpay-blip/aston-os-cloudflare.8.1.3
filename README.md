# ASTON OS Omni-Core 8.5.1

Cloudflare Workers module runtime for ASTON OS. This repository contains the Worker entry point (`index.js`), the Durable Object agent (`agent.js`), D1 schema, and Wrangler configuration.

## Shopify / ASTON Intelligence integration

### Public advisory gateway
- `GET /v1/agent/capabilities` — reports whether the public gateway is enabled and which non-sensitive features are available.
- `POST /v1/agent/public` — rate-limited conversational problem analysis and planning for the Shopify storefront.
- The public gateway is advisory only. It does not access private tenant records or ledger data, run the authenticated agent tools, modify systems, or execute external actions.
- The request accepts `prompt` (or `message`), a short `history` array, and limited page context.
- The response includes `answer`, `mode: "advisory"`, `actions_executed: false`, and a verification marker.

The public gateway requires:
- Workers AI binding: `AI`
- Durable Object binding: `ASTON_RATE_LIMITER`
- `PUBLIC_AGENT=true`
- `PUBLIC_AGENT_RATE_LIMIT_PER_MINUTE=8` (configurable; per-IP limit)
- An exact storefront origin in `ALLOWED_ORIGIN`

Never put `ASTON_API_TOKEN` or `ASTON_JWT_SECRET` in Shopify Liquid, theme settings exposed to the storefront, or browser JavaScript.

### Authenticated agent
- `POST /v1/agent/run` — existing per-tenant agent with read-oriented tools and traces.
- `GET /v1/agent/memory` and `GET /v1/agent/traces` — authenticated agent history and traces.
- These routes require server-side authorization and the `ASTON_AGENT` and `AI` bindings.

## Existing route families

- Health and capabilities: `GET /`, `GET /health`, `GET /v1/plugins`, `GET /v1/agent/capabilities`
- AI: `POST /v1/ai/chat`, `POST /v1/ai/image`
- Records and search: `GET|POST /v1/records/:sector`, `POST /v1/ingest/:sector`, `POST /v1/search`, optional semantic search when Vectorize is configured
- Operations: `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/diagnostics/storage`
- Session, ledger, audit, stats, and media routes require the relevant authorization and bindings.

## Validation before deployment

1. Review the pull request and verify the intended Cloudflare Worker name and environment.
2. Confirm the Workers AI and Durable Object bindings exist in the target environment.
3. Set `ALLOWED_ORIGIN` to the exact storefront origin used by the Shopify preview and storefront.
4. Run `npm test` and `npm run check` in the project environment.
5. Deploy deliberately with Wrangler; this repository branch does not deploy itself.
6. Verify `GET /v1/agent/capabilities`, then test a short message from the unpublished Shopify theme.
7. Keep authenticated actions behind a server-side identity/authorization layer before enabling task execution.
