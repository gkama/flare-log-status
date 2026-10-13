import { checkHealth, REQUEST_TIMEOUT_MS } from "./health.js";

/** Maintain independent service results and coalesce concurrent refresh requests. */
export class HealthMonitor {
  #inFlight = null;

  constructor(environments, {
    fetchImpl = globalThis.fetch, now = Date.now, isOnline = () => true,
    onChange = () => {}, timeoutMs = REQUEST_TIMEOUT_MS
  } = {}) {
    this.environments = environments;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.isOnline = isOnline;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.results = new Map();
    this.refreshing = false;
    this.lastRefreshAt = null;
  }

  /** Read a service result without coupling it to another environment's identifiers. */
  getResult(environmentId, serviceId) {
    return this.results.get(JSON.stringify([environmentId, serviceId])) ?? null;
  }

  /** Refresh all services in parallel while leaving completed rows available immediately. */
  refresh() {
    if (this.#inFlight) {
      return this.#inFlight;
    }
    if (!this.isOnline()) {
      this.onChange();
      return Promise.resolve();
    }
    this.refreshing = true;
    this.#inFlight = Promise.resolve().then(async () => {
      this.onChange();
      try {
        await Promise.all(this.environments.flatMap(environment => environment.services.map(async service => {
          const healthResult = await checkHealth(service.healthUrl, {
            fetchImpl: this.fetchImpl, now: this.now, timeoutMs: this.timeoutMs
          });
          this.results.set(JSON.stringify([environment.id, service.id]), healthResult);
          this.onChange();
        })));
        this.lastRefreshAt = this.now();
      } finally {
        this.refreshing = false;
        this.#inFlight = null;
        this.onChange();
      }
    });
    return this.#inFlight;
  }
}
