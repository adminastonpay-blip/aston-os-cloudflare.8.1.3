/**
 * ASTON OS entry — pure ES Module, zero imports.
 * All Durable Object classes are defined in this file so Wrangler format
 * detection always sees export default + named exports (modules, not service-worker).
 * Business logic routes restored after successful deploy.
 */
const VERSION = "10.5.1";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-aston-os": VERSION,
      ...headers
    }
  });

function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const h = cors(request);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: h });
    }

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json(
        {
          ok: true,
          service: "ASTON OS",
          version: VERSION,
          runtime: "cloudflare-workers",
          format: "es-module",
          durable_objects: [
            "AstonSession",
            "AstonRateLimiter",
            "AstonLedgerLock",
            "AstonAgent",
            "AstonVoiceSession",
            "AstonOntology",
            "AstonOrchestrator"
          ]
        },
        200,
        h
      );
    }

    return json({ ok: false, error: "not_found", path, note: "minimal deploy entry; full routes next" }, 404, h);
  },

  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), {
          expirationTtl: 60 * 60 * 24 * 14
        });
      } catch (_) {}
    }
  }
};

export class AstonSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const key = "session";
    if (request.method === "GET") {
      return json({ ok: true, session: (await this.ctx.storage.get(key)) ?? null });
    }
    if (request.method === "DELETE") {
      await this.ctx.storage.deleteAll();
      return json({ ok: true, deleted: true });
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "json_required" }, 400);
      }
      const current = (await this.ctx.storage.get(key)) || {};
      const next = { ...current, ...body, updated_at: new Date().toISOString() };
      await this.ctx.storage.put(key, next);
      return json({ ok: true, session: next });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export class AstonRateLimiter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const minute = Math.floor(Date.now() / 60000);
    const key = `count:${minute}`;
    const count = (await this.ctx.storage.get(key)) || 0;
    const limit = Number(this.env.RATE_LIMIT_PER_MINUTE || 120);
    if (count >= limit) {
      return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "60" });
    }
    await this.ctx.storage.put(key, count + 1);
    return json({ ok: true, remaining: limit - count - 1 });
  }
}

export class AstonLedgerLock {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "json_required" }, 400);
    }
    const key = String(body?.key || "default");
    return json({ ok: true, key, value: (await this.ctx.storage.get(key)) ?? null });
  }
}

export class AstonAgent {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    return json({ ok: true, service: "AstonAgent", note: "stub — full logic after deploy" });
  }
}

export class AstonVoiceSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    return json({ ok: true, service: "AstonVoiceSession", note: "stub — full logic after deploy" });
  }
}

export class AstonOntology {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    return json({ ok: true, service: "AstonOntology", note: "stub — full logic after deploy" });
  }
}

export class AstonOrchestrator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    return json({ ok: true, service: "AstonOrchestrator", note: "stub — full logic after deploy" });
  }
}
