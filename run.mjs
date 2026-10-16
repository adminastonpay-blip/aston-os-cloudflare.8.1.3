import "./test-universal-core.mjs";
import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.version, "8.5.0");
assert.ok(rootBody.plugins.total >= 8);

const agent = await worker.fetch(new Request("https://aston.test/v1/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "stats" })
}), env, {});
assert.ok([401, 503].includes(agent.status));

const traces = await worker.fetch(new Request("https://aston.test/v1/agent/traces"), env, {});
assert.ok([401, 503].includes(traces.status));

const unauthProblem = await worker.fetch(new Request("https://aston.test/v1/problems/diagnose", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ objective: "Organize project resources" })
}), env, {});
assert.equal(unauthProblem.status, 401);

const fakeDb = {
  async batch() {},
  prepare() {
    return {
      bind() {
        return {
          async run() { return { success: true }; },
          async first() { return { ok: 1 }; },
          async all() { return { results: [] }; }
        };
      }
    };
  }
};
const problemResponse = await worker.fetch(new Request("https://aston.test/v1/problems/plan", {
  method: "POST",
  headers: { "content-type": "application/json", "Authorization": "Bearer test-token" },
  body: JSON.stringify({
    objective: "Improve payment failure rates",
    context: "Fintech payment processing",
    constraints: "No production changes",
    success_criteria: "Reduce failed payments in staging"
  })
}), { ASTON_API_TOKEN: "test-token", ASTON_DB: fakeDb }, {});
const problemBody = await problemResponse.json();
assert.equal(problemResponse.status, 201);
assert.equal(problemBody.ok, true);
assert.equal(problemBody.persisted, true);
assert.equal(problemBody.result.status, "ready_for_review");

console.log("ASTON OS 8.5.0 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => p.id).join(", "));
