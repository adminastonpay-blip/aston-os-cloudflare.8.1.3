/**
 * ASTON OS Anti-Gap Phase 1 — route handlers (additive)
 */
import { probeBindings } from "./resilience.js";
import { ensureRoiSchema, recordRoiEvent, summarizeRoi, checkBudget } from "./roi.js";

export const ANTI_GAP_PHASE = "1";
export const ANTI_GAP_VERSION = "8.12.3-p1";

export async function enrichHealth(result, env, url) {
  result.anti_gap = {
    phase: ANTI_GAP_PHASE,
    version: ANTI_GAP_VERSION,
    features: ["roi_metering", "deep_health", "circuit_breakers", "d1_failover_helpers"],
    enabled: env.ANTI_GAP !== "false"
  };
  if (url.searchParams.get("deep") === "1") {
    const probes = await probeBindings(env);
    result.deep = probes;
    result.checks = { ...result.checks, ...probes };
    if (probes.degraded) result.degraded = true;
  }
  return result;
}

export async function tryHandleAntiGap(request, env, ctx, helpers) {
  if (env.ANTI_GAP === "false") return null;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const { json, authorized } = helpers;

  if (method === "GET" && path === "/v1/roi/summary") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const data = await summarizeRoi(env, auth.tenant, days);
    return json(data, data.ok ? 200 : 503);
  }
  if (method === "GET" && path === "/v1/roi/by-route") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const data = await summarizeRoi(env, auth.tenant, days);
    if (!data.ok) return json(data, 503);
    return json({ ok: true, tenant: data.tenant, days, by_route: data.by_route }, 200);
  }
  if (method === "GET" && path === "/v1/roi/budget") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401);
    const budget = await checkBudget(env, auth.tenant);
    return json({ ok: true, tenant: auth.tenant, budget }, 200);
  }
  if (method === "POST" && path === "/v1/roi/event") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401);
    let body = {};
    try { body = await request.json(); } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    const started = Date.now();
    const ok = await recordRoiEvent(env, {
      tenant_id: auth.tenant,
      route: body.route || "manual",
      model: body.model,
      tokens_in: body.tokens_in,
      tokens_out: body.tokens_out,
      cost_usd_micros: body.cost_usd_micros,
      latency_ms: body.latency_ms ?? Date.now() - started,
      outcome: body.outcome || "ok"
    });
    return json({ ok, tenant: auth.tenant }, ok ? 202 : 503);
  }
  if (method === "POST" && path === "/v1/roi/init") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      if (env.ASTON_DB) await ensureRoiSchema(env.ASTON_DB);
      if (env.ASTON_DB_BACKUP) await ensureRoiSchema(env.ASTON_DB_BACKUP);
      return json({ ok: true, tenant: auth.tenant, initialized: true }, 200);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 300) }, 500);
    }
  }
  return null;
}

export function scheduleRoi(ctx, env, event) {
  if (env.ANTI_GAP === "false") return;
  if (!ctx?.waitUntil) {
    recordRoiEvent(env, event).catch(() => {});
    return;
  }
  ctx.waitUntil(recordRoiEvent(env, event).catch((e) => console.error("[roi]", e?.message || e)));
}

function corsHeadersStandalone(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8"
  };
  if (allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  else if (origin) headers["access-control-allow-origin"] = origin;
  else headers["access-control-allow-origin"] = "*";
  return headers;
}

function jsonStandalone(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeadersStandalone(request, env)
  });
}

async function authorizedStandalone(request, env, scope = "read") {
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
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.ASTON_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0)
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

export async function enrichHealthResponse(data, env, url) {
  return enrichHealth(data, env, url);
}

export async function tryHandleAntiGapStandalone(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  const json = (data, status = 200) => jsonStandalone(data, status, request, env);
  const authorized = (req, e, scope) => authorizedStandalone(req, e, scope);
  return tryHandleAntiGap(request, env, ctx, { json, authorized });
}
