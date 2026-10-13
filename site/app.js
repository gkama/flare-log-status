import { aggregateStatus, effectiveState, POLL_INTERVAL_MS, STATUS_LABELS, validateEnvironments } from "./health.js";
import { HealthMonitor } from "./monitor.js";

const refreshButton = document.querySelector("#refresh");
const notice = document.querySelector("#notice");
const overview = document.querySelector(".overview");
const environmentContainer = document.querySelector("#environments");
const views = [];
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
let monitor = null;
let initializing = false;

/** Populate the stable environment and service nodes using only text content from configuration. */
function createViews(environments) {
  environmentContainer.replaceChildren();
  views.length = 0;
  for (const environment of environments) {
    const element = document.querySelector("#environment-template").content.firstElementChild.cloneNode(true);
    element.querySelector("h2").textContent = environment.name;
    element.querySelector(".environment-id").textContent = environment.id;
    element.querySelector(".service-count").textContent = `${environment.services.length} services`;
    element.setAttribute("aria-label", `${environment.name} environment`);
    const rows = environment.services.map(service => {
      const row = document.querySelector("#service-template").content.firstElementChild.cloneNode(true);
      row.querySelector("h3").textContent = service.name;
      const endpoint = row.querySelector(".endpoint");
      endpoint.href = service.healthUrl;
      endpoint.textContent = new URL(service.healthUrl).host;
      endpoint.setAttribute("aria-label", `${service.name} health endpoint (opens in a new tab)`);
      element.querySelector(".service-list").append(row);
      return { service, row };
    });
    environmentContainer.append(element);
    views.push({ environment, element, rows });
  }
  document.querySelector("#environment-count").textContent = `${environments.length} configured`;
}

/** Update a badge without rebuilding focusable controls. */
function setBadge(element, state) {
  element.dataset.state = state;
  element.querySelector(".status-label").textContent = STATUS_LABELS[state];
}

/** Avoid announcing unchanged live-region content on every freshness tick. */
function setText(element, value) {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

/** Describe the age of the most recent attempt while exposing the exact time to assistive tools. */
function setCheckedTime(element, checkedAt, now) {
  if (checkedAt === undefined) {
    element.textContent = "Not checked yet";
    element.removeAttribute("datetime");
    return;
  }
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  element.dateTime = new Date(checkedAt).toISOString();
  element.title = new Date(checkedAt).toLocaleString();
  element.textContent = seconds < 60 ? `Checked ${seconds}s ago` : `Checked ${Math.floor(seconds / 60)}m ago`;
}

/** Render fresh, stale, and offline results and summarize the worst state. */
function render() {
  if (!monitor) {
    return;
  }
  const now = Date.now();
  const online = navigator.onLine;
  const allStates = [];
  notice.hidden = online;
  setText(notice, online ? "" : "You're offline. Connect to the internet to check application health.");
  for (const { environment, element, rows } of views) {
    const states = rows.map(({ service, row }) => {
      const healthResult = monitor.getResult(environment.id, service.id);
      const state = effectiveState(healthResult, now, online);
      setBadge(row.querySelector(".status-badge"), state);
      row.querySelector(".status-detail").textContent = state === "offline" ? "Waiting for your connection"
        : state === "stale" ? "A fresh health check is needed" : healthResult?.detail ?? "Waiting for a health check";
      row.querySelector(".response-time").textContent = healthResult?.httpStatus ? `${healthResult.responseTimeMs} ms` : "—";
      setCheckedTime(row.querySelector(".checked-time"), healthResult?.checkedAt, now);
      return state;
    });
    setBadge(element.querySelector(".environment-summary .status-badge"), aggregateStatus(states));
    allStates.push(...states);
  }
  const state = aggregateStatus(allStates);
  overview.dataset.state = state;
  setText(document.querySelector("#overall-title"), {
    healthy: "All systems operational", degraded: "Some services are degraded", unhealthy: "Some services are unavailable",
    checking: "Checking system health", unknown: "Health status needs attention", stale: "Health results are out of date", offline: "You're offline"
  }[state]);
  const healthyCount = allStates.filter(value => value === "healthy").length;
  setText(document.querySelector("#overall-detail"), state === "checking" ? "Waiting for fresh health checks."
    : state === "offline" ? "Application health cannot be verified without a connection."
      : `${healthyCount} of ${allStates.length} services report fresh, healthy results.`);
  document.querySelector("#last-refresh").textContent = monitor.lastRefreshAt === null ? "Not checked yet"
    : `Last refreshed ${timeFormatter.format(monitor.lastRefreshAt)}`;
  refreshButton.disabled = monitor.refreshing || !online;
  refreshButton.querySelector("span").textContent = monitor.refreshing ? "Checking…" : "Refresh";
  refreshButton.setAttribute("aria-label", monitor.refreshing ? "Checking application health" : "Refresh application health");
}

/** Load public configuration and begin anonymous health checks, with a retryable failure state. */
async function initialize() {
  if (initializing) {
    return;
  }
  initializing = true;
  refreshButton.disabled = true;
  try {
    const response = await fetch("./environments.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) {
      throw new Error("Configuration could not be loaded.");
    }
    const environments = validateEnvironments(await response.json());
    createViews(environments);
    monitor = new HealthMonitor(environments, { isOnline: () => navigator.onLine, onChange: render });
    render();
    await monitor.refresh();
  } catch {
    overview.dataset.state = "unknown";
    document.querySelector("#overall-title").textContent = "Status configuration unavailable";
    document.querySelector("#overall-detail").textContent = "Try refreshing the page to load the service list.";
    notice.hidden = false;
    notice.textContent = navigator.onLine ? "The service configuration could not be loaded. Use Refresh to try again." : "You're offline. Connect to the internet and use Refresh.";
    refreshButton.disabled = false;
  } finally {
    initializing = false;
  }
}

refreshButton.addEventListener("click", () => monitor ? monitor.refresh() : initialize());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    render();
    if (monitor) {
      void monitor.refresh();
    }
  }
});
window.addEventListener("offline", render);
window.addEventListener("online", () => {
  render();
  void (monitor ? monitor.refresh() : initialize());
});
setInterval(() => {
  if (!document.hidden && monitor) {
    void monitor.refresh();
  }
}, POLL_INTERVAL_MS);
setInterval(() => {
  if (!document.hidden) {
    render();
  }
}, 1000);
void initialize();
