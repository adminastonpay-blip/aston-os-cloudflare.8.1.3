// ASTON OS — shared auth for Foundry / Ontology routes (Phase 1)

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

/**
 * Authenticate request.
 * - If ASTON_API_TOKEN is set: token must match (admin).
 * - Else (dev): any Bearer is accepted with X-Tenant / X-Aston-Actor.
 */
export async function authenticate(request, env) {
  const token = bearer(request);
  if (!token) return null;

  if (env.ASTON_API_TOKEN) {
    if (token !== env.ASTON_API_TOKEN) return null;
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      actor: request.headers.get("X-Aston-Actor") || "api-token",
      role: "admin",
      scopes: [
        "read",
        "write",
        "ai",
        "admin",
        "ontology:read",
        "ontology:write",
        "orchestrator:run",
        "cases:read",
        "cases:write",
        "audit:read",
        "governance:admin"
      ]
    };
  }

  // Dev / unconfigured secret: scoped operator, never silent admin
  return {
    tenant: request.headers.get("X-Tenant") || "default",
    actor: request.headers.get("X-Aston-Actor") || "bearer",
    role: "operator",
    scopes: ["read", "write", "ontology:read", "ontology:write", "cases:read", "cases:write"],
    dev_mode: true
  };
}

export function requireScope(auth, scope) {
  if (!auth) return false;
  if (auth.scopes?.includes("admin")) return true;
  return Boolean(auth.scopes?.includes(scope));
}
