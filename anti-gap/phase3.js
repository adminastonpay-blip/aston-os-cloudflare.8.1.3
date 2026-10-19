/**
 * Anti-Gap Phase 3 — export, purge, SLA routes
 */

import { exportTenant, downloadExport, purgeTenant } from "./export-purge.js";
import { computeSla, rollupSlaCron } from "./sla.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE3_VERSION = "8.12.3-p3";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE3_VERSION
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

export async function tryHandlePhase3(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P3 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "GET" && path === "/v1/sla") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
    const global = url.searchParams.get("global") === "1" && auth.scopes?.includes("admin");
    const data = await computeSla(env, global ? null : auth.tenant, hours);
    return json(
      { ...data, anti_gap: { phase: 3, version: PHASE3_VERSION } },
      data.ok ? 200 : 503,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/export/tenant") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const started = Date.now();
    const result = await exportTenant(env, auth.tenant, auth.actor);
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: auth.tenant,
          route: "/v1/export/tenant",
          latency_ms: Date.now() - started,
          outcome: result.ok ? "ok" : "error"
        }).catch(() => {})
      );
    }
    return json(
      { ...result, anti_gap: { phase: 3, version: PHASE3_VERSION } },
      result.ok ? 202 : 503,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/export/download") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const jobId = url.searchParams.get("job_id");
    if (!jobId) return json({ ok: false, error: "job_id_required" }, 400, request, env);
    const file = await downloadExport(env, auth.tenant, jobId);
    if (!file.ok) return json(file, 404, request, env);
    return new Response(file.body, {
      status: 200,
      headers: {
        ...corsHeaders(request, env),
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="aston-export-${jobId}.jsonl"`
      }
    });
  }

  if (method === "DELETE" && path === "/v1/tenant/data") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);

    let body = {};
    try {
      if (Number(request.headers.get("content-length") || 0) > 0) {
        body = await request.json();
      }
    } catch {
      body = {};
    }

    const confirm = body.confirm === auth.tenant || url.searchParams.get("confirm") === auth.tenant;
    if (!confirm) {
      return json(
        {
          ok: false,
          error: "confirm_required",
          hint: `Send JSON { "confirm": "${auth.tenant}" } or ?confirm=${auth.tenant}`
        },
        400,
        request,
        env
      );
    }

    const result = await purgeTenant(env, auth.tenant, {
      purge_r2: body.purge_r2 !== false,
      allow_default: body.allow_default === true
    });
    return json(
      { ...result, anti_gap: { phase: 3, version: PHASE3_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase3(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 3);
  result.anti_gap.version = PHASE3_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "tenant_export",
    "tenant_purge",
    "sla_metrics",
    "sla_cron_rollup"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p3_enabled = env.ANTI_GAP_P3 !== "false";
  return result;
}

export async function runPhase3Cron(env) {
  try {
    return await rollupSlaCron(env);
  } catch (e) {
    console.error("[p3-cron]", e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
