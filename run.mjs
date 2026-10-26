import worker from "./worker.js";
import assert from "node:assert/strict";

const env = {
  ASTON_API_TOKEN: "test-token",
  ASTON_RECEIPT_SECRET: "test-receipt",
  SOVEREIGN_MASTER_KEY: "test-master",
  SOVEREIGN_FAIL_CLOSED: "0"
};

const root = await worker.fetch(new Request("https://aston.test/health"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200, "health status");
assert.ok(rootBody.ok === true, "ok");
assert.ok(String(rootBody.version).startsWith("11."), "version 11.x, got " + rootBody.version);

const native = await worker.fetch(new Request("https://aston.test/v1/native/capabilities"), env, {});
assert.equal(native.status, 200, "native capabilities");

console.log("ASTON OS", rootBody.version, "smoke tests passed");
