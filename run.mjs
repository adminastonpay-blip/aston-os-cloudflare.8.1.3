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


const allowedOrigin = "https://m1m0d3-ru.myshopify.com";
const allowed = await worker.fetch(new Request("https://aston.test/health", {
  headers: { Origin: allowedOrigin }
}), env, {});
assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);

const denied = await worker.fetch(new Request("https://aston.test/health", {
  headers: { Origin: "https://untrusted.example" }
}), env, {});
assert.equal(denied.headers.get("access-control-allow-origin"), null);

for (const path of ["/v1/ai/chat", "/v1/chat"]) {
  const response = await worker.fetch(new Request("https://aston.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: allowedOrigin },
    body: JSON.stringify({ prompt: "smoke test" })
  }), { PUBLIC_CHAT: "false" }, {});
  assert.equal(response.status, 401, path + " must remain protected");
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
}

const eventsUnauthorized = await worker.fetch(new Request("https://aston.test/v1/events", {
  method: "POST",
  headers: { "content-type": "application/json", Origin: allowedOrigin },
  body: JSON.stringify({ event: "page_view" })
}), { PUBLIC_CHAT: "false" }, {});
assert.equal(eventsUnauthorized.status, 401, "events endpoint must require authorization");

console.log("ASTON OS 8.5.0 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => p.id).join(", "));
