import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const configuration = JSON.parse(await readFile(new URL("../../site/environments.json", import.meta.url), "utf8"));

/** Fulfill anonymous endpoint checks with controlled health reports. */
async function mockHealthy(page) {
  await page.route("**/health", route => route.fulfill({ json: { status: "Healthy" } }));
}

test("shows all five services, supports keyboard refresh, and fits the viewport", async ({ page }, testInfo) => {
  await mockHealthy(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  await expect(page.locator(".service-row")).toHaveCount(5);
  await expect(page.locator(".service-row .status-label")).toHaveText(Array(5).fill("Operational"));
  await expect(page.locator(".service-row .checked-time").first()).toHaveAttribute("datetime", /T/);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to status" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Refresh application health" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Refresh application health" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("status.png"), fullPage: true });
});

test("shows degradation and outages, then recovers after refresh", async ({ page }) => {
  let failed = false;
  await page.route("**/health", route => {
    const hostname = new URL(route.request().url()).hostname;
    const status = failed && hostname.startsWith("core.") ? "Degraded" : failed && hostname.startsWith("media.") ? "Unhealthy" : "Healthy";
    return route.fulfill({ status: status === "Unhealthy" ? 503 : 200, json: { status } });
  });
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  failed = true;
  await page.getByRole("button", { name: "Refresh application health" }).click();
  await expect(page.locator("#overall-title")).toHaveText("Some services are unavailable");
  await expect(page.locator(".service-row").filter({ hasText: "Core API" }).locator(".status-badge")).toHaveAttribute("data-state", "degraded");
  await expect(page.locator(".service-row").filter({ hasText: "Media API" }).locator(".status-badge")).toHaveAttribute("data-state", "unhealthy");
  await expect(page.locator(".environment-summary .status-label")).toHaveText("Unavailable");
  failed = false;
  await page.getByRole("button", { name: "Refresh application health" }).click();
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
});

test("handles malformed reports and network failures independently", async ({ page }) => {
  await page.route("**/health", route => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname.startsWith("core.")) {
      return route.abort("failed");
    }
    if (hostname.startsWith("media.")) {
      return route.fulfill({ contentType: "text/html", body: "<h1>Unexpected proxy response</h1>" });
    }
    return route.fulfill({ json: { status: "Healthy" } });
  });
  await page.goto("/");
  await expect(page.locator(".service-row .status-label")).toHaveText(["Unavailable", "Unknown", "Operational", "Operational", "Operational"]);
  await expect(page.locator("#overall-title")).toHaveText("Some services are unavailable");
});

test("times out a blocked health check without blocking completed rows", async ({ page }) => {
  await page.clock.install();
  await page.route("**/health", route => {
    if (!new URL(route.request().url()).hostname.startsWith("core.")) {
      return route.fulfill({ json: { status: "Healthy" } });
    }
  });
  await page.goto("/");
  await expect(page.locator('.service-row .status-badge[data-state="healthy"]')).toHaveCount(4);
  await page.clock.fastForward(10_001);
  await expect(page.getByText("Health check timed out", { exact: true })).toBeVisible();
  await expect(page.locator("#overall-title")).toHaveText("Some services are unavailable");
  await expect(page.getByRole("button", { name: "Refresh application health" })).toBeEnabled();
});

test("marks offline results orange and rechecks after reconnection", async ({ page, context }) => {
  await mockHealthy(page);
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  await context.setOffline(true);
  await expect(page.locator("#notice")).toContainText("You're offline");
  await expect(page.locator(".service-row .status-label")).toHaveText(Array(5).fill("Offline"));
  await expect(page.getByRole("button", { name: "Refresh application health" })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  await expect(page.locator("#notice")).toBeHidden();
});

test("pauses hidden-page polling and marks old results stale before resuming", async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  let respond = true;
  await page.route("**/health", route => {
    calls++;
    if (respond) {
      return route.fulfill({ json: { status: "Healthy" } });
    }
  });
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(121_001);
  expect(calls).toBe(5);
  respond = false;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".service-row .status-label")).toHaveText(Array(5).fill("Stale"));
  await expect(page.locator("#overall-title")).toHaveText("Health results are out of date");
  await expect.poll(() => calls).toBe(10);
});

test("polls after sixty seconds and never overlaps refreshes", async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  let respond = true;
  await page.route("**/health", route => {
    calls++;
    if (respond) {
      return route.fulfill({ json: { status: "Healthy" } });
    }
  });
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  await page.clock.fastForward(60_000);
  await expect.poll(() => calls).toBe(10);
  await expect(page.getByRole("button", { name: "Refresh application health" })).toBeEnabled();
  respond = false;
  await page.getByRole("button", { name: "Refresh application health" }).click();
  await expect.poll(() => calls).toBe(15);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(calls).toBe(15);
  await expect(page.getByRole("button", { name: "Checking application health" })).toBeDisabled();
});

test("renders every configured environment without mixing repeated service IDs", async ({ page }) => {
  const production = structuredClone(configuration[0]);
  production.id = "prod";
  production.name = "Production";
  production.services = production.services.map(service => ({ ...service, healthUrl: service.healthUrl.replace(".dev.", ".").replace("https://dev.", "https://www.") }));
  await page.route("**/environments.json", route => route.fulfill({ json: [...configuration, production] }));
  await page.route("**/health", route => route.fulfill({ json: { status: route.request().url().includes("dev.") ? "Healthy" : "Degraded" } }));
  await page.goto("/");
  await expect(page.locator(".environment")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Development environment" }).locator(".service-row .status-label")).toHaveText(Array(5).fill("Operational"));
  await expect(page.getByRole("region", { name: "Production environment" }).locator(".service-row .status-label")).toHaveText(Array(5).fill("Degraded"));
  await expect(page.locator("#overall-title")).toHaveText("Some services are degraded");
});

test("retries a failed configuration load", async ({ page }) => {
  let failed = true;
  await mockHealthy(page);
  await page.route("**/environments.json", route => failed ? route.fulfill({ status: 500, body: "unavailable" }) : route.fulfill({ json: configuration }));
  await page.goto("/");
  await expect(page.locator("#overall-title")).toHaveText("Status configuration unavailable");
  failed = false;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
});

test("loads relative assets under the GitHub project URL", async ({ page }) => {
  await mockHealthy(page);
  await page.goto("/flare-log-status/");
  await expect(page.locator("#overall-title")).toHaveText("All systems operational");
  expect(await page.locator(".brand img").evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
});
