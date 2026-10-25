// ASTON OS 11 — Zero-Latency Predictive Stream Synthesis
// Synthesize & project metrics at webhook edge (no batch lake query)

const VERSION = "11.0.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

async function loadState(env, tenant, stream) {
  const key = `pred:${tenant}:${stream}`;
  if (env.ASTON_KV) {
    try {
      const raw = await env.ASTON_KV.get(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
  }
  return { ewma: null, count: 0, last: null, history: [] };
}

async function saveState(env, tenant, stream, state) {
  if (!env.ASTON_KV) return;
  const key = `pred:${tenant}:${stream}`;
  try {
    await env.ASTON_KV.put(key, JSON.stringify(state), { expirationTtl: 86400 * 7 });
  } catch (_) {}
}

export function synthesizeEvent(state, event, opts = {}) {
  const alpha = opts.alpha ?? 0.3;
  const value = Number(event.value ?? event.amount ?? event.metric ?? 0);
  const ts = event.ts || new Date().toISOString();
  const ewma = state.ewma == null ? value : alpha * value + (1 - alpha) * state.ewma;
  const variance =
    state.ewma == null ? 0 : alpha * Math.pow(value - state.ewma, 2) + (1 - alpha) * (state.variance || 0);
  const std = Math.sqrt(Math.max(variance, 0));
  const z = std > 1e-9 ? (value - ewma) / std : 0;
  const anomaly = Math.abs(z) > (opts.z_threshold ?? 2.5);
  const drift = ewma - (state.ewma ?? ewma);
  const horizon = [1, 2, 3].map((h) => ({
    step: h,
    projected: Math.round((ewma + drift * h) * 1000) / 1000
  }));
  const history = [...(state.history || []).slice(-19), { ts, value, ewma, z }];
  const next = { ewma, variance, count: (state.count || 0) + 1, last: { ts, value }, history };
  return {
    state: next,
    synthesis: {
      value,
      ewma: Math.round(ewma * 1000) / 1000,
      z_score: Math.round(z * 1000) / 1000,
      anomaly,
      projected: horizon,
      trend: drift > 0.01 ? "up" : drift < -0.01 ? "down" : "flat",
      n: next.count
    }
  };
}

export async function handlePredictive(request, env, path, method, cors = {}) {
  if (method === "GET" && path === "/v1/predictive/status") {
    return json({
      ok: true, phase: "11-predictive", version: VERSION,
      endpoints: {
        status: "GET /v1/predictive/status",
        ingest: "POST /v1/predictive/ingest",
        stream: "GET /v1/predictive/stream/:name"
      }
    }, 200, cors);
  }

  const token = bearer(request);
  if (!token) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const tenant = request.headers.get("X-Tenant") || "default";

  if (method === "POST" && path === "/v1/predictive/ingest") {
    const t0 = Date.now();
    const body = await readJson(request);
    const stream = String(body?.stream || body?.name || "default").slice(0, 64);
    const events = Array.isArray(body?.events) ? body.events : [body?.event || body || {}];
    let state = await loadState(env, tenant, stream);
    const results = [];
    for (const ev of events.slice(0, 50)) {
      const out = synthesizeEvent(state, ev, { alpha: body?.alpha, z_threshold: body?.z_threshold });
      state = out.state;
      results.push(out.synthesis);
    }
    await saveState(env, tenant, stream, state);
    return json({
      ok: true, stream, latency_ms: Date.now() - t0, events: results.length,
      latest: results[results.length - 1] || null, series: results
    }, 200, cors);
  }

  const streamMatch = path.match(/^\/v1\/predictive\/stream\/([^/]+)$/);
  if (method === "GET" && streamMatch) {
    const stream = decodeURIComponent(streamMatch[1]);
    const state = await loadState(env, tenant, stream);
    return json({
      ok: true, stream, ewma: state.ewma, count: state.count, last: state.last, history: state.history || []
    }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
