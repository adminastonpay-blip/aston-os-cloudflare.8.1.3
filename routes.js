/**
 * ASTON OS routes — loaded only via dynamic import() from worker.js
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

  if (path.startsWith("/v1/billing")) return handleBilling(request, env, path, method, cors);
  if (path.startsWith("/v1/connectors")) return handleConnectors(request, env, path, method, cors);
  if (path.startsWith("/v1/security")) return handleSecurity(request, env, path, method, cors);
  if (path.startsWith("/v1/ai")) return handleAiRouter(request, env, path, method, cors);
  if (path.startsWith("/v1/twin")) return handleDecisionTwin(request, env, path, method, cors);
  if (path.startsWith("/v1/swarm")) return handleSwarm(request, env, path, method, cors);
  if (path.startsWith("/v1/predictive")) return handlePredictive(request, env, path, method, cors);
  if (path.startsWith("/v1/gov")) return handleAutoGov(request, env, path, method, cors);

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
