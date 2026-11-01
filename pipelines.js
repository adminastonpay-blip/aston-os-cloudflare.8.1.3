// ASTON OS — Phase 4 Security Pipelines + Phase 9.1 auto-emit
// Declarative stages: ingest → classify/mark → ACL → ontology upsert → optional AIP/HITL

import { setResourceMarking, grantAcl, ensureObjectAclSchema } from "./object_acl.js";
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

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

/** Built-in pipeline templates */
export const PIPELINE_CATALOG = [
  {
    id: "secure_ingest",
    name: "Secure ingest",
    description: "Normalize items → ontology entities → default INTERNAL marking",
    stages: ["normalize", "upsert_entities", "apply_marking", "receipt"]
  },
  {
    id: "classified_ingest",
    name: "Classified ingest",
    description: "Ingest with explicit marking (CONFIDENTIAL+) and optional ACL principals",
    stages: ["normalize", "upsert_entities", "apply_marking", "apply_acl", "receipt"]
  },
  {
    id: "risk_pipeline",
    name: "Risk review pipeline",
    description: "Ingest suppliers/events → mark RESTRICTED → open AIP plan for HITL",
    stages: ["normalize", "upsert_entities", "apply_marking", "open_aip_plan", "receipt"]
  },
  {
    id: "zero_copy_http",
    name: "Zero-copy HTTP → secure ontology",
    description: "Fetch remote JSON, project to entities, mark INTERNAL",
    stages: ["fetch_http", "normalize", "upsert_entities", "apply_marking", "receipt"]
  }
];

export async function ensurePipelineSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, template_id TEXT,
      config TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pipe_tenant ON pipelines (tenant, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, pipeline_id TEXT, template_id TEXT NOT NULL,
      status TEXT NOT NULL, stages_json TEXT, stats TEXT, error TEXT,
      actor TEXT, created_at TEXT NOT NULL, finished_at TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pipe_runs ON pipeline_runs (tenant, created_at)")
  ]);
}

