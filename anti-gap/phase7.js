/**
 * Anti-Gap Phase 7 — webhook + event bus routes
 */

import {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  emitEvent,
  listDeliveries,
  retryPendingDeliveries
} from "./webhooks.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE7_VERSION = "8.12.3-p7";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE7_VERSION
  };
  if (allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  else if (origin) headers["access-control-allow-origin"] = origin;
  else headers["access-control-allow-origin"] = "*";
  return headers;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request, env)
  });
}

async function authorized(request, env, scope = "read") {
  const value = request.headers.get("Authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      scopes: ["read", "write", "ai", "admin"],
      actor: "api-token"
    };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
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

export async function tryHandlePhase7(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P7 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "POST" && path === "/v1/webhooks") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const result = await registerWebhook(env, auth.tenant, body);
    return json(
      { ...result, anti_gap: { phase: 7, version: PHASE7_VERSION } },
      result.ok ? 201 : 400,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/webhooks") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const result = await listWebhooks(env, auth.tenant);
    return json(
      { ...result, anti_gap: { phase: 7, version: PHASE7_VERSION } },
      result.ok ? 200 : 503,
      request,
      env
    );
  }

  if (method === "DELETE" && path.startsWith("/v1/webhooks/")) {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const id = path.slice("/v1/webhooks/".length);
    const result = await deleteWebhook(env, auth.tenant, id);
    return json(
      { ...result, anti_gap: { phase: 7, version: PHASE7_VERSION } },
      200,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/events") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const type = body.type || body.event || "custom";
    const data = body.data ?? body.payload ?? {};
    const started = Date.now();
    const result = await emitEvent(env, auth.tenant, type, data, {
      ctx,
      max_attempts: body.max_attempts
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: auth.tenant,
          route: "/v1/events",
          latency_ms: Date.now() - started,
          outcome: result.ok ? "ok" : "error"
        }).catch(() => {})
      );
    }
    return json(
      { ...result, anti_gap: { phase: 7, version: PHASE7_VERSION } },
      result.ok ? 202 : 503,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/events/deliveries") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const limit = Number(url.searchParams.get("limit")) || 50;
    const result = await listDeliveries(env, auth.tenant, limit);
    return json(
      { ...result, anti_gap: { phase: 7, version: PHASE7_VERSION } },
      result.ok ? 200 : 503,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase7(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 7);
  result.anti_gap.version = PHASE7_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "webhooks",
    "event_bus",
    "webhook_retries"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p7_enabled = env.ANTI_GAP_P7 !== "false";
  return result;
}

export async function runPhase7Cron(env) {
  try {
    return await retryPendingDeliveries(env);
  } catch (e) {
    console.error("[p7-cron]", e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
