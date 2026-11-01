// ASTON OS — Phase 3 Object-Level Security + Data Markings
// Palantir-style OLS (row) + ALS (attribute) + classification markings

export const MARKINGS = {
  PUBLIC: { id: "PUBLIC", rank: 0, label: "Public" },
  INTERNAL: { id: "INTERNAL", rank: 10, label: "Internal" },
  CONFIDENTIAL: { id: "CONFIDENTIAL", rank: 20, label: "Confidential" },
  RESTRICTED: { id: "RESTRICTED", rank: 30, label: "Restricted" },
  SECRET: { id: "SECRET", rank: 40, label: "Secret" }
};

export const ROLE_CLEARANCE = {
  viewer: 10, // INTERNAL
  operator: 20, // CONFIDENTIAL
  compliance: 30, // RESTRICTED
  admin: 40 // SECRET
};

export async function ensureObjectAclSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS object_acl (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      principal_kind TEXT NOT NULL DEFAULT 'actor',
      can_read INTEGER NOT NULL DEFAULT 1,
      can_write INTEGER NOT NULL DEFAULT 0,
      can_action INTEGER NOT NULL DEFAULT 0,
      can_share INTEGER NOT NULL DEFAULT 0,
      marking TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_obj_acl_res ON object_acl (tenant, resource_kind, resource_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_obj_acl_prin ON object_acl (tenant, principal)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_acl_uniq ON object_acl (tenant, resource_kind, resource_id, principal)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS data_markings (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      marking TEXT NOT NULL,
      set_by TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_mark_res ON data_markings (tenant, resource_kind, resource_id)")
  ]);
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export function clearanceOf(auth) {
  if (!auth) return 0;
  if (auth.clearance != null) return Number(auth.clearance);
  if (auth.scopes?.includes("admin")) return ROLE_CLEARANCE.admin;
  return ROLE_CLEARANCE[auth.role] ?? ROLE_CLEARANCE.viewer;
}

export function markingRank(marking) {
  if (!marking) return MARKINGS.INTERNAL.rank;
  const m = MARKINGS[String(marking).toUpperCase()];
  return m ? m.rank : MARKINGS.INTERNAL.rank;
}

/** Can this auth read a resource with this marking? */
export function canClearance(auth, marking) {
  return clearanceOf(auth) >= markingRank(marking);
}

export async function getResourceMarking(db, tenant, resource_kind, resource_id) {
  const row = await db.prepare(
    "SELECT marking FROM data_markings WHERE tenant = ? AND resource_kind = ? AND resource_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(tenant, resource_kind, resource_id).first();
  return row?.marking || "INTERNAL";
}

export async function setResourceMarking(db, tenant, resource_kind, resource_id, marking, actor) {
  const m = String(marking || "INTERNAL").toUpperCase();
  if (!MARKINGS[m]) throw new Error("invalid_marking");
  const id = slugId("mark");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO data_markings (id, tenant, resource_kind, resource_id, marking, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tenant, resource_kind, resource_id, m, actor || "system", now).run();
  return { id, marking: m };
}

export async function grantAcl(db, tenant, {
  resource_kind, resource_id, principal, principal_kind = "actor",
  can_read = 1, can_write = 0, can_action = 0, can_share = 0, marking = null
}) {
  const id = slugId("acl");
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO object_acl (id, tenant, resource_kind, resource_id, principal, principal_kind,
      can_read, can_write, can_action, can_share, marking, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant, resource_kind, resource_id, principal) DO UPDATE SET
       can_read=excluded.can_read, can_write=excluded.can_write, can_action=excluded.can_action,
       can_share=excluded.can_share, marking=excluded.marking, updated_at=excluded.updated_at`
  ).bind(
    id, tenant, resource_kind, resource_id, String(principal), principal_kind,
    can_read ? 1 : 0, can_write ? 1 : 0, can_action ? 1 : 0, can_share ? 1 : 0,
    marking, now, now
  ).run();
  return { ok: true, principal, resource_id };
}

export async function listAcl(db, tenant, resource_kind, resource_id) {
  const rows = await db.prepare(
    "SELECT id, principal, principal_kind, can_read, can_write, can_action, can_share, marking, updated_at FROM object_acl WHERE tenant = ? AND resource_kind = ? AND resource_id = ?"
  ).bind(tenant, resource_kind, resource_id).all();
  return rows.results || [];
}

/**
 * Check object access.
 * Admin always passes.
 * If no ACL rows exist → open within tenant (backward compatible) but marking still applies.
 * If ACL rows exist → principal must match with required permission.
 */
export async function checkObjectAccess(db, auth, resource_kind, resource_id, perm = "read") {
  if (!auth) return { allowed: false, reason: "no_auth" };
  if (auth.scopes?.includes("admin") || auth.role === "admin") {
    return { allowed: true, reason: "admin", marking: await getResourceMarking(db, auth.tenant, resource_kind, resource_id) };
  }

  const marking = await getResourceMarking(db, auth.tenant, resource_kind, resource_id);
  if (!canClearance(auth, marking)) {
    return { allowed: false, reason: "clearance_denied", marking, clearance: clearanceOf(auth) };
  }

  const acls = await listAcl(db, auth.tenant, resource_kind, resource_id);
  if (!acls.length) {
    // No explicit ACL: tenant isolation + marking only
    return { allowed: true, reason: "tenant_default", marking };
  }

  const principals = new Set([
    auth.actor,
    `role:${auth.role || "viewer"}`,
    "*"
  ]);
  const hits = acls.filter((a) => principals.has(a.principal));
  if (!hits.length) return { allowed: false, reason: "acl_deny", marking };

  const field = perm === "write" ? "can_write" : perm === "action" ? "can_action" : perm === "share" ? "can_share" : "can_read";
  const ok = hits.some((h) => Number(h[field]) === 1);
  return { allowed: ok, reason: ok ? "acl_allow" : "acl_perm_deny", marking, hits };
}

/** Apply ALS redaction using security DEFAULT_ALS if available */
export function redactByRole(auth, obj, alsMap) {
  if (!obj || typeof obj !== "object") return obj;
  const role = auth?.role || (auth?.scopes?.includes("admin") ? "admin" : "viewer");
  const als = alsMap?.[role] || alsMap?.viewer;
  if (!als?.deny_attributes?.length) return obj;
  const deny = new Set(als.deny_attributes.map((s) => String(s).toLowerCase()));
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
