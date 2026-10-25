/**
 * ASTON OS — ES Module entry (main = entry.mjs)
 * Phase 1: Ontology Studio  |  Phase 2: Connectors Pipeline
 */
import { handleUI } from "./ui.js";
import { handleConnectors } from "./connectors.js";

const VERSION = "10.7.0";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor,X-Shopify-Topic,X-Shopify-Hmac-Sha256",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "GET" && (path === "/ui" || path === "/ui/studio" || path === "/v1/ui" || path === "/v1/ui/studio")) {
      const res = handleUI(request, env, path);
      if (res) return res;
    }

    if (path.startsWith("/v1/connectors")) {
      return handleConnectors(request, env, path, method, cors);
    }

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json({
        ok: true,
        service: "ASTON OS",
        version: VERSION,
        runtime: "cloudflare-workers",
        format: "es-module",
        phase: "2-connectors",
        ui: { command: "/ui", studio: "/ui/studio" },
        connectors: {
          catalog: "/v1/connectors/catalog",
          status: "/v1/connectors/status",
          webhook: "/v1/connectors/webhook/:token"
        },
        durable_objects: [
          "AstonSession", "AstonRateLimiter", "AstonLedgerLock",
          "AstonAgent", "AstonVoiceSession", "AstonOntology", "AstonOrchestrator"
        ]
      }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path, hint: "Try /ui/studio, /v1/connectors/catalog, /health" }, 404, cors);
  },

  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), { expirationTtl: 1209600 });
      } catch (_) {}
    }
  }
};

export class AstonSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (request.method === "GET") return json({ ok: true, session: (await this.ctx.storage.get("session")) ?? null });
    if (request.method === "DELETE") { await this.ctx.storage.deleteAll(); return json({ ok: true, deleted: true }); }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ ok: false, error: "json_required" }, 400);
      const next = { ...((await this.ctx.storage.get("session")) || {}), ...body, updated_at: new Date().toISOString() };
      await this.ctx.storage.put("session", next);
      return json({ ok: true, session: next });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export class AstonRateLimiter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const key = `count:${Math.floor(Date.now() / 60000)}`;
    const count = (await this.ctx.storage.get(key)) || 0;
    const limit = Number(this.env.RATE_LIMIT_PER_MINUTE || 120);
    if (count >= limit) return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "60" });
    await this.ctx.storage.put(key, count + 1);
    return json({ ok: true, remaining: limit - count - 1 });
  }
}

export class AstonLedgerLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const key = String(body.key || "default");
    return json({ ok: true, key, value: (await this.ctx.storage.get(key)) ?? null });
  }
}

export class AstonAgent {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return json({ ok: true, service: "AstonAgent" }); }
}

export class AstonVoiceSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return json({ ok: true, service: "AstonVoiceSession" }); }
}

export class AstonOntology {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return json({ ok: true, service: "AstonOntology" }); }
}

export class AstonOrchestrator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return json({ ok: true, service: "AstonOrchestrator" }); }
}
