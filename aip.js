// ASTON OS — Phase 2 AIP-lite (Palantir AIP style) + Phase 9.1 auto-emit
// Plan → Human-in-the-Loop approve → Execute agents → Truth Receipt

import { handleOrchestrator } from "./orchestrator.js";
import { issueTruthReceipt } from "./receipts.js";
import { emitChangeEvent } from "./events_feed.js";

const VERSION = "12.2.1";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export async function ensureAipSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS aip_plans (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      roles TEXT,
      plan_json TEXT,
      result TEXT,
      orchestrator_run_id TEXT,
      case_id TEXT,
      receipt_id TEXT,
      requested_by TEXT,
      decided_by TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_aip_plans_tenant ON aip_plans (tenant, status, created_at)")
  ]);
}

function pickRolesPreview(goal, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map((r) => String(r).toLowerCase()).slice(0, 4);
  }
  const g = String(goal || "").toLowerCase();
  const roles = ["analyst"];
  if (/\b(compliance|cumplim|audit|riesgo|risk|policy|legal)\b/.test(g)) roles.push("compliance");
  if (/\b(supplier|proveedor|vendor|supply)\b/.test(g)) roles.push("supplier");
  if (/\b(growth|crecimiento|venta|revenue|marketing)\b/.test(g)) roles.push("growth");
  if (roles.length === 1) roles.push("growth");
  return [...new Set(roles)].slice(0, 4);
}

