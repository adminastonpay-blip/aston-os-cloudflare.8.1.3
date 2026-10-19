import { handleVoice } from "./voice.js";
import { handleAcademy } from "./academy.js";
import { handleVideo } from "./video.js";
const SECTORS = new Set([
  "primary", "industry", "infrastructure", "fintech",
  "govtech", "health", "mobility", "media"
]);

const VERSION = "8.12.2";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-aston-os": "8.12.2",
      ...headers
    }
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
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

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function authorized(request, env, scope = "read") {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return { tenant: request.headers.get("X-Tenant") || "default", scopes: ["read", "write", "ai", "admin"], actor: "api-token" };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ASTON_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return { tenant: String(payload.tenant || "default"), scopes, actor: String(payload.sub || "jwt") };
  } catch { return null; }
}

// RESTORED_PARTIAL - full file continues in next commit if truncated
export default {
  async fetch(request, env, ctx) {
    return new Response(JSON.stringify({ ok: false, error: "index_restore_incomplete_use_entry", hint: "Deploy entry.js from feature/anti-gap-phase1 after full index restore" }), { status: 503, headers: { "content-type": "application/json" } });
  }
};
export class AstonSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return new Response(JSON.stringify({ ok: false }), { status: 503 }); }
}
export class AstonRateLimiter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
}
export class AstonLedgerLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
}
export { AstonAgent } from "./agent.js";
export { AstonVoiceSession } from "./voice-realtime.js";
