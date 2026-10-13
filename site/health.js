export const POLL_INTERVAL_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const STALE_AFTER_MS = 120_000;

export const STATUS_LABELS = Object.freeze({
  checking: "Checking", healthy: "Operational", degraded: "Degraded",
  unhealthy: "Unavailable", unknown: "Unknown", stale: "Stale", offline: "Offline"
});

const severity = { healthy: 0, checking: 1, degraded: 2, unknown: 2, stale: 2, offline: 2, unhealthy: 3 };

/** Validate the public environment configuration before making health requests. */
export function validateEnvironments(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Configure at least one environment.");
  }
  const environmentIds = new Set();
  for (const environment of value) {
    if (!environment || !nonempty(environment.id) || !nonempty(environment.name) || environmentIds.has(environment.id)) {
      throw new Error("Environment names and unique IDs are required.");
    }
    environmentIds.add(environment.id);
    if (!Array.isArray(environment.services) || environment.services.length === 0) {
      throw new Error("Each environment needs at least one service.");
    }
    const serviceIds = new Set();
    for (const service of environment.services) {
      if (!service || !nonempty(service.id) || !nonempty(service.name) || serviceIds.has(service.id)) {
        throw new Error("Service names and unique IDs are required within each environment.");
      }
      serviceIds.add(service.id);
      const url = new URL(service.healthUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new Error("Health endpoints must use HTTPS without credentials or fragments.");
      }
    }
  }
  return value;
}

/** Check the reported health, including JSON returned with non-success HTTP responses. */
export async function checkHealth(healthUrl, {
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let state;
  let detail;
  let httpStatus = null;
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal
    });
    httpStatus = response.status;
    let report;
    try {
      report = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      return result("unknown", "Invalid health response", now(), startedAt, httpStatus);
    }
    const states = { Healthy: "healthy", Degraded: "degraded", Unhealthy: "unhealthy" };
    state = Object.hasOwn(states, report?.status) ? states[report.status] : "unknown";
    if (state === "unknown") {
      detail = "Unrecognized health response";
    } else if (!response.ok && state !== "unhealthy") {
      state = "unhealthy";
      detail = `Health endpoint returned HTTP ${httpStatus}`;
    } else {
      detail = { healthy: "Health checks passed", degraded: "Health checks report degradation", unhealthy: "Health checks report a failure" }[state];
    }
  } catch {
    state = "unhealthy";
    detail = controller.signal.aborted ? "Health check timed out" : "Unable to reach health endpoint";
  } finally {
    clearTimeout(timeout);
  }
  return result(state, detail, now(), startedAt, httpStatus);
}

/** Prevent old successful responses or an offline browser from looking operational. */
export function effectiveState(healthResult, now = Date.now(), online = true) {
  if (!online) {
    return "offline";
  }
  if (!healthResult) {
    return "checking";
  }
  if (now - healthResult.checkedAt > STALE_AFTER_MS) {
    return "stale";
  }
  return healthResult.state;
}

/** Aggregate the worst result, retaining a checking state until every service has responded. */
export function aggregateStatus(states) {
  if (states.length === 0) {
    return "checking";
  }
  return states.reduce((worst, state) => severity[state] > severity[worst] ? state : worst, "healthy");
}

/** Create a sanitized result with the completion time and browser-observed latency. */
function result(state, detail, checkedAt, startedAt, httpStatus) {
  return { state, detail, checkedAt, responseTimeMs: Math.max(0, checkedAt - startedAt), httpStatus };
}

/** Require visible text for public configuration labels and identifiers. */
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
