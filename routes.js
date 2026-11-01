/**
 * ASTON OS routes — loaded via dynamic import() from worker entry
 * Phase 1: Ontology + Foundry
 * Phase 2: AIP / orchestrator / cases / receipts
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
import { authenticate } from "./auth.js";

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

  // ---- Phase 1 + 2 authenticated surface ----
  if (
    path.startsWith("/v1/ontology") ||
    path.startsWith("/v1/foundry") ||
    path === "/v1/search" ||
    path.startsWith("/v1/orchestrator") ||
    path.startsWith("/v1/cases") ||
    path.startsWith("/v1/receipts") ||
    path.startsWith("/v1/aip")
  ) {
    const auth = await authenticate(request, env);
    if (!auth) {
      return json({ ok: false, error: "unauthorized", hint: "Authorization: Bearer <ASTON_API_TOKEN>" }, 401, cors);
    }
    if (path.startsWith("/v1/ontology")) return handleOntology(request, env, auth, cors);
    if (path.startsWith("/v1/orchestrator")) return handleOrchestrator(request, env, auth, cors);
    if (path.startsWith("/v1/cases")) return handleCases(request, env, auth, cors);
    if (path.startsWith("/v1/receipts")) return handleReceipts(request, env, auth, cors);
    if (path.startsWith("/v1/aip")) return handleAip(request, env, auth, cors);
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
        phase: "2-aip",
        version: "11.5.0",
        pillars: {
          ontology: true,
          foundry: true,
          aip: true,
          orchestrator: true,
          cases: true,
          receipts: true,
          security: true,
          connectors: true,
          ai: true
        },
        routes: {
          aip: [
            "GET /v1/aip/status",
            "POST /v1/aip/plan",
            "GET /v1/aip/plans",
            "POST /v1/aip/plans/:id/approve",
            "POST /v1/aip/plans/:id/reject",
            "POST /v1/aip/plans/:id/execute"
          ],
          orchestrator: [
            "GET /v1/orchestrator/roles",
            "POST /v1/orchestrator/run",
            "GET /v1/orchestrator/runs"
          ],
          cases: ["GET /v1/cases", "POST /v1/cases", "GET /v1/cases/playbooks"],
          receipts: ["GET /v1/receipts", "GET /v1/receipts/list", "POST /v1/receipts/verify"],
          ontology: ["GET /v1/ontology", "GET /v1/ontology/entities", "GET /v1/ontology/path"],
          foundry: ["GET /v1/foundry", "GET /v1/foundry/types", "GET /v1/search"]
        }
      },
      200,
      cors
    );
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
