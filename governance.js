// ASTON OS — Phase D Governance
// Fine-grained scopes, tenant actors, lineage, audit export to R2

export const SCOPE_CATALOG = {
  "read": "Read non-sensitive tenant data",
  "write": "Create/update tenant data",
  "ai": "Run AI / agents / orchestrator",
  "admin": "Full tenant administration",
  "ontology:read": "Read ontology graph",
  "ontology:write": "Mutate ontology",
  "orchestrator:run": "Run multi-agent plans",
  "cases:read": "List and view cases",
  "cases:write": "Create and transition cases",
  "ledger:write": "Post ledger entries",
  "audit:read": "Read audit log",
  "audit:export": "Export audit log to R2",
  "governance:admin": "Manage actors and scopes"
};

const ROLE_PRESETS = {
  viewer: ["read", "ontology:read", "cases:read", "audit:read"],
  operator: ["read", "write", "ai", "ontology:read", "ontology:write", "orchestrator:run", "cases:read", "cases:write", "audit:read"],
  compliance: ["read", "ai", "ontology:read", "cases:read", "cases:write", "audit:read", "audit:export"],
  admin: ["read", "write", "ai", "admin", "ontology:read", "ontology:write", "orchestrator:run", "cases:read", "cases:write", "ledger:write", "audit:read", "audit:export", "governance:admin"]
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "9.5.0", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export async function ensureGovernanceSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tenant_actors (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      scopes TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_actor ON tenant_actors (tenant, actor)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lineage (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      transform TEXT,
      meta TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lineage_entity ON lineage (tenant, entity_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lineage_source ON lineage (tenant, source_kind, source_id)")
  ]);
}

/** True if auth has required scope (admin implies all). */
export function hasScope(auth, required) {
  if (!auth) return false;
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  if (scopes.includes("admin") || scopes.includes("governance:admin")) return true;
  if (!required) return true;
  if (Array.isArray(required)) return required.some((s) => scopes.includes(s));
  return scopes.includes(required);
}

export function requireScope(auth, required) {
  if (hasScope(auth, required)) return null;
  return json({
    ok: false,
    error: "forbidden",
    required_scope: required,
    actor_scopes: auth?.scopes || []
  }, 403);
}

/**
 * Enrich API-token / JWT auth with per-actor scopes from tenant_actors when present.
 * API token without actor row keeps full scopes from token path.
 */
export async function enrichAuth(env, auth) {
  if (!auth || !env.ASTON_DB) return auth;
  try {
    await ensureGovernanceSchema(env.ASTON_DB);
    const row = await env.ASTON_DB.prepare(
      "SELECT role, scopes, active FROM tenant_actors WHERE tenant = ? AND actor = ? LIMIT 1"
    ).bind(auth.tenant, auth.actor).first();
    if (!row || !row.active) return auth;
    let scopes = [];
    try { scopes = JSON.parse(row.scopes || "[]"); } catch { scopes = []; }
    if (!Array.isArray(scopes) || !scopes.length) {
      scopes = ROLE_PRESETS[row.role] || auth.scopes;
    }
    return { ...auth, role: row.role, scopes, rls: true };
  } catch (e) {
    console.error("enrichAuth", e?.message || e);
    return auth;
  }
}

export async function recordLineage(env, {
  tenant, entity_id, entity_kind, source_kind, source_id, transform, meta, actor
}) {
  if (!env.ASTON_DB || !entity_id) return null;
  try {
    await ensureGovernanceSchema(env.ASTON_DB);
    const id = `lin_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await env.ASTON_DB.prepare(
      `INSERT INTO lineage (id, tenant, entity_id, entity_kind, source_kind, source_id, transform, meta, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tenant, String(entity_id), String(entity_kind || "entity"),
      String(source_kind || "unknown"), source_id ? String(source_id) : null,
      transform ? String(transform).slice(0, 200) : null,
      meta ? JSON.stringify(meta).slice(0, 2000) : null,
      actor || "system",
      new Date().toISOString()
    ).run();
    return id;
  } catch (e) {
    console.error("recordLineage", e?.message || e);
    return null;
  }
}

export async function handleGovernance(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const db = env.ASTON_DB;

  try {
    await ensureGovernanceSchema(db);

    if (method === "GET" && path === "/v1/governance/scopes") {
      return json({
        ok: true,
        phase: "D",
        scopes: SCOPE_CATALOG,
        role_presets: ROLE_PRESETS,
        actor: auth.actor,
        effective_scopes: auth.scopes,
        role: auth.role || null,
        rls: Boolean(auth.rls)
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/governance/actors") {
      const denied = requireScope(auth, ["governance:admin", "admin"]);
      if (denied) {
        denied.headers.set("content-type", "application/json; charset=utf-8");
        return new Response(denied.body, { status: denied.status, headers: { ...Object.fromEntries(denied.headers), ...cors } });
      }
      const rows = await db.prepare(
        "SELECT id, actor, role, scopes, active, created_at, updated_at FROM tenant_actors WHERE tenant = ? ORDER BY actor"
      ).bind(tenant).all();
      return json({ ok: true, tenant, actors: rows.results || [] }, 200, cors);
    }

    if (method === "POST" && path === "/v1/governance/actors") {
      const denied = requireScope(auth, ["governance:admin", "admin"]);
      if (denied) {
        return new Response(await denied.text(), { status: 403, headers: { "content-type": "application/json", ...cors } });
      }
      const body = await readJson(request);
      const actorName = String(body?.actor || "").trim().slice(0, 120);
      if (!actorName) return json({ ok: false, error: "actor_required" }, 400, cors);
      const role = String(body?.role || "viewer").toLowerCase();
      let scopes = Array.isArray(body?.scopes) ? body.scopes : (ROLE_PRESETS[role] || ROLE_PRESETS.viewer);
      const now = new Date().toISOString();
      const id = `act_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const existing = await db.prepare(
        "SELECT id FROM tenant_actors WHERE tenant = ? AND actor = ?"
      ).bind(tenant, actorName).first();
      if (existing) {
        await db.prepare(
          "UPDATE tenant_actors SET role = ?, scopes = ?, active = ?, updated_at = ? WHERE tenant = ? AND actor = ?"
        ).bind(role, JSON.stringify(scopes), body?.active === false ? 0 : 1, now, tenant, actorName).run();
      } else {
        await db.prepare(
          `INSERT INTO tenant_actors (id, tenant, actor, role, scopes, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        ).bind(id, tenant, actorName, role, JSON.stringify(scopes), now, now).run();
      }
      try {
        await db.prepare(
          "INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)"
        ).bind(now, tenant, auth.actor, "governance.actor.upsert", JSON.stringify({ actor: actorName, role }).slice(0, 1500)).run();
      } catch (_) {}
      return json({ ok: true, actor: actorName, role, scopes }, 200, cors);
    }

    if (method === "GET" && path === "/v1/governance/lineage") {
      const denied = requireScope(auth, ["audit:read", "read", "admin"]);
      if (denied) return new Response(await denied.text(), { status: 403, headers: { "content-type": "application/json", ...cors } });
      const entityId = url.searchParams.get("entity_id");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      let rows;
      if (entityId) {
        rows = await db.prepare(
          "SELECT * FROM lineage WHERE tenant = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, entityId, limit).all();
      } else {
        rows = await db.prepare(
          "SELECT * FROM lineage WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, limit).all();
      }
      return json({ ok: true, tenant, lineage: rows.results || [] }, 200, cors);
    }

    if (method === "POST" && path === "/v1/governance/lineage") {
      const denied = requireScope(auth, ["write", "ontology:write", "admin"]);
      if (denied) return new Response(await denied.text(), { status: 403, headers: { "content-type": "application/json", ...cors } });
      const body = await readJson(request);
      if (!body?.entity_id) return json({ ok: false, error: "entity_id_required" }, 400, cors);
      const id = await recordLineage(env, {
        tenant,
        entity_id: body.entity_id,
        entity_kind: body.entity_kind,
        source_kind: body.source_kind,
        source_id: body.source_id,
        transform: body.transform,
        meta: body.meta,
        actor: auth.actor
      });
      return json({ ok: true, id }, 201, cors);
    }

    if (method === "POST" && path === "/v1/governance/audit/export") {
      const denied = requireScope(auth, ["audit:export", "admin"]);
      if (denied) return new Response(await denied.text(), { status: 403, headers: { "content-type": "application/json", ...cors } });
      if (!env.ASTON_R2) return json({ ok: false, error: "r2_unavailable" }, 503, cors);
      const body = await readJson(request) || {};
      const limit = Math.min(5000, Math.max(1, Number(body.limit || 1000)));
      const rows = await db.prepare(
        "SELECT id, ts, tenant, actor, action, detail FROM audit_log WHERE tenant = ? ORDER BY id DESC LIMIT ?"
      ).bind(tenant, limit).all();
      const exportId = crypto.randomUUID();
      const key = `audit-exports/${tenant}/${exportId}.jsonl`;
      const lines = (rows.results || []).map((r) => JSON.stringify(r)).join("\n");
      await env.ASTON_R2.put(key, lines + (lines ? "\n" : ""), {
        httpMetadata: { contentType: "application/x-ndjson" },
        customMetadata: { tenant, export_id: exportId, count: String((rows.results || []).length) }
      });
      try {
        await db.prepare(
          "INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)"
        ).bind(
          new Date().toISOString(), tenant, auth.actor, "governance.audit.export",
          JSON.stringify({ key, count: (rows.results || []).length }).slice(0, 1500)
        ).run();
      } catch (_) {}
      return json({
        ok: true,
        export_id: exportId,
        r2_key: key,
        count: (rows.results || []).length
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/governance/whoami") {
      return json({
        ok: true,
        tenant: auth.tenant,
        actor: auth.actor,
        role: auth.role || null,
        scopes: auth.scopes,
        rls: Boolean(auth.rls),
        phase: "D"
      }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("governance handler", e?.message || e);
    return json({ ok: false, error: "governance_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

/** Map route prefix → required scope for worker.js */
export function scopeForPath(path, method) {
  const m = method.toUpperCase();
  if (path.startsWith("/v1/governance")) {
    if (path.includes("/actors") && m !== "GET") return ["governance:admin", "admin"];
    if (path.includes("/audit/export")) return ["audit:export", "admin"];
    if (path.includes("/lineage") && m === "POST") return ["write", "ontology:write", "admin"];
    return ["read", "audit:read", "admin"];
  }
  if (path.startsWith("/v1/ontology")) {
    return m === "GET" ? ["ontology:read", "read", "admin"] : ["ontology:write", "write", "admin"];
  }
  if (path.startsWith("/v1/orchestrator")) {
    return m === "GET" ? ["read", "admin"] : ["orchestrator:run", "ai", "admin"];
  }
  if (path.startsWith("/v1/cases")) {
    return m === "GET" ? ["cases:read", "read", "admin"] : ["cases:write", "write", "admin"];
  }
  return m === "GET" ? ["read", "admin"] : ["write", "admin"];
}
