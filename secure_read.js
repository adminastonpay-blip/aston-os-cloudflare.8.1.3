// ASTON OS — Phase 3.1 server-side ACL / marking enforcement helpers

import {
  ensureObjectAclSchema,
  checkObjectAccess,
  redactByRole
} from "./object_acl.js";
import { DEFAULT_ALS } from "./security.js";

/**
 * Filter a list of entities (must have .id) for the current auth.
 * Returns { entities, denied, markings }
 */
export async function filterEntitiesByAcl(env, auth, entities, resource_kind = "entity") {
  if (!env?.ASTON_DB || !auth || !Array.isArray(entities)) {
    return { entities: entities || [], denied: 0, markings: {} };
  }
  try {
    await ensureObjectAclSchema(env.ASTON_DB);
  } catch (_) {}

  const out = [];
  const markings = {};
  let denied = 0;
  for (const ent of entities) {
    if (!ent?.id) continue;
    const access = await checkObjectAccess(env.ASTON_DB, auth, resource_kind, ent.id, "read");
    if (!access.allowed) {
      denied++;
      continue;
    }
    markings[ent.id] = access.marking || "INTERNAL";
    const cleaned = {
      ...ent,
      props: redactByRole(auth, ent.props || {}, DEFAULT_ALS),
      _marking: access.marking || "INTERNAL"
    };
    out.push(cleaned);
  }
  return { entities: out, denied, markings };
}

/** Single entity gate — returns null if denied */
export async function gateEntityRead(env, auth, entity, resource_kind = "entity") {
  if (!entity?.id) return null;
  if (!env?.ASTON_DB) return entity;
  try {
    await ensureObjectAclSchema(env.ASTON_DB);
  } catch (_) {}
  const access = await checkObjectAccess(env.ASTON_DB, auth, resource_kind, entity.id, "read");
  if (!access.allowed) return null;
  return {
    ...entity,
    props: redactByRole(auth, entity.props || {}, DEFAULT_ALS),
    _marking: access.marking || "INTERNAL",
    _access: access.reason
  };
}

/** Write/action gate */
export async function gateEntityWrite(env, auth, resource_id, perm = "write", resource_kind = "entity") {
  if (!env?.ASTON_DB || !resource_id) return { allowed: true, reason: "no_db" };
  try {
    await ensureObjectAclSchema(env.ASTON_DB);
  } catch (_) {}
  return checkObjectAccess(env.ASTON_DB, auth, resource_kind, resource_id, perm);
}
