/**
 * Anti-Gap Phase 11 — Compute fabric routes
 */

import {
  getComputePolicy,
  setComputePolicy,
  getComputeCostToday,
  resolveComputeRoute,
  recordComputeCost,
  computeTrustNotes,
  TIERS,
  TIER_COST_USD
} from "./compute.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE11_VERSION = "8.12.3-p11";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE11_VERSION
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

export async function tryHandlePhase11(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P11 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "GET" && path === "/v1/compute/tiers") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    return json(
      {
        ok: true,
        tiers: Object.values(TIERS),
        estimated_usd_per_request: TIER_COST_USD,
        positioning: computeTrustNotes(),
        anti_gap: { phase: 11, version: PHASE11_VERSION }
      },
      200,
      request,
      env
    );
  }

  if (path === "/v1/compute/policy") {
    if (method === "GET") {
      const auth = await authorized(request, env, "read");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const result = await getComputePolicy(env, auth.tenant);
      return json(
        { ...result, anti_gap: { phase: 11, version: PHASE11_VERSION } },
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
      const result = await setComputePolicy(env, auth.tenant, body);
      return json(
        { ...result, anti_gap: { phase: 11, version: PHASE11_VERSION } },
        result.ok ? 200 : 400,
        request,
        env
      );
    }
  }

  if (method === "GET" && path === "/v1/compute/cost") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const [cost, policy] = await Promise.all([
      getComputeCostToday(env, auth.tenant),
      getComputePolicy(env, auth.tenant)
    ]);
    return json(
      {
        ok: cost.ok,
        ...cost,
        max_usd_per_day: policy.ok ? policy.max_usd_per_day : null,
        remaining_usd:
          policy.ok && cost.ok ? Math.max(0, policy.max_usd_per_day - cost.total_usd) : null,
        anti_gap: { phase: 11, version: PHASE11_VERSION }
      },
      cost.ok ? 200 : 503,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/compute/route") {
    const auth = await authorized(request, env, "ai");
    if (!auth) {
      const auth2 = await authorized(request, env, "write");
      if (!auth2) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      return handleRoute(request, env, ctx, auth2);
    }
    return handleRoute(request, env, ctx, auth);
  }

  if (method === "POST" && path === "/v1/compute/cost") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    await recordComputeCost(env, auth.tenant, body.tier || "edge", body.usd, body.requests || 1);
    const cost = await getComputeCostToday(env, auth.tenant);
    return json(
      { ok: true, recorded: true, ...cost, anti_gap: { phase: 11, version: PHASE11_VERSION } },
      200,
      request,
      env
    );
  }

  return null;
}

async function handleRoute(request, env, ctx, auth) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const started = Date.now();
  const route = await resolveComputeRoute(env, auth.tenant, {
    preferred_tier: body.preferred_tier || body.tier,
    force_edge: body.force_edge === true,
    residency: body.residency
  });

  if (!route.allowed) {
    return json(
      {
        ok: false,
        error: route.reason,
        ...route,
        anti_gap: { phase: 11, version: PHASE11_VERSION }
      },
      route.status || 429,
      request,
      env
    );
  }

  if (body.commit === true) {
    await recordComputeCost(env, auth.tenant, route.tier, route.estimated_usd, 1);
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(
      recordRoiEvent(env, {
        tenant_id: auth.tenant,
        route: "/v1/compute/route",
        latency_ms: Date.now() - started,
        outcome: "ok"
      }).catch(() => {})
    );
  }

  return json(
    { ok: true, ...route, anti_gap: { phase: 11, version: PHASE11_VERSION } },
    200,
    request,
    env
  );
}

export function enrichHealthPhase11(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 11);
  result.anti_gap.version = PHASE11_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "compute_routing",
    "compute_budget",
    "edge_first"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p11_enabled = env.ANTI_GAP_P11 !== "false";
  result.anti_gap.compute = computeTrustNotes();
  return result;
}
