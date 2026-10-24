// ASTON OS — Phase I Edge Metrics
// Latency samples, percentiles, and internal benchmark for Blue Ocean claims

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "10.2.0", ...headers }
  });

export async function ensureMetricsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS latency_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL,
      route TEXT NOT NULL,
      ms REAL NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1,
      colo TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lat_tenant_route ON latency_samples (tenant, route, created_at)")
  ]);
}

export async function recordLatency(env, { tenant, route, ms, ok = true, colo = null }) {
  if (!env.ASTON_DB || ms == null || Number.isNaN(ms)) return;
  try {
    await ensureMetricsSchema(env.ASTON_DB);
    await env.ASTON_DB.prepare(
      "INSERT INTO latency_samples (tenant, route, ms, ok, colo, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      tenant || "default",
      String(route || "unknown").slice(0, 120),
      Math.round(Number(ms) * 100) / 100,
      ok ? 1 : 0,
      colo ? String(colo).slice(0, 16) : null,
      new Date().toISOString()
    ).run();
  } catch (e) {
    console.error("recordLatency", e?.message || e);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function statsFor(db, tenant, route, limit = 500) {
  let rows;
  if (route) {
    rows = await db.prepare(
      "SELECT ms, ok FROM latency_samples WHERE tenant = ? AND route = ? ORDER BY id DESC LIMIT ?"
    ).bind(tenant, route, limit).all();
  } else {
    rows = await db.prepare(
      "SELECT ms, ok, route FROM latency_samples WHERE tenant = ? ORDER BY id DESC LIMIT ?"
    ).bind(tenant, limit).all();
  }
  const samples = (rows.results || []).map((r) => Number(r.ms)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const okCount = (rows.results || []).filter((r) => r.ok).length;
  const n = samples.length;
  if (!n) {
    return { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, min_ms: null, max_ms: null, ok_rate: null };
  }
  return {
    count: n,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    min_ms: samples[0],
    max_ms: samples[n - 1],
    mean_ms: Math.round((samples.reduce((a, b) => a + b, 0) / n) * 100) / 100,
    ok_rate: Math.round((okCount / (rows.results || []).length) * 1000) / 1000
  };
}

async function runBench(env, tenant) {
  const steps = [];
  const total0 = Date.now();

  // 1) Worker CPU / crypto
  let t0 = Date.now();
  const enc = new TextEncoder();
  let h = await crypto.subtle.digest("SHA-256", enc.encode(`aston-bench-${tenant}-${Date.now()}`));
  for (let i = 0; i < 20; i++) {
    h = await crypto.subtle.digest("SHA-256", new Uint8Array(h));
  }
  steps.push({ name: "crypto_sha256_x21", ms: Date.now() - t0 });

  // 2) D1 round-trip
  if (env.ASTON_DB) {
    t0 = Date.now();
    try {
      await env.ASTON_DB.prepare("SELECT 1 AS ok").first();
      steps.push({ name: "d1_select_1", ms: Date.now() - t0, ok: true });
    } catch (e) {
      steps.push({ name: "d1_select_1", ms: Date.now() - t0, ok: false, error: String(e?.message || e).slice(0, 120) });
    }

    t0 = Date.now();
    try {
      await env.ASTON_DB.prepare(
        "SELECT COUNT(*) AS c FROM ontology_entities WHERE tenant = ?"
      ).bind(tenant).first();
      steps.push({ name: "d1_ontology_count", ms: Date.now() - t0, ok: true });
    } catch (e) {
      steps.push({ name: "d1_ontology_count", ms: Date.now() - t0, ok: false, error: String(e?.message || e).slice(0, 120) });
    }
  } else {
    steps.push({ name: "d1_select_1", ms: null, ok: false, error: "d1_unavailable" });
  }

  // 3) JSON serialize (simulates response build)
  t0 = Date.now();
  const payload = JSON.stringify({ tenant, steps, ts: new Date().toISOString(), pad: "x".repeat(2000) });
  steps.push({ name: "json_serialize_2kb", ms: Date.now() - t0, bytes: payload.length });

  const total_ms = Date.now() - total0;
  const edge_paths = steps.filter((s) => s.ms != null && s.name !== "d1_ontology_count");
  const edge_sum = edge_paths.reduce((a, s) => a + (s.ms || 0), 0);

  return {
    total_ms,
    edge_core_ms: edge_sum,
    sub_100ms_edge_core: edge_sum < 100,
    steps,
    note: "edge_core excludes heavy AI; AI/orchestrator is multi-second by design"
  };
}

export async function handleMetrics(request, env, auth, cors = {}, cf = null) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;

  try {
    if (env.ASTON_DB) await ensureMetricsSchema(env.ASTON_DB);

    if (method === "GET" && (path === "/v1/metrics" || path === "/v1/metrics/status")) {
      return json({
        ok: true,
        phase: "I",
        version: "10.2.0",
        modules: ["latency_samples", "summary", "bench"],
        colo: cf?.colo || null
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/metrics/summary") {
      if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
      const route = url.searchParams.get("route");
      const overall = await statsFor(env.ASTON_DB, tenant, null, 1000);
      const byRoute = {};
      const routes = await env.ASTON_DB.prepare(
        "SELECT DISTINCT route FROM latency_samples WHERE tenant = ? ORDER BY route LIMIT 40"
      ).bind(tenant).all();
      for (const r of routes.results || []) {
        byRoute[r.route] = await statsFor(env.ASTON_DB, tenant, r.route, 300);
      }
      if (route) {
        return json({ ok: true, tenant, route, stats: await statsFor(env.ASTON_DB, tenant, route, 500) }, 200, cors);
      }
      return json({ ok: true, tenant, overall, by_route: byRoute }, 200, cors);
    }

    if (method === "POST" && path === "/v1/metrics/bench") {
      const result = await runBench(env, tenant);
      await recordLatency(env, {
        tenant,
        route: "bench.edge_core",
        ms: result.edge_core_ms,
        ok: true,
        colo: cf?.colo || null
      });
      await recordLatency(env, {
        tenant,
        route: "bench.total",
        ms: result.total_ms,
        ok: true,
        colo: cf?.colo || null
      });
      return json({ ok: true, phase: "I", colo: cf?.colo || null, benchmark: result }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("metrics handler", e?.message || e);
    return json({ ok: false, error: "metrics_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

/** Wrap a Response with timing header and optional D1 sample */
export async function withTiming(env, meta, fn) {
  const t0 = Date.now();
  let res;
  let ok = true;
  try {
    res = await fn();
    ok = res.status < 500;
    return res;
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    const ms = Date.now() - t0;
    try {
      if (res && typeof res.headers?.set === "function") {
        // immutable responses — clone with header when possible
      }
    } catch (_) {}
    const colo = meta.colo || null;
    // fire-and-forget style (await to keep order in DO-less worker)
    await recordLatency(env, {
      tenant: meta.tenant || "default",
      route: meta.route || "unknown",
      ms,
      ok,
      colo
    });
  }
}

export function timingHeaders(ms, extra = {}) {
  return {
    "x-aston-ms": String(ms),
    "server-timing": `app;dur=${ms}`,
    ...extra
  };
}