async function ensureOntologyTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ontology_entities (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      props TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL,
      payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`)
  ]);
}

async function upsertEntity(db, tenant, { type, name, props, source }) {
  const ename = String(name || "").trim().slice(0, 500);
  if (!ename) return null;
  const etype = String(type || "other").toLowerCase().slice(0, 40);
  const now = new Date().toISOString();
  const existing = await db.prepare(
    "SELECT id FROM ontology_entities WHERE tenant = ? AND type = ? AND lower(name) = lower(?) LIMIT 1"
  ).bind(tenant, etype, ename).first();
  if (existing?.id) {
    await db.prepare(
      "UPDATE ontology_entities SET props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(JSON.stringify(props || {}), source || null, now, tenant, existing.id).run();
    return { id: existing.id, created: false };
  }
  const id = slugId("ent");
  await db.prepare(
    "INSERT INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tenant, etype, ename, JSON.stringify(props || {}), source || null, now, now).run();
  return { id, created: true };
}

function normalizeItems(rawItems, defaults = {}) {
  const items = [];
  for (const raw of (rawItems || []).slice(0, 300)) {
    if (!raw || typeof raw !== "object") continue;
    const name = raw.name || raw.title || raw.email || raw.id || raw.sku || null;
    if (!name && !raw.text) continue;
    items.push({
      name: name ? String(name) : String(raw.text || "").slice(0, 80),
      type: String(raw.type || raw.entity_type || defaults.type || "other").toLowerCase(),
      props: raw.props && typeof raw.props === "object" ? raw.props : { ...raw },
      text: String(raw.text || raw.description || name || ""),
      sector: raw.sector || defaults.sector || "primary"
    });
  }
  return items;
}

async function stageFetchHttp(env, config) {
  const url = config?.url;
  if (!url) throw new Error("url_required_for_fetch_http");
  const headers = config.headers && typeof config.headers === "object" ? config.headers : {};
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  const data = await res.json();
  let arr = data;
  if (config.path) {
    arr = String(config.path).split(".").reduce((a, k) => (a == null ? a : a[k]), data);
  }
  if (!Array.isArray(arr)) arr = arr && typeof arr === "object" ? [arr] : Array.isArray(data) ? data : [data];
  return { items: arr, source: `http:${String(url).slice(0, 80)}` };
}

async function runStages(env, auth, templateId, config, body) {
  const tenant = auth.tenant;
  const actor = auth.actor || "pipeline";
  const db = env.ASTON_DB;
  await ensureOntologyTables(db);
  await ensureObjectAclSchema(db);

  const stagesLog = [];
  const stats = { entities: 0, marked: 0, acl_grants: 0, records: 0, aip_plan_id: null };
  let items = normalizeItems(
    body?.items || body?.entities || config?.items || [],
    { type: config?.default_type || body?.default_type, sector: config?.sector }
  );
  let source = body?.source || config?.source || `pipeline:${templateId}`;

  const catalog = PIPELINE_CATALOG.find((p) => p.id === templateId);
  const stageList = body?.stages || catalog?.stages || ["normalize", "upsert_entities", "apply_marking", "receipt"];
  const marking = String(body?.marking || config?.marking || "INTERNAL").toUpperCase();
  const aclPrincipals = body?.acl_principals || config?.acl_principals || [];

  for (const stage of stageList) {
    const t0 = Date.now();
    try {
      if (stage === "fetch_http") {
        const fetched = await stageFetchHttp(env, { ...config, ...body });
        items = normalizeItems(fetched.items, { type: config?.default_type });
        source = fetched.source;
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, count: items.length });
      } else if (stage === "normalize") {
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, count: items.length });
      } else if (stage === "upsert_entities") {
        for (const it of items) {
          const result = await upsertEntity(db, tenant, {
            type: it.type, name: it.name, props: it.props, source
          });
          if (result?.id) {
            it._entity_id = result.id;
            stats.entities++;
            try {
              await emitChangeEvent(env, {
                tenant,
                event: result.created ? "entity.created" : "entity.updated",
                resource_kind: "entity",
                resource_id: result.id,
                payload: { type: it.type, name: it.name, source, via: "pipeline" },
                actor
              });
            } catch (_) {}
          }
          // optional record
          try {
            const rid = slugId("rec");
            await db.prepare(
              "INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(rid, tenant, it.sector || "primary", JSON.stringify(it.props || {}), String(it.text || it.name).slice(0, 4000), new Date().toISOString()).run();
            stats.records++;
          } catch (_) {}
        }
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, entities: stats.entities });
      } else if (stage === "apply_marking") {
        for (const it of items) {
          if (!it._entity_id) continue;
          try {
            await setResourceMarking(db, tenant, "entity", it._entity_id, marking, actor);
            stats.marked++;
          } catch (e) {
            stagesLog.push({ stage: "apply_marking_item", ok: false, error: String(e.message || e).slice(0, 120) });
          }
        }
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, marked: stats.marked, marking });
      } else if (stage === "apply_acl") {
        const principals = Array.isArray(aclPrincipals) ? aclPrincipals : [];
        for (const it of items) {
          if (!it._entity_id) continue;
          for (const p of principals) {
            const principal = typeof p === "string" ? p : p.principal;
            if (!principal) continue;
            await grantAcl(db, tenant, {
              resource_kind: "entity",
              resource_id: it._entity_id,
              principal,
              can_read: p.can_read !== false,
              can_write: Boolean(p.can_write),
              can_action: Boolean(p.can_action)
            });
            stats.acl_grants++;
          }
        }
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, acl_grants: stats.acl_grants });
      } else if (stage === "open_aip_plan") {
        try {
          const { handleAip } = await import("./aip.js");
          const goal = body?.goal || config?.goal ||
            `Security pipeline ${templateId}: review ${stats.entities} ingested entities (marking=${marking})`;
          const req = new Request("https://pipeline.internal/v1/aip/plan", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              goal,
              require_approval: body?.require_approval !== false,
              open_case: Boolean(body?.open_case),
              roles: body?.roles || ["compliance", "analyst"]
            })
          });
          const res = await handleAip(req, env, auth, {});
          const data = await res.json().catch(() => null);
          stats.aip_plan_id = data?.plan_id || null;
          stagesLog.push({ stage, ok: Boolean(data?.ok || data?.plan_id), ms: Date.now() - t0, plan_id: stats.aip_plan_id });
        } catch (e) {
          stagesLog.push({ stage, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
        }
      } else if (stage === "receipt") {
        let receipt = null;
        try {
          receipt = await issueTruthReceipt(env, {
            tenant,
            kind: "pipeline.run",
            subject_id: body?._run_id || null,
            actor,
            decision: `pipeline:${templateId}`,
            summary: `entities=${stats.entities} marking=${marking}`,
            input: { template_id: templateId, marking },
            output: stats
          });
        } catch (_) {}
        stagesLog.push({ stage, ok: true, ms: Date.now() - t0, receipt_id: receipt?.id || null });
        stats.receipt = receipt;
      } else {
        stagesLog.push({ stage, ok: false, error: "unknown_stage" });
      }
    } catch (e) {
      stagesLog.push({ stage, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
      throw e;
    }
  }

  return {
    stats,
    stages: stagesLog,
    entity_ids: items.map((i) => i._entity_id).filter(Boolean),
    marking
  };
}

export async function handlePipelines(request, env, auth, cors = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";

  if (method === "GET" && (path === "/v1/pipelines" || path === "/v1/pipelines/status" || path === "/v1/pipelines/catalog")) {
    return json({
      ok: true,
      phase: "4-security-pipelines+9.1-auto-emit",
      version: VERSION,
      auto_emit: true,
      catalog: PIPELINE_CATALOG,
      endpoints: {
        catalog: "GET /v1/pipelines/catalog",
        run: "POST /v1/pipelines/run",
        run_template: "POST /v1/pipelines/run/:template_id",
        runs: "GET /v1/pipelines/runs",
        list: "GET /v1/pipelines/list"
      }
    }, 200, cors);
  }

  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensurePipelineSchema(env.ASTON_DB);
  const db = env.ASTON_DB;

  if (method === "GET" && path === "/v1/pipelines/runs") {
    const limit = Math.min(40, Number(url.searchParams.get("limit") || 15));
    const rows = await db.prepare(
      "SELECT id, pipeline_id, template_id, status, stats, error, actor, created_at, finished_at FROM pipeline_runs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, runs: rows.results || [] }, 200, cors);
  }

  if (method === "GET" && path === "/v1/pipelines/list") {
    const rows = await db.prepare(
      "SELECT id, name, template_id, status, created_at, updated_at FROM pipelines WHERE tenant = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(tenant).all();
    return json({ ok: true, pipelines: rows.results || [] }, 200, cors);
  }

  // POST /v1/pipelines/run or /v1/pipelines/run/:template_id
  const runMatch = path.match(/^\/v1\/pipelines\/run(?:\/([^/]+))?$/);
  if (method === "POST" && runMatch) {
    const body = await readJson(request) || {};
    const templateId = runMatch[1] || body.template_id || body.template || "secure_ingest";
    if (!PIPELINE_CATALOG.find((p) => p.id === templateId) && !body.stages) {
      return json({
        ok: false,
        error: "unknown_template",
        catalog: PIPELINE_CATALOG.map((p) => p.id)
      }, 400, cors);
    }

    const runId = slugId("prun");
    const now = new Date().toISOString();
    body._run_id = runId;

    await db.prepare(
      `INSERT INTO pipeline_runs (id, tenant, pipeline_id, template_id, status, stages_json, stats, error, actor, created_at, finished_at)
       VALUES (?, ?, NULL, ?, 'running', NULL, NULL, NULL, ?, ?, NULL)`
    ).bind(runId, tenant, templateId, actor, now).run();

    try {
      const result = await runStages(env, auth, templateId, body.config || {}, body);
      const finished = new Date().toISOString();
      await db.prepare(
        "UPDATE pipeline_runs SET status = ?, stages_json = ?, stats = ?, finished_at = ? WHERE id = ?"
      ).bind(
        "done",
        JSON.stringify(result.stages).slice(0, 12000),
        JSON.stringify(result.stats).slice(0, 4000),
        finished,
        runId
      ).run();

      try {
        await emitChangeEvent(env, {
          tenant,
          event: "pipeline.completed",
          resource_kind: "pipeline_run",
          resource_id: runId,
          payload: {
            template_id: templateId,
            stats: result.stats,
            entity_ids: result.entity_ids?.slice(0, 50) || [],
            marking: result.marking
          },
          actor
        });
      } catch (_) {}

      return json({
        ok: true,
        phase: "4-security-pipelines+9.1-auto-emit",
        run_id: runId,
        template_id: templateId,
        ...result
      }, 200, cors);
    } catch (e) {
      await db.prepare(
        "UPDATE pipeline_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?"
      ).bind("failed", String(e.message || e).slice(0, 500), new Date().toISOString(), runId).run();
      try {
        await emitChangeEvent(env, {
          tenant,
          event: "pipeline.failed",
          resource_kind: "pipeline_run",
          resource_id: runId,
          payload: { template_id: templateId, error: String(e.message || e).slice(0, 200) },
          actor
        });
      } catch (_) {}
      return json({
        ok: false,
        error: "pipeline_failed",
        run_id: runId,
        detail: String(e.message || e).slice(0, 300)
      }, 500, cors);
    }
  }

  // Save named pipeline config
  if (method === "POST" && path === "/v1/pipelines") {
    const body = await readJson(request) || {};
    const id = slugId("pipe");
    const now = new Date().toISOString();
    const name = String(body.name || body.template_id || "pipeline").slice(0, 200);
    const templateId = body.template_id || "secure_ingest";
    await db.prepare(
      "INSERT INTO pipelines (id, tenant, name, template_id, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)"
    ).bind(id, tenant, name, templateId, JSON.stringify(body.config || body), now, now).run();
    return json({ ok: true, id, name, template_id: templateId }, 201, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
