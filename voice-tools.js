// ASTON OS — Phase E Voice tool bridge
// Gives the realtime voice agent live context from ontology, cases, orchestrator

import { ontologyToolSearch, ontologyToolTraverse } from "./ontology.js";

function wantsOntology(text) {
  return /\b(ontolog|entidad|entidades|grafo|quién es|quien es|quién|quien|empresa|organización|organizacion|supplier|proveedor|cuenta|account|pedido|order)\b/i.test(text);
}

function wantsCases(text) {
  return /\b(caso|casos|case|playbook|incidente|ticket|auditoría|auditoria|riesgo|risk|estado del caso)\b/i.test(text);
}

function wantsOrchestrator(text) {
  return /\b(orquest|multi.?agent|analiza en profundidad|investigar a fondo|plan completo|compliance completo)\b/i.test(text);
}

function wantsStats(text) {
  return /\b(cuántos|cuantos|stats|resumen|cuántas|cuantas|total de registros)\b/i.test(text);
}

async function listOpenCases(env, tenant, limit = 5) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  try {
    const rows = await env.ASTON_DB.prepare(
      "SELECT id, title, playbook, status, priority, updated_at FROM cases WHERE tenant = ? AND status NOT IN ('closed','cancelled','resolved') ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return { cases: rows.results || [] };
  } catch (e) {
    // table may not exist yet
    return { cases: [], note: String(e?.message || e).slice(0, 120) };
  }
}

async function quickStats(env, tenant) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  try {
    const records = await env.ASTON_DB.prepare("SELECT COUNT(*) AS c FROM records WHERE tenant = ?").bind(tenant).first();
    let entities = 0;
    try {
      const e = await env.ASTON_DB.prepare("SELECT COUNT(*) AS c FROM ontology_entities WHERE tenant = ?").bind(tenant).first();
      entities = e?.c || 0;
    } catch (_) {}
    let cases = 0;
    try {
      const c = await env.ASTON_DB.prepare("SELECT COUNT(*) AS c FROM cases WHERE tenant = ?").bind(tenant).first();
      cases = c?.c || 0;
    } catch (_) {}
    return { records: records?.c || 0, ontology_entities: entities, cases };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Build a short tool context string for the voice LLM turn.
 * @returns {{ context: string, tools_used: string[] }}
 */
export async function buildVoiceToolContext(env, { tenant, text, enable_orchestrator = false }) {
  const tools_used = [];
  const chunks = [];
  const t = String(text || "");
  const ten = tenant || "default";

  if (wantsStats(t) || (!wantsOntology(t) && !wantsCases(t))) {
    // light default: stats when user asks counts, or always small stats if ontology/cases not requested
    if (wantsStats(t)) {
      const stats = await quickStats(env, ten);
      tools_used.push("stats");
      chunks.push("STATS: " + JSON.stringify(stats));
    }
  }

  if (wantsOntology(t)) {
    tools_used.push("ontology_search");
    try {
      const found = await ontologyToolSearch(env, ten, t.slice(0, 200), 6);
      chunks.push("ONTOLOGY_SEARCH: " + JSON.stringify(found).slice(0, 1500));
      const firstId = found?.entities?.[0]?.id;
      if (firstId) {
        tools_used.push("ontology_traverse");
        const graph = await ontologyToolTraverse(env, ten, firstId, 1);
        chunks.push("ONTOLOGY_GRAPH: " + JSON.stringify({
          root: graph.root,
          entities: (graph.entities || []).slice(0, 8),
          relations: (graph.relations || []).slice(0, 12)
        }).slice(0, 1500));
      }
    } catch (e) {
      chunks.push("ONTOLOGY_ERROR: " + String(e?.message || e).slice(0, 200));
    }
  }

  if (wantsCases(t)) {
    tools_used.push("cases_list");
    const cases = await listOpenCases(env, ten, 5);
    chunks.push("OPEN_CASES: " + JSON.stringify(cases).slice(0, 1500));
  }

  // Orchestrator is heavier — only if explicitly enabled in session config or strong intent
  if (enable_orchestrator && wantsOrchestrator(t) && env.AI) {
    tools_used.push("orchestrator_run");
    try {
      const { handleOrchestrator } = await import("./orchestrator.js");
      const auth = { tenant: ten, actor: "voice", scopes: ["ai", "orchestrator:run", "admin"] };
      const req = new Request("https://voice.internal/v1/orchestrator/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: t.slice(0, 500),
          max_roles: 2,
          store_artifact: false
        })
      });
      const res = await handleOrchestrator(req, env, auth, {});
      const data = await res.json().catch(() => null);
      chunks.push("ORCHESTRATOR: " + JSON.stringify({
        run_id: data?.run_id,
        roles: data?.roles,
        result: String(data?.result || data?.error || "").slice(0, 1200)
      }));
    } catch (e) {
      chunks.push("ORCHESTRATOR_ERROR: " + String(e?.message || e).slice(0, 200));
    }
  }

  // If nothing matched but user seems to ask a factual platform question, still try ontology lightly
  if (!chunks.length && /\b(qué|que|what|who|cuál|cual)\b/i.test(t)) {
    tools_used.push("ontology_search");
    try {
      const found = await ontologyToolSearch(env, ten, t.slice(0, 200), 4);
      chunks.push("ONTOLOGY_SEARCH: " + JSON.stringify(found).slice(0, 1200));
    } catch (_) {}
  }

  return {
    context: chunks.join("\n"),
    tools_used
  };
}
