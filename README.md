# FlareLog status

A small public status page for **https://status.flarelog.net**, hosted on GitHub Pages. Plain HTML, CSS, and JavaScript; no framework, application server, or runtime dependencies. Source and deployment live entirely in this repository.

## Local development

Use Node 24. Install development dependencies and start the local server:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:8080**. The server also supports `/flare-log-status/` to check GitHub's project URL. Live applications allow the status domain and `https://gkama.github.io`, so checks from localhost will show connection failures unless you use the mocked browser tests. No localhost access is enabled on production APIs.

```sh
npm test
npx playwright install chromium
npm run test:browser
```

On Linux, use `npx playwright install --with-deps chromium` when browser system dependencies are missing. Browser tests intercept health requests; they never rely on deployed services being available. They cover desktop and mobile layouts, keyboard refresh, degradation, outages, recovery, timeouts, offline/stale data, multiple environments, and project-relative assets.

## Health checks

`site/environments.json` defines every environment and its services. Dev includes Core API, Media API, Voice API, Event Processor, and Web. Add another environment object with a unique ID, a display name, and services with unique IDs, names, and public HTTPS `healthUrl` values. Every environment appears on the page automatically. The content security policy permits health endpoints under `*.flarelog.net`; update `connect-src` in `site/index.html` if an environment uses a different domain. Keep configuration public and free of credentials.

The page sends parallel anonymous, uncached GET requests immediately and every 60 seconds. Each request, including its response body, has a 10-second timeout. Refreshes do not overlap; hidden tabs stop polling and check again when visible. The browser's observed round-trip duration is shown in milliseconds.

| Result | Presentation |
| --- | --- |
| `Healthy` | Green · Operational |
| `Degraded` | Orange · Degraded |
| `Unhealthy`, network failure, or timeout | Red · Unavailable |
| Unrecognized or malformed response | Orange · Unknown |
| Result older than two minutes | Orange · Stale |
| Browser offline | Orange · Offline, with a connection notice |
| Waiting for the first result | Neutral · Checking |

JSON is read even on HTTP 503. A failed HTTP response never appears green. Each environment and the overall banner use the worst result; green requires all services to have fresh healthy responses. Connection errors can reflect the visitor's network or a CORS configuration failure, so the page reports endpoint reachability from that browser rather than a global outage verdict.

Existing application health checks are reused. Web currently checks process health; backend hosts report their registered dependencies. This does not verify end-to-end web flows or successful event consumption. There is no incident history, persistent polling, alerting, or calculated uptime.

## Deployment

`.github/workflows/pages.yml` runs unit and mocked browser tests on pull requests to `main`, pushes to `main`, and manual runs. Successful main-branch runs deploy only `site/` with official Pages actions pinned to commit SHAs. Feature-branch manual runs validate without deploying. Deployments are serialized in the `github-pages` environment. No Azure credentials, PATs, or cross-repository secrets are needed by the workflow.

First deploy the health-only CORS changes from the private `gkama/flare-log` repository using its existing `cd-dev` workflow with `service=all`. Those changes allow credential-free GET reads of `/health` from `https://status.flarelog.net` and `https://gkama.github.io`. Other application routes and `/alive` do not receive that CORS policy.

### One-time Pages and DNS setup

1. In the GitHub account's **Settings → Pages**, verify ownership of `flarelog.net` using GitHub's supplied TXT record. Retain that record. See [domain verification](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages).
2. In this repository's **Settings → Pages**, choose **GitHub Actions** and set the custom domain to **status.flarelog.net**. Alternatively, with an authenticated GitHub CLI and repository administration access, run `pwsh -File scripts/configure-pages.ps1`. It enables workflow-based Pages, sets the hostname, configures the `github-pages` deployment environment for `main`, and prints the resulting configuration. It does not change DNS.
3. In the `flarelog.net` DNS zone, create **CNAME `status` → `gkama.github.io`**. Use a direct DNS record, without proxying, wildcard records, or a repository path in the target. Register the domain with GitHub before adding this record.
4. In **Settings → Environments → github-pages**, restrict deployment branches to `main`.
5. Merge the validated status-page changes into `main`. The Pages workflow deploys automatically. DNS propagation and certificate issuance may take time.
6. Once GitHub issues the certificate, select **Enforce HTTPS**, or run `pwsh -File scripts/configure-pages.ps1 -EnableHttps`.
7. Open **https://status.flarelog.net** and verify all five service results, last check times, branding, mobile layout, and absence of CORS errors. An unavailable application should appear on the page; it should not fail the static deployment pipeline.

For Actions-based Pages, configure the domain through GitHub settings/API; a repository `CNAME` file is ignored and unnecessary. See [custom-domain setup](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) and [Pages workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Shared workspace

The private FlareLog repository includes `flare-log.code-workspace`, opening both checkouts in VS Code. Its status-folder entry matches the current nested checkout at `../flare-log-status/flare-log-status`. Open that workspace file, or update the folder path if you relocate the status checkout. Each repository retains its own Git history and branch.
