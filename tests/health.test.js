import assert from "node:assert/strict";
import test from "node:test";
import { aggregateStatus, checkHealth, effectiveState, STALE_AFTER_MS, validateEnvironments } from "../site/health.js";

const healthUrl = "https://core.dev.flarelog.net/health";
const configuration = () => [{ id: "dev", name: "Development", services: [{ id: "core", name: "Core API", healthUrl }] }];

for (const [reported, httpStatus, expected] of [["Healthy", 200, "healthy"], ["Degraded", 200, "degraded"], ["Unhealthy", 503, "unhealthy"]]) {
  test(`reads ${reported} from HTTP ${httpStatus} and sends an anonymous uncached GET`, async () => {
    const result = await checkHealth(healthUrl, { fetchImpl: async (url, options) => {
      assert.equal(url, healthUrl);
      assert.equal(options.method, "GET");
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ status: reported }), { status: httpStatus });
    } });
    assert.equal(result.state, expected);
    assert.equal(result.httpStatus, httpStatus);
    assert.ok(result.responseTimeMs >= 0);
    assert.ok(result.checkedAt > 0);
  });
}

test("never shows a failed HTTP response as operational", async () => {
  const result = await checkHealth(healthUrl, { fetchImpl: async () => new Response('{"status":"Healthy"}', { status: 500 }) });
  assert.equal(result.state, "unhealthy");
  assert.match(result.detail, /500/);
});

test("treats malformed, missing, and unknown statuses as unknown", async () => {
  for (const body of ["<html>Proxy error</html>", "null", "{}", '{"status":"Unexpected"}', '{"status":"toString"}']) {
    const result = await checkHealth(healthUrl, { fetchImpl: async () => new Response(body) });
    assert.equal(result.state, "unknown");
  }
});

test("labels connection failures without echoing exceptions", async () => {
  const result = await checkHealth(healthUrl, { fetchImpl: async () => { throw new Error("private network detail"); } });
  assert.equal(result.state, "unhealthy");
  assert.equal(result.detail, "Unable to reach health endpoint");
});

test("bounds both the request and response-body read with a timeout", async () => {
  for (const hangInBody of [false, true]) {
    const result = await checkHealth(healthUrl, {
      timeoutMs: 10,
      fetchImpl: async (_, { signal }) => {
        const blocked = new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return hangInBody ? { status: 200, ok: true, json: () => blocked } : blocked;
      }
    });
    assert.equal(result.state, "unhealthy");
    assert.equal(result.detail, "Health check timed out");
  }
});

test("expires old results and handles offline and initial checks", () => {
  const result = { state: "healthy", checkedAt: 1000 };
  assert.equal(effectiveState(null, 1000), "checking");
  assert.equal(effectiveState(result, 1000 + STALE_AFTER_MS), "healthy");
  assert.equal(effectiveState(result, 1001 + STALE_AFTER_MS), "stale");
  assert.equal(effectiveState(result, 1000, false), "offline");
});

test("aggregates the worst result without claiming green during incomplete checks", () => {
  assert.equal(aggregateStatus([]), "checking");
  assert.equal(aggregateStatus(["healthy", "checking"]), "checking");
  assert.equal(aggregateStatus(["healthy", "healthy"]), "healthy");
  assert.equal(aggregateStatus(["checking", "degraded"]), "degraded");
  assert.equal(aggregateStatus(["healthy", "stale"]), "stale");
  assert.equal(aggregateStatus(["healthy", "unknown"]), "unknown");
  assert.equal(aggregateStatus(["degraded", "unhealthy", "checking"]), "unhealthy");
});

test("accepts additional environments with repeated service IDs", () => {
  const config = configuration();
  config.push({ ...configuration()[0], id: "production", name: "Production" });
  assert.equal(validateEnvironments(config).length, 2);
});

test("rejects invalid configuration before issuing requests", () => {
  for (const invalid of [[], null, [{}], [...configuration(), ...configuration()]]) {
    assert.throws(() => validateEnvironments(invalid));
  }
  for (const invalidUrl of ["http://core.flarelog.net/health", "https://user:secret@core.flarelog.net/health", "https://core.flarelog.net/health#fragment", "not a url"]) {
    const config = configuration();
    config[0].services[0].healthUrl = invalidUrl;
    assert.throws(() => validateEnvironments(config));
  }
  const duplicatedServices = configuration();
  duplicatedServices[0].services.push({ ...duplicatedServices[0].services[0] });
  assert.throws(() => validateEnvironments(duplicatedServices));
});
