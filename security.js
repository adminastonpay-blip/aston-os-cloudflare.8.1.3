// ASTON OS — Phase 3: Enterprise Fine-Grained Security
// OLS / ALS · Object ACL · Data markings · Multi-tenant · SSO JWT

import {
  ensureObjectAclSchema,
  MARKINGS,
  ROLE_CLEARANCE,
  clearanceOf,
  grantAcl,
  listAcl,
  setResourceMarking,
  getResourceMarking,
  checkObjectAccess,
  canClearance,
  redactByRole
} from "./object_acl.js";

const VERSION = "11.6.0";

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

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

const DEFAULT_ALS = {
  viewer: { deny_attributes: ["ssn", "tax_id", "bank_account", "salary", "secret", "api_key"], allow_object_types: null },
  operator: { deny_attributes: ["ssn", "tax_id", "bank_account", "salary"], allow_object_types: null },
  compliance: { deny_attributes: ["api_key"], allow_object_types: null },
  admin: { deny_attributes: [], allow_object_types: null }
};

export async function ensureSecuritySchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS security_policies (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      policy_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sec_pol_tenant ON security_policies (tenant, kind, active)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS sso_configs (
      tenant TEXT PRIMARY KEY, provider TEXT NOT NULL, issuer TEXT, client_id TEXT,
      audience TEXT, jwks_uri TEXT, claim_map TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS security_audit (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
      resource TEXT, detail TEXT, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sec_audit ON security_audit (tenant, created_at)")
  ]);
  await ensureObjectAclSchema(db);
}

export function enforceTenant(auth, resourceTenant) {
  if (!auth) return false;
  return auth.tenant === resourceTenant;
}

export function applyALS(auth, obj, policyOverride = null) {
  if (!obj || typeof obj !== "object") return obj;
  const role = auth?.role || (auth?.scopes?.includes("admin") ? "admin" : "viewer");
  const als = policyOverride || DEFAULT_ALS[role] || DEFAULT_ALS.viewer;
  const deny = new Set((als.deny_attributes || []).map((s) => String(s).toLowerCase()));
  if (!deny.size) return obj;
  const scrub = (o) => {
    if (Array.isArray(o)) return o.map(scrub);
    if (!o || typeof o !== "object") return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (deny.has(k.toLowerCase())) out[k] = "[REDACTED]";
      else if (v && typeof v === "object") out[k] = scrub(v);
      else out[k] = v;
    }
    return out;
  };
  return scrub(obj);
}

export function applyOLS(auth, items, opts = {}) {
  if (!Array.isArray(items)) return items;
  const role = auth?.role || (auth?.scopes?.includes("admin") ? "admin" : "viewer");
  const als = DEFAULT_ALS[role] || DEFAULT_ALS.viewer;
  let list = items;
  if (als.allow_object_types && Array.isArray(als.allow_object_types)) {
    const allow = new Set(als.allow_object_types.map((t) => String(t).toLowerCase()));
    list = list.filter((it) => allow.has(String(it.type || it.entity_type || "").toLowerCase()));
  }
  if (opts.ownerField && !auth?.scopes?.includes("admin")) {
    list = list.filter((it) => !it[opts.ownerField] || it[opts.ownerField] === auth.actor);
  }
  return list.map((it) => applyALS(auth, it));
}

