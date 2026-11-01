// ASTON OS — shared auth (Phase 1–3)
// Bearer + optional role/clearance headers for OLS

import { ROLE_CLEARANCE } from "./object_acl.js";

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

const ROLE_SCOPES = {
  viewer: ["read", "ontology:read", "cases:read", "audit:read"],
  operator: [
    "read", "write", "ai", "ontology:read", "ontology:write",
    "orchestrator:run", "cases:read", "cases:write", "audit:read"
  ],
  compliance: [
    "read", "ai", "ontology:read", "cases:read", "cases:write",
    "audit:read", "audit:export"
  ],
  admin: [
    "read", "write", "ai", "admin", "ontology:read", "ontology:write",
    "orchestrator:run", "cases:read", "cases:write", "ledger:write",
    "audit:read", "audit:export", "governance:admin"
  ]
};

/**
 * Authenticate request.
 * Headers: Authorization, X-Tenant, X-Aston-Actor, X-Aston-Role (optional when using API token)
 */
export async function authenticate(request, env) {
  const token = bearer(request);
  if (!token) return null;

  const headerRole = String(request.headers.get("X-Aston-Role") || "").toLowerCase();
  const roleFromHeader = ["viewer", "operator", "compliance", "admin"].includes(headerRole)
    ? headerRole
    : null;

  if (env.ASTON_API_TOKEN) {
    if (token !== env.ASTON_API_TOKEN) return null;
    // API token defaults to admin; can downscope via X-Aston-Role for testing OLS
    const role = roleFromHeader || "admin";
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      actor: request.headers.get("X-Aston-Actor") || "api-token",
      role,
      clearance: ROLE_CLEARANCE[role] ?? ROLE_CLEARANCE.admin,
      scopes: ROLE_SCOPES[role] || ROLE_SCOPES.admin
    };
  }

  const role = roleFromHeader || "operator";
  return {
    tenant: request.headers.get("X-Tenant") || "default",
    actor: request.headers.get("X-Aston-Actor") || "bearer",
    role,
    clearance: ROLE_CLEARANCE[role] ?? ROLE_CLEARANCE.operator,
    scopes: ROLE_SCOPES[role] || ROLE_SCOPES.operator,
    dev_mode: true
  };
}

export function requireScope(auth, scope) {
  if (!auth) return false;
  if (auth.scopes?.includes("admin")) return true;
  return Boolean(auth.scopes?.includes(scope));
}
