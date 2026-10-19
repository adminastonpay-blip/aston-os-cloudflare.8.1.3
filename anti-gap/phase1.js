/**
 * ASTON OS Anti-Gap Phase 1 — route handlers (additive)
 * Returns Response if path handled, otherwise null so the main router continues.
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
  const { json, authorized, cors } = helpers;

  if (method === "GET" && path === "/v1/roi/summary") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const data = await summarizeRoi(env, auth.tenant, days);
    return json(data, data.ok ? 200 : 503, cors);
  }

  if (method === "GET" && path === "/v1/roi/by-route") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const data = await summarizeRoi(env, auth.tenant, days);
    if (!data.ok) return json(data, 503, cors);
    return json({ ok: true, tenant: data.tenant, days, by_route: data.by_route }, 200, cors);
  }

  if (method === "GET" && path === "/v1/roi/budget") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const budget = await checkBudget(env, auth.tenant);
    return json({ ok: true, tenant: auth.tenant, budget }, 200, cors);
  }

  if (method === "POST" && path === "/v1/roi/event") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, cors);
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
    return json({ ok, tenant: auth.tenant }, ok ? 202 : 503, cors);
  }

  if (method === "POST" && path === "/v1/roi/init") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    try {
      if (env.ASTON_DB) await ensureRoiSchema(env.ASTON_DB);
      if (env.ASTON_DB_BACKUP) await ensureRoiSchema(env.ASTON_DB_BACKUP);
      return json({ ok: true, tenant: auth.tenant, initialized: true }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 300) }, 500, cors);
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