export async function handleAip(request, env, auth, cors = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";

  if (method === "GET" && (path === "/v1/aip" || path === "/v1/aip/status")) {
    return json({
      ok: true,
      phase: "2-aip+9.1-auto-emit",
      version: VERSION,
      auto_emit: true,
      flow: ["POST /v1/aip/plan", "POST /v1/aip/plans/:id/approve|reject", "POST /v1/aip/plans/:id/execute"],
      also: {
        orchestrator: "POST /v1/orchestrator/run",
        cases: "POST /v1/cases",
        receipts: "GET /v1/receipts/list",
        swarm: "POST /v1/swarm/run"
      },
      note: "HITL: high-impact goals should use plan → approve → execute; events: aip.plan.*"
    }, 200, cors);
  }

  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureAipSchema(env.ASTON_DB);
  const db = env.ASTON_DB;

  // List plans
  if (method === "GET" && path === "/v1/aip/plans") {
    const status = url.searchParams.get("status") || null;
    const limit = Math.min(40, Math.max(1, Number(url.searchParams.get("limit") || 15)));
    let rows;
    if (status) {
      rows = await db.prepare(
        "SELECT id, goal, status, roles, orchestrator_run_id, case_id, receipt_id, requested_by, decided_by, created_at, updated_at FROM aip_plans WHERE tenant = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenant, status, limit).all();
    } else {
      rows = await db.prepare(
        "SELECT id, goal, status, roles, orchestrator_run_id, case_id, receipt_id, requested_by, decided_by, created_at, updated_at FROM aip_plans WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenant, limit).all();
    }
    return json({ ok: true, tenant, plans: rows.results || [] }, 200, cors);
  }

  // Get one plan
  if (method === "GET" && /^\/v1\/aip\/plans\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    const row = await db.prepare("SELECT * FROM aip_plans WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    return json({ ok: true, plan: row }, 200, cors);
  }

  // Create plan (propose only — does NOT run agents yet)
  if (method === "POST" && path === "/v1/aip/plan") {
    const body = await readJson(request);
    const goal = String(body?.goal || body?.prompt || "").trim();
    if (!goal) return json({ ok: false, error: "goal_required" }, 400, cors);
    const roles = pickRolesPreview(goal, body?.roles);
    const id = newId("aip");
    const now = new Date().toISOString();
    const planJson = {
      goal,
      roles,
      steps: ["gather_ontology_context", ...roles.map((r) => `agent:${r}`), "synthesize", "truth_receipt"],
      require_approval: body?.require_approval !== false,
      auto_execute_on_approve: body?.auto_execute_on_approve !== false,
      open_case: Boolean(body?.open_case),
      case_playbook: body?.case_playbook || null,
      max_roles: Math.min(4, Number(body?.max_roles) || 3)
    };
    await db.prepare(
      `INSERT INTO aip_plans (id, tenant, goal, status, roles, plan_json, result, orchestrator_run_id, case_id, receipt_id, requested_by, decided_by, decision_note, created_at, updated_at)
       VALUES (?, ?, ?, 'pending_approval', ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`
    ).bind(id, tenant, goal.slice(0, 2000), JSON.stringify(roles), JSON.stringify(planJson), actor, now, now).run();

    try {
      await issueTruthReceipt(env, {
        tenant,
        kind: "aip.plan.proposed",
        subject_id: id,
        actor,
        decision: "plan_pending_approval",
        summary: goal.slice(0, 300),
        input: { goal, roles },
        output: planJson
      });
    } catch (_) {}

    try {
      await emitChangeEvent(env, {
        tenant,
        event: "aip.plan.proposed",
        resource_kind: "aip_plan",
        resource_id: id,
        payload: { goal: goal.slice(0, 300), roles, status: "pending_approval" },
        actor
      });
    } catch (_) {}

    // Optional: auto-approve + execute if require_approval false
    if (body?.require_approval === false) {
      return executePlan(env, auth, cors, id, { note: "auto_approved_no_hitl" });
    }

    return json({
      ok: true,
      status: "pending_approval",
      plan_id: id,
      goal,
      roles,
      plan: planJson,
      next: {
        approve: `POST /v1/aip/plans/${id}/approve`,
        reject: `POST /v1/aip/plans/${id}/reject`,
        execute: `POST /v1/aip/plans/${id}/execute`
      }
    }, 202, cors);
  }

  // Approve
  if (method === "POST" && /^\/v1\/aip\/plans\/[^/]+\/approve$/.test(path)) {
    const id = path.split("/")[4];
    const body = await readJson(request) || {};
    const row = await db.prepare("SELECT * FROM aip_plans WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    if (row.status !== "pending_approval") {
      return json({ ok: false, error: "invalid_state", status: row.status }, 409, cors);
    }
    const now = new Date().toISOString();
    await db.prepare(
      "UPDATE aip_plans SET status = 'approved', decided_by = ?, decision_note = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(actor, body.note ? String(body.note).slice(0, 500) : null, now, tenant, id).run();

    try {
      await issueTruthReceipt(env, {
        tenant,
        kind: "aip.plan.approved",
        subject_id: id,
        actor,
        decision: "approved",
        summary: row.goal?.slice(0, 300),
        input: { plan_id: id },
        output: { decided_by: actor, note: body.note || null }
      });
    } catch (_) {}

    try {
      await emitChangeEvent(env, {
        tenant,
        event: "aip.plan.approved",
        resource_kind: "aip_plan",
        resource_id: id,
        payload: { goal: row.goal?.slice(0, 300), decided_by: actor, note: body.note || null },
        actor
      });
    } catch (_) {}

    let planMeta = {};
    try { planMeta = JSON.parse(row.plan_json || "{}"); } catch (_) {}
    if (planMeta.auto_execute_on_approve !== false && body.execute !== false) {
      return executePlan(env, auth, cors, id, { note: body.note });
    }
    return json({ ok: true, plan_id: id, status: "approved", message: "Call POST .../execute to run agents" }, 200, cors);
  }

  // Reject
  if (method === "POST" && /^\/v1\/aip\/plans\/[^/]+\/reject$/.test(path)) {
    const id = path.split("/")[4];
    const body = await readJson(request) || {};
    const row = await db.prepare("SELECT * FROM aip_plans WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    if (row.status !== "pending_approval") {
      return json({ ok: false, error: "invalid_state", status: row.status }, 409, cors);
    }
    const now = new Date().toISOString();
    await db.prepare(
      "UPDATE aip_plans SET status = 'rejected', decided_by = ?, decision_note = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(actor, body.note ? String(body.note).slice(0, 500) : "rejected", now, tenant, id).run();
    try {
      await issueTruthReceipt(env, {
        tenant,
        kind: "aip.plan.rejected",
        subject_id: id,
        actor,
        decision: "rejected",
        summary: row.goal?.slice(0, 300),
        input: { plan_id: id },
        output: { note: body.note || null }
      });
    } catch (_) {}
    try {
      await emitChangeEvent(env, {
        tenant,
        event: "aip.plan.rejected",
        resource_kind: "aip_plan",
        resource_id: id,
        payload: { goal: row.goal?.slice(0, 300), note: body.note || null },
        actor
      });
    } catch (_) {}
    return json({ ok: true, plan_id: id, status: "rejected" }, 200, cors);
  }

  // Execute approved plan
  if (method === "POST" && /^\/v1\/aip\/plans\/[^/]+\/execute$/.test(path)) {
    const id = path.split("/")[4];
    return executePlan(env, auth, cors, id, await readJson(request) || {});
  }

  // Convenience: one-shot with HITL flag
  if (method === "POST" && path === "/v1/aip/run") {
    const body = await readJson(request) || {};
    // Force through plan endpoint semantics
    const fake = new Request("https://aip.internal/v1/aip/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return handleAip(fake, env, auth, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}

async function executePlan(env, auth, cors, planId, opts = {}) {
  const tenant = auth.tenant;
  const actor = auth.actor || "api";
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureAipSchema(env.ASTON_DB);
  const db = env.ASTON_DB;
  const row = await db.prepare("SELECT * FROM aip_plans WHERE tenant = ? AND id = ?").bind(tenant, planId).first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);

  if (!["approved", "pending_approval"].includes(row.status) && row.status !== "running") {
    if (row.status === "done") {
      return json({ ok: true, plan_id: planId, status: "done", result: row.result, orchestrator_run_id: row.orchestrator_run_id }, 200, cors);
    }
    if (row.status === "rejected") {
      return json({ ok: false, error: "plan_rejected" }, 409, cors);
    }
  }

  // Only allow execute without prior approve if require_approval was false (status may still be pending)
  let planMeta = {};
  try { planMeta = JSON.parse(row.plan_json || "{}"); } catch (_) {}
  if (row.status === "pending_approval" && planMeta.require_approval !== false && opts.force !== true) {
    return json({ ok: false, error: "approval_required", plan_id: planId }, 403, cors);
  }

  const now = new Date().toISOString();
  await db.prepare("UPDATE aip_plans SET status = 'running', updated_at = ? WHERE tenant = ? AND id = ?")
    .bind(now, tenant, planId).run();

  try {
    await emitChangeEvent(env, {
      tenant,
      event: "aip.plan.executing",
      resource_kind: "aip_plan",
      resource_id: planId,
      payload: { goal: row.goal?.slice(0, 300), status: "running" },
      actor
    });
  } catch (_) {}

  let roles = [];
  try { roles = JSON.parse(row.roles || "[]"); } catch (_) {}

  // Run orchestrator
  const orchReq = new Request("https://aip.internal/v1/orchestrator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: row.goal,
      roles: roles.length ? roles : undefined,
      max_roles: planMeta.max_roles || 3,
      store_artifact: true
    })
  });
  const orchRes = await handleOrchestrator(orchReq, env, auth, {});
  const orchData = await orchRes.json().catch(() => null);

  if (!orchData?.ok) {
    await db.prepare(
      "UPDATE aip_plans SET status = 'failed', result = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(JSON.stringify(orchData).slice(0, 4000), new Date().toISOString(), tenant, planId).run();
    try {
      await emitChangeEvent(env, {
        tenant,
        event: "aip.plan.failed",
        resource_kind: "aip_plan",
        resource_id: planId,
        payload: { error: "orchestrator_failed" },
        actor
      });
    } catch (_) {}
    return json({ ok: false, error: "orchestrator_failed", detail: orchData }, 500, cors);
  }

  let caseId = null;
  if (planMeta.open_case) {
    try {
      const { handleCases } = await import("./cases.js");
      const caseReq = new Request("https://aip.internal/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `AIP: ${String(row.goal).slice(0, 120)}`,
          playbook: planMeta.case_playbook || null,
          priority: "high",
          run_orchestrator: false,
          payload: { aip_plan_id: planId, orchestrator_run_id: orchData.run_id }
        })
      });
      const caseRes = await handleCases(caseReq, env, auth, {});
      const caseData = await caseRes.json().catch(() => null);
      caseId = caseData?.case?.id || null;
    } catch (e) {
      console.error("aip open_case", e?.message || e);
    }
  }

  const receiptId = orchData.truth_receipt?.id || null;
  await db.prepare(
    `UPDATE aip_plans SET status = 'done', result = ?, orchestrator_run_id = ?, case_id = ?, receipt_id = ?, updated_at = ?
     WHERE tenant = ? AND id = ?`
  ).bind(
    String(orchData.result || "").slice(0, 12000),
    orchData.run_id || null,
    caseId,
    receiptId,
    new Date().toISOString(),
    tenant,
    planId
  ).run();

  try {
    await issueTruthReceipt(env, {
      tenant,
      kind: "aip.plan.executed",
      subject_id: planId,
      actor,
      decision: String(orchData.result || "").slice(0, 1500),
      summary: row.goal?.slice(0, 300),
      input: { plan_id: planId, roles },
      output: { run_id: orchData.run_id, case_id: caseId }
    });
  } catch (_) {}

  try {
    await emitChangeEvent(env, {
      tenant,
      event: "aip.plan.executed",
      resource_kind: "aip_plan",
      resource_id: planId,
      payload: {
        goal: row.goal?.slice(0, 300),
        orchestrator_run_id: orchData.run_id || null,
        case_id: caseId,
        receipt_id: receiptId
      },
      actor
    });
  } catch (_) {}

  return json({
    ok: true,
    phase: "2-aip+9.1-auto-emit",
    plan_id: planId,
    status: "done",
    orchestrator_run_id: orchData.run_id,
    roles: orchData.roles,
    steps: orchData.steps,
    result: orchData.result,
    case_id: caseId,
    truth_receipt: orchData.truth_receipt,
    total_ms: orchData.total_ms
  }, 200, cors);
}
