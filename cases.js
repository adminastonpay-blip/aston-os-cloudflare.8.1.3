// ASTON OS — Phase C Cases & Playbooks
// Operational mission objects: open → investigate → decide → act → close

const STATUSES = new Set(["open", "investigating", "pending_approval", "acting", "resolved", "closed", "cancelled"]);
const PRIORITIES = new Set(["low", "medium", "high", "critical"]);

const PLAYBOOKS = {
  store_audit: {
    id: "store_audit",
    name: "Store / channel live audit",
    description: "Open a case from store audit signals; orchestrate analyst + growth",
    default_priority: "medium",
    roles: ["analyst", "growth"],
    steps: ["collect_channels", "score_findings", "recommend_fixes", "assign_owner"]
  },
  supplier_risk: {
    id: "supplier_risk",
    name: "Supplier risk review",
    description: "Investigate supplier score / country risk; compliance + supplier roles",
    default_priority: "high",
    roles: ["supplier", "compliance"],
    steps: ["load_supplier", "score_risk", "mitigation_plan", "approval_gate"]
  },
  ledger_anomaly: {
    id: "ledger_anomaly",
    name: "Ledger anomaly",
    description: "Investigate unusual ledger movements",
    default_priority: "high",
    roles: ["analyst", "compliance"],
    steps: ["pull_recent_entries", "flag_outliers", "reconcile", "close_or_escalate"]
  },
  ontology_alert: {
    id: "ontology_alert",
    name: "Ontology / graph alert",
    description: "Case triggered by entity or relation change",
    default_priority: "medium",
    roles: ["analyst"],
    steps: ["inspect_entities", "trace_relations", "document_impact"]
  }
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "9.4.0", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export async function ensureCasesSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      title TEXT NOT NULL,
      playbook TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee TEXT,
      ontology_ids TEXT,
      payload TEXT,
      result TEXT,
      orchestrator_run_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_cases_tenant ON cases (tenant, status, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS case_events (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_case_events ON case_events (tenant, case_id, created_at)")
  ]);
}

function newId(prefix = "case") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function addEvent(db, tenant, caseId, event, detail, actor) {
  await db.prepare(
    "INSERT INTO case_events (id, case_id, tenant, event, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    newId("cev"),
    caseId,
    tenant,
    event,
    detail ? JSON.stringify(detail).slice(0, 4000) : null,
    actor || "system",
    new Date().toISOString()
  ).run();
}

