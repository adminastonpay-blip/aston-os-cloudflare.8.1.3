// ASTON OS — Phase B Multi-Agent Orchestrator
// Plan → specialist agents → synthesize (Palantir-style operational workflow on the edge)

import { ontologyToolSearch, ontologyToolTraverse } from "./ontology.js";

const ROLES = {
  analyst: {
    id: "analyst",
    system: "You are ASTON Analyst. Summarize data, trends, and anomalies. Be precise and cite tool facts. Reply in the user's language."
  },
  compliance: {
    id: "compliance",
    system: "You are ASTON Compliance. Assess risk, policy gaps, and audit flags. Flag blockers clearly. Reply in the user's language."
  },
  supplier: {
    id: "supplier",
    system: "You are ASTON Supplier Intel. Evaluate suppliers, scores, countries, and supply risk. Reply in the user's language."
  },
  growth: {
    id: "growth",
    system: "You are ASTON Growth. Recommend commercial / product actions with measurable impact. Reply in the user's language."
  },
  synthesizer: {
    id: "synthesizer",
    system: "You are ASTON Orchestrator synthesizer. Merge specialist findings into one executive answer with: summary, findings, risks, recommended actions. Reply in the user's language."
  }
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "9.3.0", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export async function ensureOrchestratorSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS orchestrator_runs (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      plan TEXT,
      result TEXT,
      error TEXT,
      actor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_orch_runs_tenant ON orchestrator_runs (tenant, created_at)")
  ]);
}

function pickRoles(goal, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map((r) => String(r).toLowerCase()).filter((r) => ROLES[r] && r !== "synthesizer").slice(0, 4);
  }
  const g = String(goal || "").toLowerCase();
  const roles = ["analyst"];
  if (/\b(compliance|cumplim|audit|riesgo|risk|policy|legal|gdpr|sox)\b/.test(g)) roles.push("compliance");
  if (/\b(supplier|proveedor|vendor|cadena|supply)\b/.test(g)) roles.push("supplier");
  if (/\b(growth|crecimiento|venta|revenue|marketing|conversion|shopify)\b/.test(g)) roles.push("growth");
  if (roles.length === 1) roles.push("growth");
  return [...new Set(roles)].slice(0, 4);
}

async function gatherContext(env, tenant, goal) {
  const ctx = { ontology: null, records_hint: null, stats: null };
  try {
    ctx.ontology = await ontologyToolSearch(env, tenant, goal.slice(0, 120), 8);
  } catch (e) {
    ctx.ontology = { error: String(e?.message || e).slice(0, 200) };
  }
  if (env.ASTON_DB) {
    try {
      const records = await env.ASTON_DB.prepare(
        "SELECT id, sector, text, created_at FROM records WHERE tenant = ? AND text LIKE ? ORDER BY created_at DESC LIMIT 8"
      ).bind(tenant, `%${goal.slice(0, 80)}%`).all();
      ctx.records_hint = records.results || [];
      const count = await env.ASTON_DB.prepare(
        "SELECT COUNT(*) AS c FROM records WHERE tenant = ?"
      ).bind(tenant).first();
      ctx.stats = { records: count?.c || 0 };
    } catch (e) {
      ctx.records_hint = { error: String(e?.message || e).slice(0, 200) };
    }
  }
  return ctx;
}

async function runSpecialist(env, roleId, goal, sharedContext, priorNotes) {
  const role = ROLES[roleId] || ROLES.analyst;
  if (!env.AI) return { role: roleId, error: "ai_unavailable" };
  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const messages = [
    { role: "system", content: role.system },
    {
      role: "user",
      content: `Goal: ${goal}\n\nShared context (JSON):\n${JSON.stringify(sharedContext).slice(0, 3500)}\n\nPrior specialist notes:\n${priorNotes.slice(0, 2000) || "(none)"}\n\nRespond with concise findings for your role only.`
    }
  ];
  const t0 = Date.now();
  try {
    const response = await env.AI.run(model, { messages });
    const text = typeof response === "string" ? response : (response?.response || JSON.stringify(response));
    return { role: roleId, ok: true, ms: Date.now() - t0, text: String(text).slice(0, 4000) };
  } catch (e) {
    return { role: roleId, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) };
  }
}

