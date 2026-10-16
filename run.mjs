import worker from "./index.js";
import assert from "node:assert/strict";

const env = {};
const root = await worker.fetch(new Request("https://aston.test/"), env, {});
const rootBody = await root.json();
assert.equal(root.status, 200);
assert.equal(rootBody.version, "8.5.1");
assert.ok(rootBody.plugins.total >= 8);

const agent = await worker.fetch(new Request("https://aston.test/v1/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "stats" })
}), env, {});
assert.ok([401, 503].includes(agent.status));

const traces = await worker.fetch(new Request("https://aston.test/v1/agent/traces"), env, {});
assert.ok([401, 503].includes(traces.status));

console.log("ASTON OS 8.5.1 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => p.id).join(", "));


const publicDisabled = await worker.fetch(new Request("https://aston.test/v1/agent/public", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "Ayudame a diagnosticar un problema" })
}), {});
assert.equal(publicDisabled.status, 503);
assert.equal((await publicDisabled.json()).error, "public_agent_disabled");

const caps = await worker.fetch(new Request("https://aston.test/v1/agent/capabilities"), {});
const capsBody = await caps.json();
assert.equal(caps.status, 200);
assert.equal(capsBody.mode, "advisory");
assert.equal(capsBody.capabilities.private_data_access, false);

console.log("Public agent safety tests passed");
