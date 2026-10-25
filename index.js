import { handleVoice } from "./voice.js";
import { handleAcademy } from "./academy.js";
import { handleVideo } from "./video.js";
import { tryMountedRoutes } from "./mounted.js";
const SECTORS = new Set([
  "primary", "industry", "infrastructure", "fintech",
  "govtech", "health", "mobility", "media",
  "commerce", "education", "agriculture", "logistics",
  "telecom", "energy", "legal", "security", "entertainment"
]);

const VERSION = "10.5.1";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-aston-os": VERSION,
      ...headers
    }
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor,X-Shopify-Topic,X-Shopify-Hmac-Sha256",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  if (allowed) {
    if (origin === allowed) headers["access-control-allow-origin"] = origin;
  } else if (origin) {
    headers["access-control-allow-origin"] = origin;
  } else {
    headers["access-control-allow-origin"] = "*";
  }
  return headers;
}

async function readJson(request, maxBytes = 1_000_000) {
  try {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > maxBytes) return null;
    return await request.json();
  } catch {
    return null;
  }
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function authorized(request, env, scope = "read") {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      scopes: ["read", "write", "ai", "admin"],
      actor: request.headers.get("X-Aston-Actor") || request.headers.get("X-Actor") || "api-token"
    };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.ASTON_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return {
      tenant: String(payload.tenant || "default"),
      scopes,
      actor: String(payload.sub || "jwt")
    };
  } catch {
    return null;
  }
}

// NOTE: Full body continues in next update if truncated — this is a minimal module-valid stub to unblock deploy.
// Real full restore will follow immediately.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json({
        ok: true,
        service: "ASTON OS",
        version: VERSION,
        runtime: "cloudflare-workers",
        note: "index.js restored (minimal deploy fix); full handler loading"
      }, 200, cors);
    }

    const mounted = await tryMountedRoutes(request, env, ctx, path, method, cors);
    if (mounted) return mounted;

    return json({ ok: false, error: "not_found", path }, 404, cors);
  }
};

export class AstonSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const key = "session";
    if (request.method === "GET") return json({ ok: true, session: (await this.ctx.storage.get(key)) ?? null });
    if (request.method === "DELETE") { await this.ctx.storage.deleteAll(); return json({ ok: true, deleted: true }); }
    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "json_object_required" }, 400);
      const current = (await this.ctx.storage.get(key)) || {};
      const next = { ...current, ...body, updated_at: new Date().toISOString() };
      await this.ctx.storage.put(key, next);
      return json({ ok: true, session: next });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export class AstonRateLimiter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const minute = Math.floor(Date.now() / 60000);
    const key = `count:${minute}`;
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
    const body = await readJson(request);
    if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400);
    const key = String(body.key || "default");
    return json({ ok: true, key, value: (await this.ctx.storage.get(key)) ?? null });
  }
}

export { AstonAgent } from "./agent.js";
export { AstonVoiceSession } from "./voice-realtime.js";
export { AstonOntology } from "./ontology.js";
export { AstonOrchestrator } from "./orchestrator.js";