async function synthesize(env, goal, steps) {
  if (!env.AI) {
    return steps.map((s) => `[${s.role}] ${s.text || s.error || ""}`).join("\n\n").slice(0, 6000);
  }
  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const notes = steps.map((s) => `### ${s.role}\n${s.text || s.error || ""}`).join("\n\n");
  const messages = [
    { role: "system", content: ROLES.synthesizer.system },
    { role: "user", content: `Goal: ${goal}\n\nSpecialist reports:\n${notes.slice(0, 8000)}` }
  ];
  try {
    const response = await env.AI.run(model, { messages });
    return typeof response === "string" ? response : (response?.response || JSON.stringify(response));
  } catch (e) {
    return notes.slice(0, 6000);
  }
}

async function persistRun(env, row) {
  if (!env.ASTON_DB) return;
  try {
    await ensureOrchestratorSchema(env.ASTON_DB);
    await env.ASTON_DB.prepare(
      `INSERT INTO orchestrator_runs (id, tenant, goal, status, plan, result, error, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, plan=excluded.plan, result=excluded.result,
         error=excluded.error, updated_at=excluded.updated_at`
    ).bind(
      row.id, row.tenant, row.goal, row.status,
      JSON.stringify(row.plan || {}).slice(0, 8000),
      row.result ? String(row.result).slice(0, 12000) : null,
      row.error ? String(row.error).slice(0, 1000) : null,
      row.actor || "api",
      row.created_at, row.updated_at
    ).run();
  } catch (e) {
    console.error("orchestrator persist failed", e?.message || e);
  }
}

async function maybeStoreArtifact(env, tenant, runId, result) {
  if (!env.ASTON_R2 || !result) return null;
  try {
    const key = `orchestrator/${tenant}/${runId}.md`;
    await env.ASTON_R2.put(key, String(result), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { tenant, run_id: runId, phase: "B" }
    });
    return key;
  } catch (e) {
    console.error("orchestrator r2 failed", e?.message || e);
    return null;
  }
}