async function audit(env, tenant, actor, action, resource, detail) {
  if (!env.ASTON_DB) return;
  try {
    await ensureSecuritySchema(env.ASTON_DB);
    await env.ASTON_DB.prepare(
      "INSERT INTO security_audit (id, tenant, actor, action, resource, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(slugId("saud"), tenant, actor || "system", action, resource || null,
      detail ? JSON.stringify(detail).slice(0, 1500) : null, new Date().toISOString()).run();
  } catch (_) {}
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

async function verifyHs256Jwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    if (header.alg !== "HS256") return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const payload = decodeJwtPayload(token);
    if (!payload?.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export function mapSsoClaims(payload, claimMap = {}) {
  const tenantClaim = claimMap.tenant || "tenant";
  const actorClaim = claimMap.actor || "email";
  const rolesClaim = claimMap.roles || "roles";
  const tenant = String(payload[tenantClaim] || payload.tid || payload.org_id || "default");
  const actor = String(payload[actorClaim] || payload.sub || payload.email || "sso-user");
  let role = "viewer";
  const roles = payload[rolesClaim] || payload.role || [];
  const roleList = Array.isArray(roles) ? roles : [roles];
  const roleMap = claimMap.role_map || {
    admin: "admin", Admin: "admin", ASTON_Admin: "admin",
    operator: "operator", compliance: "compliance"
  };
  for (const r of roleList) { if (roleMap[r]) { role = roleMap[r]; break; } }
  const ROLE_SCOPES = {
    viewer: ["read", "ontology:read", "cases:read", "audit:read"],
    operator: ["read", "write", "ai", "ontology:read", "ontology:write", "orchestrator:run", "cases:read", "cases:write", "audit:read"],
    compliance: ["read", "ai", "ontology:read", "cases:read", "cases:write", "audit:read", "audit:export"],
    admin: ["read", "write", "ai", "admin", "ontology:read", "ontology:write", "orchestrator:run", "cases:read", "cases:write", "ledger:write", "audit:read", "audit:export", "governance:admin"]
  };
  return {
    tenant, actor, role,
    clearance: ROLE_CLEARANCE[role] ?? ROLE_CLEARANCE.viewer,
    scopes: ROLE_SCOPES[role] || ROLE_SCOPES.viewer,
    sso: true,
    claims: { iss: payload.iss, aud: payload.aud, sub: payload.sub }
  };
}

async function simpleAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    const headerRole = String(request.headers.get("X-Aston-Role") || "admin").toLowerCase();
    const role = ["viewer", "operator", "compliance", "admin"].includes(headerRole) ? headerRole : "admin";
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      actor: request.headers.get("X-Aston-Actor") || "api-token",
      role,
      clearance: ROLE_CLEARANCE[role],
      scopes: role === "admin"
        ? ["read", "write", "ai", "admin", "governance:admin", "audit:read", "audit:export"]
        : ["read", "write", "ontology:read", "cases:read"]
    };
  }
  if (env.ASTON_JWT_SECRET) {
    const payload = await verifyHs256Jwt(token, env.ASTON_JWT_SECRET);
    if (payload) {
      let claimMap = {};
      if (env.ASTON_DB) {
        try {
          await ensureSecuritySchema(env.ASTON_DB);
          const tenantHint = request.headers.get("X-Tenant") || payload.tenant || "default";
          const row = await env.ASTON_DB.prepare(
            "SELECT claim_map FROM sso_configs WHERE tenant = ? AND active = 1 LIMIT 1"
          ).bind(String(tenantHint)).first();
          if (row?.claim_map) claimMap = JSON.parse(row.claim_map);
        } catch (_) {}
      }
      return mapSsoClaims(payload, claimMap);
    }
  }
  return null;
}

