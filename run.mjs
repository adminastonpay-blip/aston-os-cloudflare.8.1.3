import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.ok, true);
assert.equal(rootBody.version, "8.4.0");
assert.ok(rootBody.plugins);
assert.ok(rootBody.plugins.total >= 8);

const plugins = await worker.fetch(new Request("https://aston.test/v1/plugins"), env, {});
assert.equal(plugins.status, 200);

const sem = await worker.fetch(new Request("https://aston.test/v1/search/semantic", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ q: "test" })
}), env, {});
assert.equal(sem.status, 401);

const agent = await worker.fetch(new Request("https://aston.test/v1/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "hi" })
}), env, {});
assert.ok([401, 503].includes(agent.status));

console.log("ASTON OS 8.4.0 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => `${p.id}(${p.active ? "on" : "off"})`).join(", "));
