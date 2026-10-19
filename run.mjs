import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.ok(rootBody.version);
assert.ok(rootBody.plugins?.total >= 8);
assert.ok(rootBody.anti_gap?.phase === "1");

const agent = await worker.fetch(new Request("https://aston.test/v1/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "stats" })
}), env, {});
assert.ok([401, 503].includes(agent.status));

const traces = await worker.fetch(new Request("https://aston.test/v1/agent/traces"), env, {});
assert.ok([401, 503].includes(traces.status));

const roi = await worker.fetch(new Request("https://aston.test/v1/roi/summary"), env, {});
assert.equal(roi.status, 401);

console.log("ASTON OS smoke tests passed", rootBody.version, "anti_gap", rootBody.anti_gap?.version);
console.log("Plugins:", rootBody.plugins.list.map(p => p.id).join(", "));
