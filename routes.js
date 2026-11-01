/**
 * ASTON OS routes
 * Phases 1–6: Ontology · AIP · Security · Pipelines · Foundry ACL · Ops UI
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
    if (res) return res;
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
    path.startsWith("/v1/ops")
  ) {
    const auth = await authenticate(request, env);
    if (!auth) {
      return json({ ok: false, error: "unauthorized", hint: "Authorization: Bearer <ASTON_API_TOKEN>" }, 401, cors);
    }

    // Phase 6: tenant rate limit (skip status endpoint counting soft)
    if (!(method === "GET" && path === "/v1/ops/rate-limit")) {
      const rl = await checkTenantRateLimit(request, env, auth.tenant);
      if (!rl.allowed) return rateLimitResponse(rl, cors, json);
    }

    if (path.startsWith("/v1/ops")) {
      if (method === "GET" && (path === "/v1/ops/rate-limit" || path === "/v1/ops/status")) {
        return handleRateLimitStatus(request, env, auth, cors, json);
      }
      return json({
        ok: true,
        phase: "6-ops",
        endpoints: ["GET /v1/ops/rate-limit", "GET /v1/ops/status"]
      }, 200, cors);
    }

    if (path.startsWith("/v1/ontology")) return handleOntology(request, env, auth, cors);
    if (path.startsWith("/v1/orchestrator")) return handleOrchestrator(request, env, auth, cors);
    if (path.startsWith("/v1/cases")) return handleCases(request, env, auth, cors);
    if (path.startsWith("/v1/receipts")) return handleReceipts(request, env, auth, cors);
    if (path.startsWith("/v1/aip")) return handleAip(request, env, auth, cors);
    if (path.startsWith("/v1/pipelines")) return handlePipelines(request, env, auth, cors);
    return handleFoundry(request, env, auth, cors);
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
        phase: "6-ops-ui",
        version: "11.9.0",
        pillars: {
          ontology: true,
          foundry: true,
          aip: true,
          security: true,
          pipelines: true,
          rate_limit: true,
          ui: true,
          connectors: true,
          ai: true
        },
        routes: {
          ui: ["GET /ui", "GET /ui/studio"],
          ops: ["GET /v1/ops/rate-limit"],
          pipelines: ["POST /v1/pipelines/run"],
          security: ["GET /v1/security/status"],
          aip: ["POST /v1/aip/plan"],
          ontology: ["GET /v1/ontology/entities"],
          foundry: ["GET /v1/foundry", "GET /v1/search"]
        }
      },
      200,
      cors
    );
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
