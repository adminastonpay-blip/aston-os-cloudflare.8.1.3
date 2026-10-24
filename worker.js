/**
 * ASTON OS entry — Phase A Ontology + B Orchestrator + C Cases
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
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
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
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      scopes: ["read", "write", "ai", "admin"],
      actor: "api-token"
    };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
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
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return {
      tenant: String(payload.tenant || "default"),
      scopes,
      actor: String(payload.sub || "jwt")
    };
  } catch {
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-aston-os": "9.4.0",
      ...headers
    }
  });
}

function isMounted(path) {
  return (
    path.startsWith("/v1/ontology") ||
    path.startsWith("/v1/orchestrator") ||
    path.startsWith("/v1/cases")
  );
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
      const auth = await authorized(request, env, method === "GET" ? "read" : "write");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
      return handleOntology(request, env, auth, cors);
    }

    if (path.startsWith("/v1/orchestrator")) {
      const auth = await authorized(request, env, method === "GET" ? "read" : "ai");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
      return handleOrchestrator(request, env, auth, cors);
    }

    if (path.startsWith("/v1/cases")) {
      const auth = await authorized(request, env, method === "GET" ? "read" : "write");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
      return handleCases(request, env, auth, cors);
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
