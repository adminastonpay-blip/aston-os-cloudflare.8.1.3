/**
 * ASTON OS routes — Phases 1–10
 */
import { handleUI } from "./ui.js";
import { handleConnectors } from "./connectors.js";
import { handleSecurity } from "./security.js";
import { handleAiRouter } from "./ai_router.js";
import { handleDecisionTwin } from "./decision_twin.js";
import { handleSwarm } from "./swarm.js";
import { handlePredictive } from "./predictive.js";
import { handleAutoGov } from "./auto_gov.js";
import { handleBilling } from "./billing.js";
import { handleSovereign, sovereignGate } from "./sovereign_dna.js";
import { handleAstonNative } from "./aston_native.js";
import { handleOntology } from "./ontology.js";
import { handleFoundry } from "./foundry.js";
import { handleOrchestrator } from "./orchestrator.js";
import { handleCases } from "./cases.js";
import { handleReceipts } from "./receipts.js";
import { handleAip } from "./aip.js";
import { handlePipelines } from "./pipelines.js";
import { authenticate } from "./auth.js";
import { checkTenantRateLimit, rateLimitResponse, handleRateLimitStatus } from "./rate_limit.js";
import { handleMetrics, recordMetric } from "./metrics.js";
import { handleLineageAudit } from "./lineage_audit.js";
import { handleEventsFeed } from "./events_feed.js";

export async function handleRequest(request, env, ctx, path, method, cors, json) {
  const locked = await sovereignGate(request, env, path, cors);
  if (locked) return locked;

  if (path.startsWith("/v1/sovereign")) return handleSovereign(request, env, path, method, cors);
  if (path.startsWith("/v1/native")) return handleAstonNative(request, env, path, method, cors);

  if (
    method === "GET" &&
    (path === "/ui" || path === "/ui/studio" || path === "/v1/ui" || path === "/v1/ui/studio")
  ) {
    const res = handleUI(request, env, path);
    if (res) {
      if (ctx?.waitUntil) {
        ctx.waitUntil(recordMetric(env, { tenant: "public", path, method, status: 200, ms: 0 }));
      }
      return res;
    }
  }

  if (
    path.startsWith("/v1/ontology") ||
    path.startsWith("/v1/foundry") ||
    path === "/v1/search" ||
    path.startsWith("/v1/orchestrator") ||
    path.startsWith("/v1/cases") ||
    path.startsWith("/v1/receipts") ||
    path.startsWith("/v1/aip") ||
    path.startsWith("/v1/pipelines") ||
    path.startsWith("/v1/ops") ||
    path.startsWith("/v1/metrics") ||
    path.startsWith("/v1/lineage") ||
    path.startsWith("/v1/audit") ||
    path.startsWith("/v1/events") ||
    path.startsWith("/v1/webhooks")
  ) {
    const auth = await authenticate(request, env);
    if (!auth) {
      return json({ ok: false, error: "unauthorized", hint: "Authorization: Bearer <ASTON_API_TOKEN>" }, 401, cors);
    }

    const skipRl =
      method === "GET" &&
      (path === "/v1/ops/rate-limit" ||
        path.startsWith("/v1/metrics") ||
        path.startsWith("/v1/lineage") ||
        path.startsWith("/v1/audit") ||
        path.startsWith("/v1/events/feed") ||
        path === "/v1/ontology/stats");
    if (!skipRl) {
      const rl = await checkTenantRateLimit(request, env, auth.tenant);
      if (!rl.allowed) return rateLimitResponse(rl, cors, json);
    }

    const t0 = Date.now();
    let response;

    if (path.startsWith("/v1/events") || path.startsWith("/v1/webhooks")) {
      response = await handleEventsFeed(request, env, auth, cors);
    } else if (path.startsWith("/v1/lineage") || path.startsWith("/v1/audit")) {
      response = await handleLineageAudit(request, env, auth, cors);
    } else if (path.startsWith("/v1/metrics")) {
      response = await handleMetrics(request, env, auth, cors);
    } else if (path.startsWith("/v1/ops")) {
      if (method === "GET" && (path === "/v1/ops/rate-limit" || path === "/v1/ops/status")) {
        response = await handleRateLimitStatus(request, env, auth, cors, json);
      } else {
        response = json({ ok: true, phase: "6-ops" }, 200, cors);
      }
    } else if (path.startsWith("/v1/ontology")) {
      response = await handleOntology(request, env, auth, cors);
    } else if (path.startsWith("/v1/orchestrator")) {
      response = await handleOrchestrator(request, env, auth, cors);
    } else if (path.startsWith("/v1/cases")) {
      response = await handleCases(request, env, auth, cors);
    } else if (path.startsWith("/v1/receipts")) {
      response = await handleReceipts(request, env, auth, cors);
    } else if (path.startsWith("/v1/aip")) {
      response = await handleAip(request, env, auth, cors);
    } else if (path.startsWith("/v1/pipelines")) {
      response = await handlePipelines(request, env, auth, cors);
    } else {
      response = await handleFoundry(request, env, auth, cors);
    }

    const ms = Date.now() - t0;
    const status = response?.status || 200;
    if (ctx?.waitUntil) {
      ctx.waitUntil(recordMetric(env, { tenant: auth.tenant, path, method, status, ms, actor: auth.actor }));
    } else {
      await recordMetric(env, { tenant: auth.tenant, path, method, status, ms, actor: auth.actor });
    }

    try {
      const headers = new Headers(response.headers);
      headers.set("x-aston-ms", String(ms));
      headers.set("x-aston-tenant", auth.tenant);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return response;
    }
  }

  if (path.startsWith("/v1/billing")) return handleBilling(request, env, path, method, cors);
  if (path.startsWith("/v1/connectors")) return handleConnectors(request, env, path, method, cors);
  if (path.startsWith("/v1/security")) return handleSecurity(request, env, path, method, cors);
  if (path.startsWith("/v1/ai")) return handleAiRouter(request, env, path, method, cors);
  if (path.startsWith("/v1/twin")) return handleDecisionTwin(request, env, path, method, cors);
  if (path.startsWith("/v1/swarm")) return handleSwarm(request, env, path, method, cors);
  if (path.startsWith("/v1/predictive")) return handlePredictive(request, env, path, method, cors);
  if (path.startsWith("/v1/gov")) return handleAutoGov(request, env, path, method, cors);

  if (method === "GET" && path === "/v1/capabilities") {
    return json(
      {
        ok: true,
        phase: "10-graph-intel",
        version: "12.3.0",
        pillars: {
          ontology: true,
          graph: true,
          foundry: true,
          aip: true,
          security: true,
          pipelines: true,
          metrics: true,
          lineage: true,
          webhooks: true,
          change_feed: true,
          auto_emit: true,
          ui: true
        },
        routes: {
          graph: [
            "GET /v1/ontology/entities/:id/neighbors",
            "GET /v1/ontology/path?from=&to=",
            "GET /v1/ontology/subgraph?id=",
            "GET /v1/ontology/stats"
          ],
          events: ["GET /v1/events/feed", "POST /v1/events/emit"],
          webhooks: ["GET|POST /v1/webhooks", "POST /v1/webhooks/:id/test"],
          audit: ["POST /v1/audit/export"],
          metrics: ["GET /v1/metrics/summary"]
        }
      },
      200,
      cors
    );
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