async function fireWebhooks(env, tenant, eventName, payload) {
  if (!env.ASTON_DB) return { sent: 0 };
  try {
    const rows = await env.ASTON_DB.prepare(
      "SELECT id, url, secret, events FROM webhooks WHERE tenant = ? AND active = 1"
    ).bind(tenant).all();
    let sent = 0;
    for (const wh of rows.results || []) {
      let events = [];
      try { events = JSON.parse(wh.events || "[]"); } catch { events = []; }
      if (Array.isArray(events) && events.length && !events.includes(eventName) && !events.includes("*")) continue;
      try {
        const body = JSON.stringify({
          event: eventName,
          tenant,
          ts: new Date().toISOString(),
          data: payload
        });
        const headers = { "content-type": "application/json", "x-aston-event": eventName };
        if (wh.secret) headers["x-aston-signature"] = wh.secret;
        await fetch(wh.url, { method: "POST", headers, body });
        sent++;
      } catch (e) {
        console.error("webhook failed", wh.id, e?.message || e);
      }
    }
    return { sent };
  } catch (e) {
    console.error("fireWebhooks", e?.message || e);
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

async function getCase(db, tenant, id) {
  return db.prepare("SELECT * FROM cases WHERE tenant = ? AND id = ?").bind(tenant, id).first();
}

export async function handleCases(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const db = env.ASTON_DB;
  const actor = auth.actor || "api";

  try {
    await ensureCasesSchema(db);

    if (method === "GET" && path === "/v1/cases/playbooks") {
      return json({ ok: true, phase: "C", playbooks: Object.values(PLAYBOOKS) }, 200, cors);
    }

    if (method === "GET" && path === "/v1/cases") {
      const status = url.searchParams.get("status");
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      let rows;
      if (status && STATUSES.has(status)) {
        rows = await db.prepare(
          "SELECT id, title, playbook, status, priority, assignee, orchestrator_run_id, created_at, updated_at FROM cases WHERE tenant = ? AND status = ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, status, limit).all();
      } else {
        rows = await db.prepare(
          "SELECT id, title, playbook, status, priority, assignee, orchestrator_run_id, created_at, updated_at FROM cases WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, limit).all();
      }
      return json({ ok: true, tenant, cases: rows.results || [] }, 200, cors);
    }

    if (method === "GET" && /^\/v1\/cases\/[^/]+$/.test(path) && !path.endsWith("/playbooks")) {
      const id = path.split("/").pop();
      const row = await getCase(db, tenant, id);
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      const events = await db.prepare(
        "SELECT id, event, detail, actor, created_at FROM case_events WHERE tenant = ? AND case_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(tenant, id).all();
      return json({ ok: true, case: row, events: events.results || [] }, 200, cors);
    }

    if (method === "POST" && path === "/v1/cases") {
      const body = await readJson(request);
      if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400, cors);
      const playbookId = body.playbook ? String(body.playbook) : null;
      const pb = playbookId ? PLAYBOOKS[playbookId] : null;
      if (playbookId && !pb) return json({ ok: false, error: "unknown_playbook", playbooks: Object.keys(PLAYBOOKS) }, 400, cors);

      const id = newId("case");
      const now = new Date().toISOString();
      const title = String(body.title || pb?.name || "Untitled case").slice(0, 300);
      const priority = PRIORITIES.has(String(body.priority || "").toLowerCase())
        ? String(body.priority).toLowerCase()
        : (pb?.default_priority || "medium");
      const ontologyIds = Array.isArray(body.ontology_ids) ? body.ontology_ids : [];
      const payload = {
        ...(body.payload && typeof body.payload === "object" ? body.payload : {}),
        playbook_steps: pb?.steps || [],
        roles: body.roles || pb?.roles || []
      };

      await db.prepare(
        `INSERT INTO cases (id, tenant, title, playbook, status, priority, assignee, ontology_ids, payload, result, orchestrator_run_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      ).bind(
        id, tenant, title, playbookId, "open", priority,
        body.assignee ? String(body.assignee).slice(0, 120) : null,
        JSON.stringify(ontologyIds).slice(0, 2000),
        JSON.stringify(payload).slice(0, 8000),
        actor, now, now
      ).run();

      await addEvent(db, tenant, id, "created", { playbook: playbookId, priority }, actor);
      await fireWebhooks(env, tenant, "case.created", { id, title, playbook: playbookId, priority });

      // Optional: auto-run orchestrator
      let orchRunId = null;
      if (body.run_orchestrator && env.AI) {
        try {
          const { handleOrchestrator } = await import("./orchestrator.js");
          const goal = String(body.goal || `Case ${title}: execute playbook ${playbookId || "custom"}`);
          const fakeReq = new Request("https://cases.internal/v1/orchestrator/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal, roles: payload.roles, store_artifact: true })
          });
          const res = await handleOrchestrator(fakeReq, env, auth, {});
          const data = await res.json().catch(() => null);
          if (data?.run_id) {
            orchRunId = data.run_id;
            await db.prepare(
              "UPDATE cases SET status = ?, orchestrator_run_id = ?, result = ?, updated_at = ? WHERE tenant = ? AND id = ?"
            ).bind(
              "investigating",
              orchRunId,
              String(data.result || "").slice(0, 8000),
              new Date().toISOString(),
              tenant,
              id
            ).run();
            await addEvent(db, tenant, id, "orchestrator_started", { run_id: orchRunId }, actor);
            await fireWebhooks(env, tenant, "case.status_changed", { id, status: "investigating", orchestrator_run_id: orchRunId });
          }
        } catch (e) {
          console.error("case orchestrator", e?.message || e);
          await addEvent(db, tenant, id, "orchestrator_error", { error: String(e?.message || e).slice(0, 300) }, actor);
        }
      }

      const row = await getCase(db, tenant, id);
      return json({ ok: true, case: row, orchestrator_run_id: orchRunId }, 201, cors);
    }

    // PATCH-like via POST /v1/cases/:id/transition
    if (method === "POST" && /\/v1\/cases\/[^/]+\/transition$/.test(path)) {
      const id = path.split("/")[3];
      const body = await readJson(request);
      const next = String(body?.status || "").toLowerCase();
      if (!STATUSES.has(next)) {
        return json({ ok: false, error: "invalid_status", allowed: [...STATUSES] }, 400, cors);
      }
      const row = await getCase(db, tenant, id);
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      const now = new Date().toISOString();
      await db.prepare(
        "UPDATE cases SET status = ?, assignee = COALESCE(?, assignee), result = COALESCE(?, result), updated_at = ? WHERE tenant = ? AND id = ?"
      ).bind(
        next,
        body?.assignee ? String(body.assignee).slice(0, 120) : null,
        body?.result != null ? String(body.result).slice(0, 8000) : null,
        now, tenant, id
      ).run();
      await addEvent(db, tenant, id, "status_changed", { from: row.status, to: next, note: body?.note || null }, actor);
      await fireWebhooks(env, tenant, "case.status_changed", { id, from: row.status, to: next });
      const updated = await getCase(db, tenant, id);
      return json({ ok: true, case: updated }, 200, cors);
    }

    if (method === "POST" && /\/v1\/cases\/[^/]+\/events$/.test(path)) {
      const id = path.split("/")[3];
      const row = await getCase(db, tenant, id);
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      const body = await readJson(request);
      const event = String(body?.event || "note").slice(0, 80);
      await addEvent(db, tenant, id, event, body?.detail || { text: body?.text || "" }, actor);
      await db.prepare("UPDATE cases SET updated_at = ? WHERE tenant = ? AND id = ?")
        .bind(new Date().toISOString(), tenant, id).run();
      return json({ ok: true, case_id: id, event }, 201, cors);
    }

    // Launch playbook helper: POST /v1/cases/playbooks/:id/run
    if (method === "POST" && /\/v1\/cases\/playbooks\/[^/]+\/run$/.test(path)) {
      const pbId = path.split("/")[4];
      const pb = PLAYBOOKS[pbId];
      if (!pb) return json({ ok: false, error: "unknown_playbook" }, 400, cors);
      const body = await readJson(request) || {};
      // Reuse create logic via internal shape
      const createBody = {
        title: body.title || pb.name,
        playbook: pbId,
        priority: body.priority || pb.default_priority,
        payload: body.payload || {},
        ontology_ids: body.ontology_ids || [],
        assignee: body.assignee,
        run_orchestrator: body.run_orchestrator !== false,
        goal: body.goal || `${pb.name}: ${body.context || ""}`.trim()
      };
      const fake = new Request("https://cases.internal/v1/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createBody)
      });
      return handleCases(fake, env, auth, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("cases handler", e?.message || e);
    return json({ ok: false, error: "cases_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}
