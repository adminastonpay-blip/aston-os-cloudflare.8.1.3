/**
 * ASTON OS entry — Phases A–G (Foundry core on Worker)
 */
import core, {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession
} from "./index.js";
import { handleOntology, AstonOntology } from "./ontology.js";
import { handleOrchestrator, AstonOrchestrator } from "./orchestrator.js";
import { handleCases } from "./cases.js";
import {
  handleGovernance,
  enrichAuth,
  hasScope,
  scopeForPath
} from "./governance.js";
import { handleFusion } from "./fusion.js";
import { handleFoundry } from "./foundry.js";

export {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession,
  AstonOntology,
  AstonOrchestrator
};

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant,X-Aston-Actor,X-Shopify-Topic,X-Shopify-Hmac-Sha256",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  if (allowed) {
    if (origin === allowed) headers["access-control-allow-origin"] = origin;
  } else if (origin) {
    headers["access-control-allow-origin"] = origin;
  } else {
    headers["access-control-allow-origin"] = "*";
  }
  return headers;
}

async function authorized(request, env, scope = "read") {
  const token = bearer(request);
  if (!token) return null;
  let auth = null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    auth = {
      tenant: request.headers.get("X-Tenant") || "default",
      scopes: ["read", "write", "ai", "admin"],
      actor: request.headers.get("X-Aston-Actor") || request.headers.get("X-Actor") || "api-token"
    };
  } else if (env.ASTON_JWT_SECRET) {
    const parts = token.split(".");
    if (parts.length === 3) {
      try {
        const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
        const header = decode(parts[0]);
        const payload = decode(parts[1]);
        if (header.alg === "HS256" && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(env.ASTON_JWT_SECRET),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"]
          );
          const signature = Uint8Array.from(
            atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0)
          );
          const valid = await crypto.subtle.verify(
            "HMAC",
            key,
            signature,
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
          );
          if (valid) {
            auth = {
              tenant: String(payload.tenant || "default"),
              scopes: Array.isArray(payload.scopes) ? payload.scopes : ["read"],
              actor: String(payload.sub || "jwt")
            };
          }
        }
      } catch {
        auth = null;
      }
    }
  }
  if (!auth) return null;
  auth = await enrichAuth(env, auth);
  if (scope && !hasScope(auth, scope) && !hasScope(auth, "admin")) {
    if (!["read", "write", "ai", "admin"].includes(scope)) return null;
  }
  return auth;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-aston-os": "10.0.0",
      ...headers
    }
  });
}

function isMounted(path) {
  return (
    path.startsWith("/v1/ontology") ||
    path.startsWith("/v1/orchestrator") ||
    path.startsWith("/v1/cases") ||
    path.startsWith("/v1/governance") ||
    path.startsWith("/v1/fusion") ||
    path.startsWith("/v1/foundry") ||
    path.startsWith("/v1/search")
  );
}

function routeScope(path, method) {
  if (path.startsWith("/v1/fusion")) {
    return method === "GET" ? ["read", "admin"] : ["write", "admin"];
  }
  if (path.startsWith("/v1/foundry") || path.startsWith("/v1/search")) {
    if (path.includes("/approvals") && method === "POST") return ["admin", "write"];
    return method === "GET" ? ["read", "admin"] : ["write", "admin"];
  }
  return null;
}

async function gate(request, env, path, method, cors, scopeOverride) {
  const auth = await authorized(request, env, "read");
  if (!auth) return { error: json({ ok: false, error: "unauthorized" }, 401, cors) };
  const needed = scopeOverride || routeScope(path, method) || scopeForPath(path, method);
  if (!hasScope(auth, needed)) {
    return {
      error: json({
        ok: false,
        error: "forbidden",
        required_scope: needed,
        actor_scopes: auth.scopes
      }, 403, cors)
    };
  }
  return { auth };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);

    if (method === "OPTIONS" && isMounted(path)) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path.startsWith("/v1/ontology")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleOntology(request, env, g.auth, cors);
    }

    if (path.startsWith("/v1/orchestrator")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleOrchestrator(request, env, g.auth, cors);
    }

    if (path.startsWith("/v1/cases")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleCases(request, env, g.auth, cors);
    }

    if (path.startsWith("/v1/governance")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleGovernance(request, env, g.auth, cors);
    }

    if (path.startsWith("/v1/fusion")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleFusion(request, env, g.auth, cors);
    }

    if (path.startsWith("/v1/foundry") || path.startsWith("/v1/search")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return handleFoundry(request, env, g.auth, cors);
    }

    return core.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof core.scheduled === "function") {
      return core.scheduled(controller, env, ctx);
    }
  },

  async queue(batch, env, ctx) {
    if (typeof core.queue === "function") {
      return core.queue(batch, env, ctx);
    }
  }
};
