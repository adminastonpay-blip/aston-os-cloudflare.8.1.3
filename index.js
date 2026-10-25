/**
 * ASTON OS — Cloudflare Worker (ES Module format).
 * Durable Objects require module workers. This file is the entry (main=index.js).
 * Format must be detected as modules: export default + named class exports.
 */
import { tryMountedRoutes } from "./mounted.js";

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

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  if (allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  else if (origin) headers["access-control-allow-origin"] = origin;
  else headers["access-control-allow-origin"] = "*";
  return headers;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);

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
          format: "es-module"
        },
        200,
        cors
      );
    }

    try {
      const mounted = await tryMountedRoutes(request, env, ctx, path, method, cors);
      if (mounted) return mounted;
    } catch (e) {
      console.error("mounted route error", e?.message || e);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  },

  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), {
          expirationTtl: 60 * 60 * 24 * 14
        });
      } catch (e) {
        console.error("cron kv write failed", e?.message || e);
      }
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
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "json_object_required" }, 400);
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
    const body = await readJson(request);
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "json_object_required" }, 400);
    }
    const key = String(body.key || "default");
    return json({ ok: true, key, value: (await this.ctx.storage.get(key)) ?? null });
  }
}

export { AstonAgent } from "./agent.js";
export { AstonVoiceSession } from "./voice-realtime.js";
export { AstonOntology } from "./ontology.js";
export { AstonOrchestrator } from "./orchestrator.js";
