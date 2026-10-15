import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.ok, true);
assert.equal(rootBody.service, "ASTON OS Omni-Matrix Apex");
assert.equal(rootBody.version, "8.2.0");
assert.ok(rootBody.capabilities);

const missing = await worker.fetch(new Request("https://aston.test/no-such-route"), env, {});
assert.equal(missing.status, 404);

const opts = await worker.fetch(new Request("https://aston.test/v1/records/fintech", { method: "OPTIONS" }), env, {});
assert.equal(opts.status, 204);

const diagnosticUnauthorized = await worker.fetch(
  new Request("https://aston.test/v1/diagnostics/storage", { method: "POST" }),
  {},
  {}
);
assert.equal(diagnosticUnauthorized.status, 401);

const imageUnauthorized = await worker.fetch(
  new Request("https://aston.test/v1/ai/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "test" })
  }),
  {},
  {}
);
assert.equal(imageUnauthorized.status, 401);

console.log("ASTON OS 8.2.0 smoke tests passed");
