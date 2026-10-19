/**
 * Anti-Gap Phase 3 — SLA metrics from roi_events + KV rollups
 */

import { ensureRoiSchema as ensureRoi, withDbFailover as failover } from "./roi.js";

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function computeSla(env, tenantId, hours = 24) {
  const tenant = tenantId ? String(tenantId).slice(0, 120) : null;
  const since = new Date(Date.now() - Math.max(1, hours) * 3600000).toISOString();

  const res = await failover(env, async (db) => {
    await ensureRoi(db);
    let sql = `SELECT latency_ms, outcome, route, created_at FROM roi_events WHERE created_at >= ?`;
    const binds = [since];
    if (tenant) {
      sql += ` AND tenant_id = ?`;
      binds.push(tenant);
    }
    sql += ` ORDER BY created_at DESC LIMIT 5000`;
    const rows = await db.prepare(sql).bind(...binds).all();
    return rows?.results || [];
  });

  if (!res.ok) {
    return { ok: false, error: "sla_unavailable", detail: res.errors };
  }

  const rows = res.result;
  const latencies = rows
    .map((r) => Number(r.latency_ms))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const total = rows.length;
  const errors = rows.filter((r) => /error|fail/i.test(String(r.outcome || ""))).length;
  const cacheHits = rows.filter((r) => r.outcome === "cache_hit").length;
  const okCount = rows.filter((r) =>
    r.outcome === "ok" || r.outcome === "ok_soft_budget" || r.outcome === "cache_hit"
  ).length;

  const byRoute = {};
  for (const r of rows) {
    const route = r.route || "unknown";
    if (!byRoute[route]) byRoute[route] = { count: 0, errors: 0, latencies: [] };
    byRoute[route].count++;
    if (/error|fail/i.test(String(r.outcome || ""))) byRoute[route].errors++;
    const lat = Number(r.latency_ms);
    if (Number.isFinite(lat)) byRoute[route].latencies.push(lat);
  }

  const routeStats = Object.entries(byRoute).map(([route, v]) => {
    const sorted = v.latencies.sort((a, b) => a - b);
    return {
      route,
      count: v.count,
      errors: v.errors,
      error_rate: v.count ? +(v.errors / v.count).toFixed(4) : 0,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95)
    };
  });

  if (env.ASTON_KV && tenant) {
    try {
      const snap = {
        tenant,
        hours,
        total,
        at: new Date().toISOString(),
        p50_ms: percentile(latencies, 50),
        p95_ms: percentile(latencies, 95),
        error_rate: total ? errors / total : 0
      };
      await env.ASTON_KV.put(`aston:sla:snap:${tenant}`, JSON.stringify(snap), {
        expirationTtl: 60 * 60 * 6
      });
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    tenant: tenant || "all",
    window_hours: hours,
    db: res.name,
    sample_size: total,
    summary: {
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
      error_rate: total ? +(errors / total).toFixed(4) : 0,
      success_rate: total ? +(okCount / total).toFixed(4) : 0,
      cache_hit_rate: total ? +(cacheHits / total).toFixed(4) : 0,
      errors,
      cache_hits
    },
    by_route: routeStats.sort((a, b) => b.count - a.count).slice(0, 30),
    note: "Derived from roi_events; enable ROI metering (P1) for meaningful SLA"
  };
}

export async function rollupSlaCron(env) {
  if (!env.ASTON_KV) return { ok: false, reason: "no_kv" };
  const sla = await computeSla(env, null, 1);
  if (!sla.ok) return sla;
  await env.ASTON_KV.put(
    "aston:sla:global:1h",
    JSON.stringify({ ...sla.summary, at: new Date().toISOString(), sample_size: sla.sample_size }),
    { expirationTtl: 60 * 60 * 24 }
  );
  return { ok: true, sample_size: sla.sample_size };
}
