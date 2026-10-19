/**
 * Anti-Gap Phase 10 — Plans, quotas, trust routes
 */

import {
  listPlanCatalog,
  getTenantPlan,
  setTenantPlan,
  getUsage,
  checkQuota,
  incrementUsage,
  buildTrustPayload
} from "./plans.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE10_VERSION = "8.12.3-p10";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE10_VERSION
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

export async function tryHandlePhase10(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P10 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "GET" && (path === "/v1/trust" || path === "/.well-known/aston-trust")) {
    const payload = await buildTrustPayload(env);
    return json(
      { ...payload, anti_gap: { phase: 10, version: PHASE10_VERSION } },
      200,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/plans") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    return json(
      { ok: true, plans: listPlanCatalog(), anti_gap: { phase: 10, version: PHASE10_VERSION } },
      200,
      request,
      env
    );
  }

  if (path === "/v1/tenant/plan") {
    if (method === "GET") {
      const auth = await authorized(request, env, "read");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const result = await getTenantPlan(env, auth.tenant);
      return json(
        { ...result, anti_gap: { phase: 10, version: PHASE10_VERSION } },
        result.ok ? 200 : 503,
        request,
        env
      );
    }
    if (method === "POST") {
      const auth = await authorized(request, env, "admin");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "invalid_json" }, 400, request, env);
      }
      const result = await setTenantPlan(env, auth.tenant, body);
      return json(
        { ...result, anti_gap: { phase: 10, version: PHASE10_VERSION } },
        result.ok ? 200 : 400,
        request,
        env
      );
    }
  }

  if (method === "GET" && path === "/v1/tenant/usage") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const day = url.searchParams.get("day") || undefined;
    const [usage, plan] = await Promise.all([
      getUsage(env, auth.tenant, day),
      getTenantPlan(env, auth.tenant)
    ]);
    return json(
      {
        ok: usage.ok,
        tenant: auth.tenant,
        day: usage.day,
        usage: usage.usage || {},
        quotas: plan.ok ? plan.quotas : null,
        plan_id: plan.ok ? plan.plan_id : null,
        anti_gap: { phase: 10, version: PHASE10_VERSION }
      },
      usage.ok ? 200 : 503,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/tenant/quota/check") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const metric = body.metric || "ai_requests_per_day";
    const hard = body.hard === true;
    const started = Date.now();
    const check = await checkQuota(env, auth.tenant, metric, { hard });

    if (check.allowed && body.increment !== false) {
      await incrementUsage(env, auth.tenant, metric, body.amount || 1);
      check.used = (check.used || 0) + (body.amount || 1);
      check.remaining = check.limit != null ? Math.max(0, check.limit - check.used) : null;
    }

    if (!check.allowed) {
      return json(
        {
          ok: false,
          error: "quota_exceeded",
          ...check,
          anti_gap: { phase: 10, version: PHASE10_VERSION }
        },
        429,
        request,
        env
      );
    }

    if (ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: auth.tenant,
          route: "/v1/tenant/quota/check",
          latency_ms: Date.now() - started,
          outcome: "ok"
        }).catch(() => {})
      );
    }

    return json(
      { ok: true, ...check, anti_gap: { phase: 10, version: PHASE10_VERSION } },
      200,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase10(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 10);
  result.anti_gap.version = PHASE10_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "plans",
    "quotas",
    "trust_center"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p10_enabled = env.ANTI_GAP_P10 !== "false";
  return result;
}