export async function handleSecurity(request, env, path, method, cors = {}) {
  const url = new URL(request.url);

  if (method === "GET" && path === "/v1/security/status") {
    return json({
      ok: true,
      phase: "3-security",
      version: VERSION,
      features: {
        ols: true,
        als: true,
        object_acl: true,
        data_markings: true,
        clearance: true,
        multi_tenant: true,
        sso_oidc_jwt: true,
        sso_saml: "config_only"
      },
      markings: Object.values(MARKINGS),
      role_clearance: ROLE_CLEARANCE,
      endpoints: {
        status: "GET /v1/security/status",
        whoami: "GET /v1/security/whoami",
        acl: "GET|POST /v1/security/acl",
        markings: "GET|POST /v1/security/markings",
        check: "POST /v1/security/access/check",
        policies: "GET|POST /v1/security/policies",
        als_preview: "POST /v1/security/als/preview",
        sso: "GET|PUT /v1/security/sso",
        audit: "GET /v1/security/audit"
      }
    }, 200, cors);
  }

  const auth = await simpleAuth(request, env);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureSecuritySchema(env.ASTON_DB);
  const db = env.ASTON_DB;
  const tenant = auth.tenant;

  if (method === "GET" && path === "/v1/security/whoami") {
    return json({
      ok: true,
      tenant: auth.tenant,
      actor: auth.actor,
      role: auth.role || null,
      clearance: clearanceOf(auth),
      scopes: auth.scopes,
      sso: Boolean(auth.sso),
      als_profile: DEFAULT_ALS[auth.role || "viewer"] || DEFAULT_ALS.viewer,
      multi_tenant: true,
      phase: "3-security"
    }, 200, cors);
  }

  // ---- Object ACL ----
  if (method === "GET" && path === "/v1/security/acl") {
    const kind = url.searchParams.get("resource_kind") || "entity";
    const rid = url.searchParams.get("resource_id");
    if (!rid) return json({ ok: false, error: "resource_id_required" }, 400, cors);
    const rows = await listAcl(db, tenant, kind, rid);
    const marking = await getResourceMarking(db, tenant, kind, rid);
    return json({ ok: true, resource_kind: kind, resource_id: rid, marking, acl: rows }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/acl") {
    if (!auth.scopes?.includes("admin") && !auth.scopes?.includes("governance:admin"))
      return json({ ok: false, error: "forbidden", required_scope: "admin" }, 403, cors);
    const body = await readJson(request);
    if (!body?.resource_id || !body?.principal)
      return json({ ok: false, error: "resource_id_and_principal_required" }, 400, cors);
    const result = await grantAcl(db, tenant, {
      resource_kind: body.resource_kind || "entity",
      resource_id: String(body.resource_id),
      principal: String(body.principal),
      principal_kind: body.principal_kind || "actor",
      can_read: body.can_read !== false,
      can_write: Boolean(body.can_write),
      can_action: Boolean(body.can_action),
      can_share: Boolean(body.can_share),
      marking: body.marking || null
    });
    await audit(env, tenant, auth.actor, "security.acl.grant", body.resource_id, body);
    return json({ ok: true, ...result }, 201, cors);
  }

  // ---- Data markings ----
  if (method === "GET" && path === "/v1/security/markings") {
    const kind = url.searchParams.get("resource_kind") || "entity";
    const rid = url.searchParams.get("resource_id");
    if (rid) {
      const marking = await getResourceMarking(db, tenant, kind, rid);
      return json({ ok: true, resource_kind: kind, resource_id: rid, marking, catalog: MARKINGS }, 200, cors);
    }
    return json({ ok: true, catalog: MARKINGS, role_clearance: ROLE_CLEARANCE }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/markings") {
    if (!auth.scopes?.includes("admin") && !auth.scopes?.includes("governance:admin") && auth.role !== "compliance")
      return json({ ok: false, error: "forbidden" }, 403, cors);
    const body = await readJson(request);
    if (!body?.resource_id || !body?.marking)
      return json({ ok: false, error: "resource_id_and_marking_required" }, 400, cors);
    try {
      const result = await setResourceMarking(
        db, tenant, body.resource_kind || "entity", String(body.resource_id),
        body.marking, auth.actor
      );
      await audit(env, tenant, auth.actor, "security.marking.set", body.resource_id, result);
      return json({ ok: true, ...result }, 201, cors);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400, cors);
    }
  }

  // Access check (for clients / agents before acting)
  if (method === "POST" && path === "/v1/security/access/check") {
    const body = await readJson(request);
    const kind = body?.resource_kind || "entity";
    const rid = body?.resource_id;
    const perm = body?.permission || "read";
    if (!rid) return json({ ok: false, error: "resource_id_required" }, 400, cors);
    const result = await checkObjectAccess(db, auth, kind, rid, perm);
    return json({ ok: true, ...result, actor: auth.actor, role: auth.role, clearance: clearanceOf(auth) }, 200, cors);
  }

  if (method === "GET" && path === "/v1/security/policies") {
    const rows = await db.prepare(
      "SELECT id, name, kind, policy_json, active, created_at, updated_at FROM security_policies WHERE tenant = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(tenant).all();
    return json({
      ok: true, tenant, default_als: DEFAULT_ALS,
      policies: (rows.results || []).map((r) => {
        let policy = {}; try { policy = JSON.parse(r.policy_json); } catch {}
        return { ...r, policy };
      })
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/policies") {
    if (!auth.scopes?.includes("admin") && !auth.scopes?.includes("governance:admin"))
      return json({ ok: false, error: "forbidden", required_scope: "admin" }, 403, cors);
    const body = await readJson(request);
    const name = String(body?.name || "policy").slice(0, 120);
    const kind = String(body?.kind || "als").slice(0, 40);
    const policy = body?.policy || body?.policy_json || {};
    const id = slugId("pol"); const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO security_policies (id, tenant, name, kind, policy_json, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
    ).bind(id, tenant, name, kind, JSON.stringify(policy), now, now).run();
    await audit(env, tenant, auth.actor, "security.policy.create", id, { name, kind });
    return json({ ok: true, id, name, kind, policy }, 201, cors);
  }

  if (method === "POST" && path === "/v1/security/als/preview") {
    const body = await readJson(request);
    const sample = body?.object || body?.props || {
      name: "Jane Doe", email: "jane@acme.com", ssn: "123-45-6789", salary: 120000, department: "Ops"
    };
    const redacted = applyALS(auth, sample);
    return json({
      ok: true, role: auth.role || "viewer", original_keys: Object.keys(sample), redacted,
      deny_attributes: (DEFAULT_ALS[auth.role || "viewer"] || DEFAULT_ALS.viewer).deny_attributes
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/ols/preview") {
    const body = await readJson(request);
    const items = Array.isArray(body?.items) ? body.items : [];
    const filtered = applyOLS(auth, items, { ownerField: body?.owner_field });
    return json({ ok: true, input_count: items.length, output_count: filtered.length, items: filtered }, 200, cors);
  }

  if (method === "GET" && path === "/v1/security/sso") {
    const row = await db.prepare("SELECT * FROM sso_configs WHERE tenant = ? LIMIT 1").bind(tenant).first();
    if (!row) {
      return json({
        ok: true, configured: false,
        providers_supported: ["oidc", "azure_ad", "okta", "generic_jwt"],
        note: "PUT /v1/security/sso with issuer, client_id, audience, claim_map"
      }, 200, cors);
    }
    let claim_map = {}; try { claim_map = JSON.parse(row.claim_map || "{}"); } catch {}
    return json({
      ok: true, configured: true, provider: row.provider, issuer: row.issuer,
      client_id: row.client_id, audience: row.audience, jwks_uri: row.jwks_uri,
      claim_map, active: Boolean(row.active), updated_at: row.updated_at
    }, 200, cors);
  }

  if (method === "PUT" && path === "/v1/security/sso") {
    if (!auth.scopes?.includes("admin") && !auth.scopes?.includes("governance:admin"))
      return json({ ok: false, error: "forbidden" }, 403, cors);
    const body = await readJson(request);
    const provider = String(body?.provider || "oidc").slice(0, 40);
    const issuer = body?.issuer ? String(body.issuer).slice(0, 500) : null;
    const clientId = body?.client_id ? String(body.client_id).slice(0, 200) : null;
    const audience = body?.audience ? String(body.audience).slice(0, 200) : null;
    const jwksUri = body?.jwks_uri ? String(body.jwks_uri).slice(0, 500) : null;
    const claimMap = body?.claim_map || {};
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO sso_configs (tenant, provider, issuer, client_id, audience, jwks_uri, claim_map, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(tenant) DO UPDATE SET provider=excluded.provider, issuer=excluded.issuer, client_id=excluded.client_id,
        audience=excluded.audience, jwks_uri=excluded.jwks_uri, claim_map=excluded.claim_map, active=1, updated_at=excluded.updated_at`
    ).bind(tenant, provider, issuer, clientId, audience, jwksUri, JSON.stringify(claimMap), now).run();
    await audit(env, tenant, auth.actor, "security.sso.upsert", provider, { issuer, client_id: clientId });
    return json({ ok: true, tenant, provider, issuer, client_id: clientId, audience, claim_map: claimMap }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/sso/validate") {
    const body = await readJson(request);
    const token = body?.token || bearer(request);
    if (!token) return json({ ok: false, error: "token_required" }, 400, cors);
    if (!env.ASTON_JWT_SECRET)
      return json({ ok: false, error: "jwt_secret_not_configured", hint: "Set ASTON_JWT_SECRET" }, 501, cors);
    const payload = await verifyHs256Jwt(token, env.ASTON_JWT_SECRET);
    if (!payload) return json({ ok: false, error: "invalid_token" }, 401, cors);
    const row = await db.prepare("SELECT * FROM sso_configs WHERE tenant = ? AND active = 1 LIMIT 1").bind(tenant).first();
    let claimMap = {}; if (row?.claim_map) { try { claimMap = JSON.parse(row.claim_map); } catch {} }
    if (row?.issuer && payload.iss && payload.iss !== row.issuer)
      return json({ ok: false, error: "issuer_mismatch", expected: row.issuer, got: payload.iss }, 401, cors);
    if (row?.audience) {
      const aud = payload.aud;
      const okAud = Array.isArray(aud) ? aud.includes(row.audience) : aud === row.audience;
      if (aud && !okAud) return json({ ok: false, error: "audience_mismatch" }, 401, cors);
    }
    const mapped = mapSsoClaims(payload, claimMap);
    await audit(env, mapped.tenant, mapped.actor, "security.sso.validate", "jwt", { role: mapped.role });
    return json({ ok: true, auth: mapped }, 200, cors);
  }

  if (method === "GET" && path === "/v1/security/audit") {
    if (!auth.scopes?.includes("admin") && !auth.scopes?.includes("audit:read"))
      return json({ ok: false, error: "forbidden" }, 403, cors);
    const limit = Math.min(100, Number(url.searchParams.get("limit") || 30));
    const rows = await db.prepare(
      "SELECT id, actor, action, resource, detail, created_at FROM security_audit WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, audit: rows.results || [] }, 200, cors);
  }

  if (method === "POST" && path === "/v1/security/tenant/check") {
    const body = await readJson(request);
    const resourceTenant = String(body?.tenant || body?.resource_tenant || "");
    const allowed = enforceTenant(auth, resourceTenant);
    return json({
      ok: true, actor_tenant: auth.tenant, resource_tenant: resourceTenant,
      allowed, isolation: "strict_tenant_match"
    }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}

export { DEFAULT_ALS, checkObjectAccess, canClearance, redactByRole, MARKINGS };
