/**
 * ASTON OS 12.0.0 — Phase 7 Observability
 */
const VERSION = "12.0.0";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-aston-os": VERSION,
      ...headers
    }
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      "Authorization,Content-Type,X-Tenant,X-Aston-Actor,X-Aston-Role,X-Sovereign-Master-Key,X-Sovereign-License,X-Shopify-Topic,X-Shopify-Hmac-Sha256",
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

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json(
        {
          ok: true,
          service: "ASTON OS",
          version: VERSION,
          runtime: "cloudflare-workers",
          format: "es-module",
          phase: "7-observability",
          capabilities: "/v1/capabilities",
          metrics: "/v1/metrics/summary",
          ui: "/ui",
          ops: "/v1/ops/rate-limit",
          foundry: "/v1/foundry",
          pipelines: "/v1/pipelines/catalog",
          security: "/v1/security/status",
          ontology: "/v1/ontology",
          aip: "/v1/aip"
        },
        200,
        cors
      );
    }

    try {
      const routes = await import("./routes.js");
      return await routes.handleRequest(request, env, ctx, path, method, cors, json);
    } catch (err) {
      return json(
        {
          ok: false,
          error: "route_load_failed",
          detail: String(err && err.message ? err.message : err).slice(0, 300)
        },
        500,
        cors
      );
    }
  },

  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), {
          expirationTtl: 1209600
        });
      } catch (_) {}
    }
  }
};

export class AstonSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    if (request.method === "GET") {
      return json({ ok: true, session: (await this.state.storage.get("session")) ?? null });
    }
    if (request.method === "DELETE") {
      await this.state.storage.deleteAll();
      return json({ ok: true, deleted: true });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ ok: false, error: "json_required" }, 400);
      const next = {
        ...((await this.state.storage.get("session")) || {}),
        ...body,
        updated_at: new Date().toISOString()
      };
      await this.state.storage.put("session", next);
      return json({ ok: true, session: next });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export class AstonRateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const limit = Number(body.limit || this.env.RATE_LIMIT_PER_MINUTE || 120);
    const key = `count:${Math.floor(Date.now() / 60000)}`;
    const count = (await this.state.storage.get(key)) || 0;
    if (count >= limit) {
      return json({ ok: false, error: "rate_limited", remaining: 0 }, 429, { "retry-after": "60" });
    }
    await this.state.storage.put(key, count + 1);
    return json({ ok: true, remaining: limit - count - 1, limit });
  }
}

export class AstonLedgerLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const key = String(body.key || "default");
    return json({ ok: true, key, value: (await this.state.storage.get(key)) ?? null });
  }
}

export class AstonAgent {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch() {
    return json({ ok: true, service: "AstonAgent" });
  }
}

export class AstonVoiceSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch() {
    return json({ ok: true, service: "AstonVoiceSession" });
  }
}

export class AstonOntology {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch() {
    return json({ ok: true, service: "AstonOntology" });
  }
}

export class AstonOrchestrator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch() {
    return json({ ok: true, service: "AstonOrchestrator" });
  }
}
