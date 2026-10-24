/**
 * ASTON OS entry — Phases A–J (UI Dashboard)
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
import { handleReceipts } from "./receipts.js";
import { handleMetrics, recordLatency } from "./metrics.js";
import { handleUI } from "./ui.js";

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
      "x-aston-os": "10.3.0",
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
    path.startsWith("/v1/search") ||
    path.startsWith("/v1/receipts") ||
    path.startsWith("/v1/metrics")
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
  if (path.startsWith("/v1/receipts")) {
    return method === "GET" ? ["read", "audit:read", "admin"] : ["write", "ai", "admin"];
  }
  if (path.startsWith("/v1/metrics")) {
    return ["read", "admin"];
  }
  return null;
}

function routeKey(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 3).join(".");
  return path || "root";
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

async function timed(env, auth, path, colo, handler) {
  const t0 = Date.now();
  try {
    const res = await handler();
    const ok = res.status < 500;
    const ms = Date.now() - t0;
    const headers = new Headers(res.headers);
    headers.set("x-aston-ms", String(ms));
    headers.set("server-timing", `app;dur=${ms}`);
    headers.set("x-aston-os", "10.3.0");
    await recordLatency(env, {
      tenant: auth?.tenant || "default",
      route: routeKey(path),
      ms,
      ok,
      colo
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    const ms = Date.now() - t0;
    await recordLatency(env, {
      tenant: auth?.tenant || "default",
      route: routeKey(path),
      ms,
      ok: false,
      colo
    });
    throw e;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);
    const colo = request.cf?.colo || null;

    // Public UI shell (API calls still require token in the page)
    if (method === "GET" && (path === "/ui" || path === "/v1/ui")) {
      const ui = handleUI(request, env, path);
      if (ui) return ui;
    }

    if (method === "OPTIONS" && isMounted(path)) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path.startsWith("/v1/metrics")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleMetrics(request, env, g.auth, cors, request.cf));
    }

    if (path.startsWith("/v1/ontology")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleOntology(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/orchestrator")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleOrchestrator(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/cases")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleCases(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/governance")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleGovernance(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/fusion")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleFusion(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/foundry") || path.startsWith("/v1/search")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleFoundry(request, env, g.auth, cors));
    }

    if (path.startsWith("/v1/receipts")) {
      const g = await gate(request, env, path, method, cors);
      if (g.error) return g.error;
      return timed(env, g.auth, path, colo, () => handleReceipts(request, env, g.auth, cors));
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
