/**
 * ASTON OS 11.3.3 — pure ES Module, zero imports in entry
 * No cloudflare:workers import (can break format detection in some CI).
 * No re-exports. Real export default + export class in THIS file.
 */
const VERSION = "11.3.3";

function json(data, status, headers) {
  status = status || 200;
  headers = headers || {};
  var h = { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION };
  for (var k in headers) h[k] = headers[k];
  return new Response(JSON.stringify(data), { status: status, headers: h });
}

function corsHeaders(request) {
  var origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor,X-Sovereign-Master-Key,X-Sovereign-License",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, "") || "/";
    var method = request.method.toUpperCase();
    var cors = corsHeaders(request);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json(
        {
          ok: true,
          service: "ASTON OS",
          brand: "ASTON OS",
          version: VERSION,
          runtime: "cloudflare-workers",
          format: "es-module",
          phase: "11-native"
        },
        200,
        cors
      );
    }

    try {
      var routes = await import("./routes.js");
      return await routes.handleRequest(request, env, ctx, path, method, cors, json);
    } catch (err) {
      return json(
        {
          ok: false,
          error: "route_load_failed",
          detail: String(err && err.message ? err.message : err).slice(0, 400)
        },
        500,
        cors
      );
    }
  },

  async scheduled(controller, env, ctx) {
    if (env && env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), {
          expirationTtl: 1209600
        });
      } catch (e) {}
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
      var body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: "json_required" }, 400);
      }
      var cur = (await this.state.storage.get("session")) || {};
      var next = Object.assign({}, cur, body, { updated_at: new Date().toISOString() });
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
    var key = "count:" + Math.floor(Date.now() / 60000);
    var count = (await this.state.storage.get(key)) || 0;
    var limit = Number((this.env && this.env.RATE_LIMIT_PER_MINUTE) || 120);
    if (count >= limit) {
      return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "60" });
    }
    await this.state.storage.put(key, count + 1);
    return json({ ok: true, remaining: limit - count - 1 });
  }
}

export class AstonLedgerLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    var body = {};
    try {
      body = await request.json();
    } catch (e) {}
    var key = String((body && body.key) || "default");
    return json({ ok: true, key: key, value: (await this.state.storage.get(key)) ?? null });
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
