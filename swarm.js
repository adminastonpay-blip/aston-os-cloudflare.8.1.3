// ASTON OS 11 — Multi-Agent Swarm Intelligence
// Parallel edge agents: detect → negotiate → twin → receipt

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

function slugId(p) {
  return `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const AGENTS = {
  detector: {
    id: "detector",
    role: "Detect bottlenecks, anomalies, incomplete data",
    run: async (ctx) => {
      const signals = [];
      const payload = ctx.payload || {};
      const text = JSON.stringify(payload).toLowerCase();
      if (payload.delay_days > 3 || /delay|bottleneck|atraso/.test(text))
        signals.push({ type: "logistics_bottleneck", severity: "high", detail: payload });
      if (payload.amount > 10000 || payload.risk > 7)
        signals.push({ type: "risk_spike", severity: "medium", detail: { amount: payload.amount, risk: payload.risk } });
      if (payload.incomplete || !payload.id)
        signals.push({ type: "data_incomplete", severity: "low", detail: payload });
      if (!signals.length) signals.push({ type: "ok", severity: "info", detail: "no_anomaly" });
      return { agent: "detector", signals, ms: 0 };
    }
  },
  negotiator: {
    id: "negotiator",
    role: "Propose alternate suppliers / actions via policy",
    run: async (ctx) => {
      const signals = (ctx.prior?.detector?.signals || []).filter((s) => s.type !== "ok");
      const proposals = [];
      for (const s of signals) {
        if (s.type === "logistics_bottleneck")
          proposals.push({ action: "reassign_supplier", from: s.detail?.supplier || "A", to: s.detail?.alt_supplier || "B", reason: "bottleneck_mitigation" });
        if (s.type === "risk_spike")
          proposals.push({ action: "require_secondary_approval", threshold: s.detail?.amount, reason: "risk_policy" });
        if (s.type === "data_incomplete")
          proposals.push({ action: "enrich_and_heal", fields: Object.keys(s.detail || {}), reason: "self_heal" });
      }
      return { agent: "negotiator", proposals, ms: 0 };
    }
  },
  twin: {
    id: "twin",
    role: "Shadow impact on Decision Twin metrics",
    run: async (ctx) => {
      const proposals = ctx.prior?.negotiator?.proposals || [];
      const baseRisk = Number(ctx.payload?.risk || 5);
      const baseCost = Number(ctx.payload?.cost || ctx.payload?.amount || 1000);
      const impacts = proposals.map((p) => {
        let riskDelta = 0, costDelta = 0;
        if (p.action === "reassign_supplier") { riskDelta = -1.5; costDelta = baseCost * 0.02; }
        if (p.action === "require_secondary_approval") { riskDelta = -2; }
        if (p.action === "enrich_and_heal") { riskDelta = -0.5; }
        return { proposal: p.action, projected_risk: Math.max(0, baseRisk + riskDelta), projected_cost: baseCost + costDelta, risk_delta: riskDelta, cost_delta: costDelta };
      });
      const best = impacts.slice().sort((a, b) => a.projected_risk - b.projected_risk)[0] || null;
      return { agent: "twin", impacts, best, ms: 0 };
    }
  },
  notary: {
    id: "notary",
    role: "Emit cryptographic swarm receipt",
    run: async (ctx, env) => {
      const body = {
        swarm_id: ctx.swarm_id, tenant: ctx.tenant,
        signals: ctx.prior?.detector?.signals || [],
        proposals: ctx.prior?.negotiator?.proposals || [],
        best: ctx.prior?.twin?.best || null,
        at: new Date().toISOString()
      };
      const payload = JSON.stringify(body);
      const secret = env.ASTON_RECEIPT_SECRET || env.ASTON_API_TOKEN || "aston-swarm";
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
      const signature = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { agent: "notary", receipt_id: slugId("swrcpt"), signature: signature.slice(0, 32) + "…", signature_full: signature, payload_hash: signature.slice(0, 16), ms: 0 };
    }
  }
};

export async function runSwarm(env, { tenant, payload, goal }) {
  const swarm_id = slugId("swarm");
  const t0 = Date.now();
  const ctx = { swarm_id, tenant, payload: payload || {}, goal: goal || "auto" };
  const t1 = Date.now();
  const detector = await AGENTS.detector.run(ctx);
  detector.ms = Date.now() - t1;
  ctx.prior = { detector };
  const t2 = Date.now();
  const [negotiator, twin] = await Promise.all([AGENTS.negotiator.run(ctx), AGENTS.twin.run(ctx)]);
  negotiator.ms = Date.now() - t2;
  twin.ms = Date.now() - t2;
  ctx.prior.negotiator = negotiator;
  ctx.prior.twin = twin;
  const t3 = Date.now();
  const notary = await AGENTS.notary.run(ctx, env);
  notary.ms = Date.now() - t3;
  return {
    ok: true, swarm_id, total_ms: Date.now() - t0, parallel: true,
    agents: { detector, negotiator, twin, notary },
    decision: twin.best, receipt_id: notary.receipt_id
  };
}

async function simpleAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  return { tenant: request.headers.get("X-Tenant") || "default", actor: request.headers.get("X-Aston-Actor") || "api", ok: true };
}

export async function handleSwarm(request, env, path, method, cors = {}) {
  if (method === "GET" && path === "/v1/swarm/status") {
    return json({
      ok: true, phase: "11-swarm", version: VERSION, agents: Object.keys(AGENTS),
      endpoints: { status: "GET /v1/swarm/status", run: "POST /v1/swarm/run", agents: "GET /v1/swarm/agents" }
    }, 200, cors);
  }
  if (method === "GET" && path === "/v1/swarm/agents") {
    return json({ ok: true, agents: Object.values(AGENTS).map((a) => ({ id: a.id, role: a.role })) }, 200, cors);
  }
  const auth = await simpleAuth(request, env);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  if (method === "POST" && path === "/v1/swarm/run") {
    const body = await readJson(request);
    const result = await runSwarm(env, { tenant: auth.tenant, payload: body?.payload || body || {}, goal: body?.goal });
    return json(result, 200, cors);
  }
  return json({ ok: false, error: "not_found", path }, 404, cors);
}
