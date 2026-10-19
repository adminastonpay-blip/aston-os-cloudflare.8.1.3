/**
 * Anti-Gap Phase 6 — RAG / knowledge routes
 */

import {
  ingestDocument,
  searchKnowledge,
  listDocuments,
  deleteDocument
} from "./rag.js";
import { recordRoiEvent } from "./roi.js";

export const PHASE6_VERSION = "8.12.3-p6";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE6_VERSION
  };
  if (allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  else if (origin) headers["access-control-allow-origin"] = origin;
  else headers["access-control-allow-origin"] = "*";
  return headers;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request, env)
  });
}

async function authorized(request, env, scope = "read") {
  const value = request.headers.get("Authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
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
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
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

export async function tryHandlePhase6(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P6 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "POST" && path === "/v1/kb/ingest") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const started = Date.now();
    const result = await ingestDocument(env, auth.tenant, body);
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: auth.tenant,
          route: "/v1/kb/ingest",
          latency_ms: Date.now() - started,
          outcome: result.ok ? "ok" : "error"
        }).catch(() => {})
      );
    }
    return json(
      { ...result, anti_gap: { phase: 6, version: PHASE6_VERSION } },
      result.ok ? 201 : 400,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/kb/search") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const result = await searchKnowledge(env, auth.tenant, body.query || body.q, body.top_k || body.topK);
    return json(
      { ...result, anti_gap: { phase: 6, version: PHASE6_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/kb/search") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const q = url.searchParams.get("q") || url.searchParams.get("query");
    const topK = url.searchParams.get("top_k") || 5;
    const result = await searchKnowledge(env, auth.tenant, q, topK);
    return json(
      { ...result, anti_gap: { phase: 6, version: PHASE6_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/kb/docs") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const result = await listDocuments(env, auth.tenant);
    return json(
      { ...result, anti_gap: { phase: 6, version: PHASE6_VERSION } },
      result.ok ? 200 : 503,
      request,
      env
    );
  }

  if (method === "DELETE" && path.startsWith("/v1/kb/docs/")) {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const docId = path.slice("/v1/kb/docs/".length);
    const result = await deleteDocument(env, auth.tenant, docId);
    return json(
      { ...result, anti_gap: { phase: 6, version: PHASE6_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase6(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 6);
  result.anti_gap.version = PHASE6_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "rag_ingest",
    "rag_search",
    "knowledge_base"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p6_enabled = env.ANTI_GAP_P6 !== "false";
  result.anti_gap.vectorize = Boolean(env.ASTON_VECTORIZE);
  return result;
}
