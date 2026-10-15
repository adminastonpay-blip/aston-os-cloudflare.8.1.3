import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.ok, true);
assert.equal(rootBody.service, "ASTON OS Omni-Matrix Apex");
assert.equal(rootBody.version, "8.3.0");
assert.ok(rootBody.capabilities);
assert.ok(rootBody.plugins);
assert.ok(rootBody.plugins.total >= 5);
assert.equal(rootBody.plugins.list.find(p => p.id === "core").active, true);

const plugins = await worker.fetch(new Request("https://aston.test/v1/plugins"), env, {});
const pluginsBody = await plugins.json();
assert.equal(plugins.status, 200);
assert.equal(pluginsBody.ok, true);
assert.ok(Array.isArray(pluginsBody.plugins));

const missing = await worker.fetch(new Request("https://aston.test/no-such-route"), env, {});
assert.equal(missing.status, 404);

const opts = await worker.fetch(new Request("https://aston.test/v1/records/fintech", { method: "OPTIONS" }), env, {});
assert.equal(opts.status, 204);

const imageNoAi = await worker.fetch(
  new Request("https://aston.test/v1/ai/image", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": "Bearer x" },
    body: JSON.stringify({ prompt: "test" })
  }),
  {},
  {}
);
assert.ok([401, 503].includes(imageNoAi.status));

const diagnosticUnauthorized = await worker.fetch(
  new Request("https://aston.test/v1/diagnostics/storage", { method: "POST" }),
  {},
  {}
);
assert.equal(diagnosticUnauthorized.status, 401);

console.log("ASTON OS 8.3.0 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => `${p.id}(${p.active ? "on" : "off"})`).join(", "));
