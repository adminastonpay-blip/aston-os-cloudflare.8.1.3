/**
 * ASTON OS routes — loaded via dynamic import() from worker entry
 * Phase 1: Ontology + Foundry core re-wired
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

  // ---- Phase 1: Ontology + Foundry (auth required) ----
  if (
    path.startsWith("/v1/ontology") ||
    path.startsWith("/v1/foundry") ||
    path === "/v1/search"
  ) {
    const auth = await authenticate(request, env);
    if (!auth) {
      return json({ ok: false, error: "unauthorized", hint: "Authorization: Bearer <ASTON_API_TOKEN>" }, 401, cors);
    }
    if (path.startsWith("/v1/ontology")) {
      return handleOntology(request, env, auth, cors);
    }
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

  // Capability map for auditors / clients
  if (method === "GET" && path === "/v1/capabilities") {
    return json(
      {
        ok: true,
        phase: "1-ontology",
        version: "11.4.0",
        pillars: {
          ontology: true,
          foundry: true,
          security: true,
          connectors: true,
          ai: true
        },
        routes: {
          ontology: [
            "GET /v1/ontology/types",
            "GET /v1/ontology/entities",
            "GET /v1/ontology/entities/:id",
            "POST /v1/ontology/entities",
            "POST /v1/ontology/relations",
            "GET /v1/ontology/query",
            "GET /v1/ontology/neighbors",
            "GET /v1/ontology/path",
            "POST /v1/ontology/extract"
          ],
          foundry: [
            "GET /v1/foundry",
            "GET /v1/foundry/types",
            "GET /v1/foundry/search",
            "GET /v1/foundry/objects/:id",
            "POST /v1/foundry/objects/:id",
            "GET|POST /v1/foundry/actions",
            "GET|POST /v1/foundry/approvals"
          ],
          search: ["GET /v1/search?q="]
        }
      },
      200,
      cors
    );
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
