# ASTON OS — Phase 1: Universal Problem Core

## Scope

This branch adds the first bounded implementation of the universal problem-solving core to the existing Worker. It is additive and does not replace existing routes or alter the production deployment.

### API

- `POST /v1/problems/diagnose` — classify a problem, surface missing information, assess coarse risk signals, and return a plan-only policy.
- `POST /v1/problems/plan` — create a reviewable, staged plan. It does not execute tools or external actions.

Both endpoints require a bearer token with the `write` scope. Inputs are bounded and responses explicitly state that execution did not occur. The classifier is heuristic, not an expert system or a guarantee of correctness.

### Input

```json
{
  "objective": "Reduce payment processing failures",
  "context": "Current integration and observed errors",
  "constraints": "Do not change production; keep current payment provider",
  "success_criteria": "Failure rate decreases in staging tests"
}
```

### Safety and reliability

- High-impact domains (health, legal, finance, security, critical infrastructure) require human approval in the plan.
- Destructive-change and possible-secret signals are surfaced for review.
- No autonomous production mutation is enabled.
- Persisted records contain a bounded objective, domain, risk, status, and plan metadata; raw context is not stored in the problem run table.
- Audit logs continue to use the existing audit subsystem; if D1 is unavailable, the API reports that persistence was not completed instead of pretending the run was durably recorded.

## Validation

Run `npm test` and `npm run check` in CI. Before deployment, review the diff, inspect binding compatibility, and run the endpoints in a non-production environment. This branch is not deployed by this change.
