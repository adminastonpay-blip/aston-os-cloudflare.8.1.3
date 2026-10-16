import assert from "node:assert/strict";
import { diagnoseProblem, createProblemPlan } from "./universal-core.js";

const general = diagnoseProblem({ objective: "Organize my project" });
assert.equal(general.classification.domain, "general");
assert.equal(general.readiness.ready_to_plan, false);
assert.equal(general.execution_policy.external_actions_executed, false);

const finance = diagnoseProblem({
  objective: "Improve payment failure rates",
  context: "Fintech payment processing",
  constraints: "No production changes",
  success_criteria: "Reduce failed payments in staging"
});
assert.equal(finance.classification.domain, "finance");
assert.equal(finance.risk.level, "high");
assert.equal(finance.risk.human_approval_required, true);
assert.equal(finance.readiness.ready_to_plan, true);

const plan = createProblemPlan({
  objective: "Improve payment failure rates",
  context: "Fintech payment processing",
  constraints: "No production changes",
  success_criteria: "Reduce failed payments in staging"
});
assert.equal(plan.status, "ready_for_review");
assert.equal(plan.steps.length, 7);
assert.equal(plan.safeguards.some(s => s.includes("No ejecutar")), true);
assert.equal(plan.diagnosis.execution_policy.external_actions_executed, false);

const secrets = diagnoseProblem({ objective: "Review API key handling and deployment" });
assert.ok(secrets.risk.signals.includes("possible_secret_in_input"));
console.log("ASTON Phase 1 universal-core tests passed");
