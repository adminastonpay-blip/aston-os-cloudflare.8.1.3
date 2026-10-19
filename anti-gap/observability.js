/**
 * Anti-Gap Phase 4 — observability summary (ROI + SLA + bindings)
 */

import { summarizeRoi, checkBudget } from "./roi.js";
import { computeSla } from "./sla.js";
import { probeBindings } from "./resilience.js";
import { loadModelPolicy } from "./model-portfolio.js";
import { loadByok, maskByok, envByok } from "./byok.js";
import { loadRetention } from "./retention.js";

export async function observabilitySummary(env, tenant, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7));
  const hours = Math.min(168, Math.max(1, Number(opts.hours) || 24));

  const [roi, sla, budget, probes, models, byok, retention] = await Promise.all([
    summarizeRoi(env, tenant, days).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    computeSla(env, tenant, hours).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    checkBudget(env, tenant).catch(() => ({ allowed: true, configured: false })),
    probeBindings(env).catch(() => ({})),
    loadModelPolicy(env, tenant).catch(() => null),
    loadByok(env, tenant).catch(() => null),
    loadRetention(env, tenant).catch(() => null)
  ]);

  const globalByok = envByok(env);

  return {
    ok: true,
    tenant,
    generated_at: new Date().toISOString(),
    windows: { roi_days: days, sla_hours: hours },
    roi: roi.ok
      ? { summary: roi.summary, outcomes: roi.outcomes, by_route: (roi.by_route || []).slice(0, 10) }
      : { available: false, error: roi.error },
    sla: sla.ok ? { summary: sla.summary, sample_size: sla.sample_size } : { available: false, error: sla.error },
    budget,
    bindings: probes,
    policies: {
      models: models || { source: "defaults" },
      byok: maskByok(byok) || (globalByok ? { ...maskByok(globalByok), source: "env" } : { configured: false }),
      retention: retention || { source: "defaults" }
    },
    anti_gap: {
      phase: 4,
      note: "Unified observability for pilot-to-profit and ops"
    }
  };
}
