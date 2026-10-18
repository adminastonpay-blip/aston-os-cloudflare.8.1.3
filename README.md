# ASTON OS

Edge AI Worker on Cloudflare (Workers, D1, R2, KV, Durable Objects, Workers AI).

**Brand:** ASTON OS only. No third-party clothing-store or legacy store names (no Leyni / Leyni Aston).

## Version

See `package.json` / `GET /` → `version`.

## Auth

Protected routes need:

```http
Authorization: Bearer <ASTON_API_TOKEN>
```

Optional secret for voice:

```bash
npx wrangler secret put ELEVENLABS_API_KEY
```

## Main routes

| Area | Paths |
|------|--------|
| Health | `GET /`, `GET /health` |
| Plugins | `GET /v1/plugins` |
| AI | `POST /v1/ai/chat`, `POST /v1/ai/image`, `POST /v1/ai/video` |
| Voice | `POST /v1/voice/tts`, `POST /v1/voice/stt`, `POST /v1/voice/speak` |
| Academy | `GET /academy/courses`, `POST /academy/enroll` |
| Agent | `POST /v1/agent/run` |

## Deploy note

Do **not** bind Vectorize until the index exists, or remove the `VECTORIZE` binding from the Cloudflare dashboard if the index is missing.
