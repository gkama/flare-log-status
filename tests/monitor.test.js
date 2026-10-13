import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { HealthMonitor } from "../site/monitor.js";

const environments = [
  { id: "dev", services: [{ id: "core", healthUrl: "https://core.dev.flarelog.net/health" }] },
  { id: "prod", services: [{ id: "core", healthUrl: "https://core.flarelog.net/health" }] }
];

test("starts parallel requests, keeps partial results, and coalesces concurrent refreshes", async () => {
  const pending = [];
  const monitor = new HealthMonitor(environments, {
    fetchImpl: () => new Promise(resolve => pending.push(resolve)), now: () => 1000
  });
  const refresh = monitor.refresh();
  assert.equal(monitor.refresh(), refresh);
  assert.equal(monitor.refreshing, true);
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[0](new Response('{"status":"Healthy"}'));
  await setImmediate();
  assert.equal(monitor.getResult("dev", "core").state, "healthy");
  assert.equal(monitor.getResult("prod", "core"), null);
  assert.equal(monitor.refreshing, true);
  pending[1](new Response('{"status":"Unhealthy"}', { status: 503 }));
  await refresh;
  assert.equal(monitor.getResult("prod", "core").state, "unhealthy");
  assert.equal(monitor.refreshing, false);
  assert.equal(monitor.lastRefreshAt, 1000);
});

test("isolates failures and recovers on the next refresh", async () => {
  let failing = true;
  const monitor = new HealthMonitor(environments, { fetchImpl: async url => {
    if (failing && url.includes(".dev.")) {
      throw new Error("connection failed");
    }
    return new Response('{"status":"Healthy"}');
  } });
  await monitor.refresh();
  assert.equal(monitor.getResult("dev", "core").state, "unhealthy");
  assert.equal(monitor.getResult("prod", "core").state, "healthy");
  failing = false;
  await monitor.refresh();
  assert.equal(monitor.getResult("dev", "core").state, "healthy");
});

test("does not issue requests while offline and preserves previous results", async () => {
  let online = false;
  let calls = 0;
  const monitor = new HealthMonitor(environments, { isOnline: () => online, fetchImpl: async () => {
    calls++;
    return new Response('{"status":"Healthy"}');
  } });
  await monitor.refresh();
  assert.equal(calls, 0);
  assert.equal(monitor.lastRefreshAt, null);
  online = true;
  await monitor.refresh();
  online = false;
  const previous = monitor.getResult("dev", "core");
  await monitor.refresh();
  assert.equal(calls, 2);
  assert.equal(monitor.getResult("dev", "core"), previous);
});
