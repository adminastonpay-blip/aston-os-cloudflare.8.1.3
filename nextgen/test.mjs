import assert from "node:assert/strict";
import worker from "./index.js";

const request = (path, { method = "GET", body, token, origin } = {}) => new Request("https://aston-lab.test" + path, {
  method,
  headers: {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(token ? { authorization: "Bearer " + token } : {}),
    ...(origin ? { origin } : {})
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

const baseEnv = { ASTON_API_TOKEN: "test-secret", ALLOWED_ORIGIN: "https://console.example" };

{
  const response = await worker.fetch(request("/health"), { AI: { run() {} } });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.mode, "analysis-only");
}
{
  const response = await worker.fetch(request("/v1/intelligence/solve", {
    method: "POST", body: { problem: "test" }
  }), { ...baseEnv, AI: { run() { throw new Error("should not run"); } } });
  assert.equal(response.status, 401);
}
{
  const response = await worker.fetch(request("/v1/intelligence/solve", {
    method: "POST", token: "test-secret", body: {}
  }), { ...baseEnv, AI: { run() { throw new Error("should not run"); } } });
  assert.equal(response.status, 400);
}
{
  let calls = 0;
  const AI = { async run(_model, input) {
    calls++;
    assert.ok(Array.isArray(input.messages));
    return { response: calls === 1 ? '{"summary":"draft","plan":[]}' : '{"issues":[],"corrections":[],"verification_passed":true}' };
  }};
  const response = await worker.fetch(request("/v1/intelligence/solve", {
    method: "POST", token: "test-secret", body: { problem: "Diagnose a slow API" }
  }), { ...baseEnv, AI });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.execution.external_actions_taken, false);
  assert.equal(calls, 2);
}
{
  const response = await worker.fetch(request("/v1/intelligence/solve", {
    method: "POST", token: "test-secret", body: { problem: "x".repeat(12001) }
  }), { ...baseEnv, AI: { run() { throw new Error("should not run"); } } });
  assert.equal(response.status, 413);
}
console.log("ASTON Intelligence Lab tests passed");
