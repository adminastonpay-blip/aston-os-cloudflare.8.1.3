/**
 * Anti-Gap Phase 8 — SecOps fabric routes
 */

import {
  ingestSecopsEvent,
  savePlaybook,
  listPlaybooks,
  listSecopsEvents,
  listAuditChain
} from "./secops.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE8_VERSION = "8.12.3-p8";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Source",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE8_VERSION
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

export async function tryHandlePhase8(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P8 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "POST" && path === "/v1/secops/events") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const source =
      request.headers.get("X-Aston-Source") || body.source || url.searchParams.get("source") || "generic";
    const started = Date.now();
    const result = await ingestSecopsEvent(env, auth.tenant, source, body, { ctx });
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: auth.tenant,
          route: "/v1/secops/events",
          latency_ms: Date.now() - started,
          outcome: result.ok ? "ok" : "error"
        }).catch(() => {})
      );
    }
    return json(
      { ...result, anti_gap: { phase: 8, version: PHASE8_VERSION } },
      result.ok ? 202 : 400,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/secops/events") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const limit = Number(url.searchParams.get("limit")) || 50;
    const result = await listSecopsEvents(env, auth.tenant, limit);
    return json(
      { ...result, anti_gap: { phase: 8, version: PHASE8_VERSION } },
      result.ok ? 200 : 503,
      request,
      env
    );
  }

  if (path === "/v1/secops/playbooks") {
    if (method === "GET") {
      const auth = await authorized(request, env, "read");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const result = await listPlaybooks(env, auth.tenant);
      return json(
        { ...result, anti_gap: { phase: 8, version: PHASE8_VERSION } },
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
      const result = await savePlaybook(env, auth.tenant, body);
      return json(
        { ...result, anti_gap: { phase: 8, version: PHASE8_VERSION } },
        result.ok ? 201 : 400,
        request,
        env
      );
    }
  }

  if (method === "GET" && path === "/v1/secops/audit") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const limit = Number(url.searchParams.get("limit")) || 50;
    const result = await listAuditChain(env, auth.tenant, limit);
    return json(
      { ...result, anti_gap: { phase: 8, version: PHASE8_VERSION } },
      result.ok ? 200 : 503,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase8(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 8);
  result.anti_gap.version = PHASE8_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "secops_ingest",
    "secops_playbooks",
    "secops_audit_chain"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p8_enabled = env.ANTI_GAP_P8 !== "false";
  return result;
}