/** HTTP handler /v1/orchestrator/* */
export async function handleOrchestrator(request, env, auth, cors = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;

  try {
    if (method === "GET" && path === "/v1/orchestrator/roles") {
      return json({
        ok: true,
        phase: "B",
        roles: Object.keys(ROLES).filter((r) => r !== "synthesizer"),
        synthesizer: true
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/orchestrator/runs") {
      if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
      await ensureOrchestratorSchema(env.ASTON_DB);
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 10)));
      const rows = await env.ASTON_DB.prepare(
        "SELECT id, goal, status, actor, created_at, updated_at FROM orchestrator_runs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenant, limit).all();
      return json({ ok: true, tenant, runs: rows.results || [] }, 200, cors);
    }

    if (method === "GET" && path.startsWith("/v1/orchestrator/runs/")) {
      if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
      await ensureOrchestratorSchema(env.ASTON_DB);
      const id = path.split("/").pop();
      const row = await env.ASTON_DB.prepare(
        "SELECT * FROM orchestrator_runs WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      return json({ ok: true, run: row }, 200, cors);
    }

    if (method === "POST" && (path === "/v1/orchestrator/run" || path === "/v1/orchestrator/plans")) {
      if (!env.AI) return json({ ok: false, error: "ai_unavailable" }, 503, cors);
      const body = await readJson(request);
      const goal = String(body?.goal || body?.prompt || "").trim();
      if (!goal) return json({ ok: false, error: "goal_required" }, 400, cors);

      // Prefer DO when bound (shared memory + sequential control)
      if (env.ASTON_ORCHESTRATOR) {
        const stub = env.ASTON_ORCHESTRATOR.get(
          env.ASTON_ORCHESTRATOR.idFromName(`orch:${tenant}`)
        );
        return stub.fetch(new Request("https://orchestrator.internal/run", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-aston-tenant": tenant,
            "x-aston-actor": auth.actor || "api"
          },
          body: JSON.stringify({
            goal,
            roles: body?.roles || null,
            max_roles: Math.min(4, Number(body?.max_roles) || 3),
            store_artifact: body?.store_artifact !== false
          })
        }));
      }

      // Inline fallback without DO
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      const roles = pickRoles(goal, body?.roles).slice(0, Math.min(4, Number(body?.max_roles) || 3));
      const plan = { roles, steps: ["gather_context", ...roles.map((r) => `run:${r}`), "synthesize"] };
      await persistRun(env, {
        id: runId, tenant, goal, status: "running", plan, result: null, error: null,
        actor: auth.actor, created_at: now, updated_at: now
      });

      const t0 = Date.now();
      const shared = await gatherContext(env, tenant, goal);
      const stepResults = [];
      let prior = "";
      for (const role of roles) {
        const out = await runSpecialist(env, role, goal, shared, prior);
        stepResults.push(out);
        if (out.text) prior += `\n[${role}] ${out.text.slice(0, 800)}`;
      }
      const finalText = await synthesize(env, goal, stepResults);
      const artifact = body?.store_artifact !== false
        ? await maybeStoreArtifact(env, tenant, runId, finalText)
        : null;
      const updated = new Date().toISOString();
      await persistRun(env, {
        id: runId, tenant, goal, status: "done", plan: { ...plan, stepResults },
        result: finalText, error: null, actor: auth.actor, created_at: now, updated_at: updated
      });

      return json({
        ok: true,
        phase: "B",
        run_id: runId,
        roles,
        steps: stepResults,
        result: finalText,
        artifact_key: artifact,
        total_ms: Date.now() - t0
      }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("orchestrator handler", e?.message || e);
    return json({ ok: false, error: "orchestrator_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

/** Durable Object — per-tenant orchestrator memory + run control */
export class AstonOrchestrator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const tenant = request.headers.get("x-aston-tenant") || "default";
    const actor = request.headers.get("x-aston-actor") || "api";

    if (request.method === "GET" && url.pathname.endsWith("/memory")) {
      return json({
        ok: true,
        tenant,
        memory: (await this.ctx.storage.get("memory")) || [],
        last_run: (await this.ctx.storage.get("last_run")) || null
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/run")) {
      const body = await readJson(request);
      const goal = String(body?.goal || "").trim();
      if (!goal) return json({ ok: false, error: "goal_required" }, 400);
      if (!this.env.AI) return json({ ok: false, error: "ai_unavailable" }, 503);

      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      const roles = pickRoles(goal, body?.roles).slice(0, Math.min(4, Number(body?.max_roles) || 3));
      const plan = { roles, steps: ["gather_context", ...roles.map((r) => `run:${r}`), "synthesize"] };
      const t0 = Date.now();

      await persistRun(this.env, {
        id: runId, tenant, goal, status: "running", plan, result: null, error: null,
        actor, created_at: now, updated_at: now
      });

      try {
        const shared = await gatherContext(this.env, tenant, goal);
        const stepResults = [];
        let prior = "";
        for (const role of roles) {
          const out = await runSpecialist(this.env, role, goal, shared, prior);
          stepResults.push(out);
          if (out.text) prior += `\n[${role}] ${out.text.slice(0, 800)}`;
        }
        const finalText = await synthesize(this.env, goal, stepResults);
        const artifact = body?.store_artifact !== false
          ? await maybeStoreArtifact(this.env, tenant, runId, finalText)
          : null;

        const memory = (await this.ctx.storage.get("memory")) || [];
        memory.push({ ts: now, run_id: runId, goal: goal.slice(0, 300), roles });
        await this.ctx.storage.put("memory", memory.slice(-20));
        await this.ctx.storage.put("last_run", {
          run_id: runId, goal: goal.slice(0, 300), roles, ms: Date.now() - t0, at: new Date().toISOString()
        });

        await persistRun(this.env, {
          id: runId, tenant, goal, status: "done",
          plan: { ...plan, stepResults }, result: finalText, error: null,
          actor, created_at: now, updated_at: new Date().toISOString()
        });

        return json({
          ok: true,
          phase: "B",
          run_id: runId,
          roles,
          steps: stepResults,
          result: finalText,
          artifact_key: artifact,
          total_ms: Date.now() - t0
        });
      } catch (e) {
        await persistRun(this.env, {
          id: runId, tenant, goal, status: "failed", plan, result: null,
          error: String(e?.message || e).slice(0, 500),
          actor, created_at: now, updated_at: new Date().toISOString()
        });
        return json({ ok: false, error: "run_failed", detail: String(e?.message || e).slice(0, 300) }, 500);
      }
    }

    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}
