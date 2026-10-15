import worker from "../src/index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.ok, true);
assert.equal(rootBody.service, "ASTON OS Omni-Matrix Apex");

const missing = await worker.fetch(new Request("https://aston.test/no-such-route"), env, {});
assert.equal(missing.status, 404);

const opts = await worker.fetch(new Request("https://aston.test/v1/records/fintech", { method: "OPTIONS" }), env, {});
assert.equal(opts.status, 204);

console.log("ASTON OS smoke tests passed");

const diagnosticUnauthorized = await worker.fetch(
  new Request("https://aston.test/v1/diagnostics/storage", { method: "POST" }),
  {},
  {}
);
assert.equal(diagnosticUnauthorized.status, 401);
