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

const persistedAuditRows = [];
const fakeDb = {
  batch: async () => [],
  prepare(sql) {
    return {
      bind(...values) {
        return {
          run: async () => {
            if (sql.startsWith("INSERT INTO audit_log")) persistedAuditRows.push({ sql, values });
            return { success: true };
          }
        };
      }
    };
  }
};
const eventsAuthorized = await worker.fetch(new Request("https://aston.test/v1/events", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": "Bearer test-secret",
    "x-tenant": "aston-test",
    Origin: allowedOrigin
  },
  body: JSON.stringify({ event: "page_view", page: "/pricing", properties: { source: "smoke-test" } })
}), { ASTON_API_TOKEN: "test-secret", ASTON_DB: fakeDb }, {});
assert.equal(eventsAuthorized.status, 202, "authorized event should be accepted after D1 audit write");
assert.equal(persistedAuditRows.length, 1, "event acceptance must follow a successful audit insert");
assert.match(persistedAuditRows[0].values[3], /storefront\.event:page_view/);

const failedDb = {
  batch: async () => [],
  prepare(sql) {
    return {
      bind() {
        return {
          run: async () => {
            if (sql.startsWith("INSERT INTO audit_log")) throw new Error("simulated D1 write failure");
            return { success: true };
          }
        };
      }
    };
  }
};
const eventsFailedWrite = await worker.fetch(new Request("https://aston.test/v1/events", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": "Bearer test-secret",
    Origin: allowedOrigin
  },
  body: JSON.stringify({ event: "page_view" })
}), { ASTON_API_TOKEN: "test-secret", ASTON_DB: failedDb }, {});
assert.equal(eventsFailedWrite.status, 500, "event endpoint must report D1 audit write failures");

console.log("ASTON OS 8.5.0 smoke tests passed");
console.log("Plugins:", rootBody.plugins.list.map(p => p.id).join(", "));
