# ASTON Intelligence Lab v1

## Purpose

A separate Cloudflare Worker for model-assisted problem analysis and a second-pass critique. This is a controlled foundation for ASTON's future orchestration layer, not a claim of general intelligence or universal problem-solving.

## Safety boundary

- The production Worker, root `index.js`, `wrangler.toml`, database schema, and Durable Object migrations are not changed by this feature.
- `wrangler.nextgen.toml` names a separate Worker: `aston-os-intelligence-lab`.
- The lab has only a Workers AI binding. It has no production D1, KV, R2, Queue, or Durable Object bindings.
- The solve endpoint is disabled for requests unless the `ASTON_API_TOKEN` secret is configured.
- It performs analysis only. It does not execute plans, call arbitrary URLs, access external systems, or perform financial or administrative actions.
- The second model call is a critique, not independent factual verification.
- Keep high-impact decisions under human approval.

## API

- `GET /health`: reports Worker version, AI binding presence, and whether the API token is configured. It does not make a model call.
- `POST /v1/intelligence/solve`: requires `Authorization: Bearer <ASTON_API_TOKEN>` and JSON `{"problem":"...","context":"optional" }`.
- Problem input is limited to 12,000 characters; optional context is truncated to 6,000 characters.
- Responses explicitly identify analysis-only mode and that no external action was taken.

## Test and deploy

1. Run `node nextgen/test.mjs`.
2. Run `npx wrangler deploy --dry-run --config wrangler.nextgen.toml` in the repository's configured build environment.
3. Review model availability and usage/cost limits for the Cloudflare account.
4. Set the secret using `npx wrangler secret put ASTON_API_TOKEN --config wrangler.nextgen.toml`; never commit or paste the secret into chat.
5. Deploy only the isolated lab with `npx wrangler deploy --config wrangler.nextgen.toml`.
6. Verify its health and authorized solve endpoint. Do not route production traffic to it until reviewed.

## Next stages

1. Add task schemas and structured outputs with schema validation.
2. Add an explicit tool registry with per-tool permission scopes and allowlists.
3. Add persisted evaluation cases and score outcomes before/after changes.
4. Add tenant-isolated storage only after reviewing bindings, retention, and migrations.
5. Introduce bounded queues and durable orchestration only after load and failure-mode tests.

## Known limitations

- Model identifier availability can change; validate `ASTON_MODEL` in the target Cloudflare account.
- The first version does not implement a true multi-agent scheduler, web research, persistent memory, or automated tool execution.
- No benchmark currently demonstrates superiority over other model providers. Establish repeatable evaluation sets before making comparative claims.
