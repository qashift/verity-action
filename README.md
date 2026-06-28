# qashift/verity-action

GitHub Action that runs your Playwright suite and reports results to [Verity](https://verity-kappa-ebon.vercel.app) — AI-augmented testing by QAShift.

The runner is **self-contained** (vendored in this action), so there's nothing to `npm install` and no package to publish — just Node 20+ (default on `ubuntu-latest`) and a Playwright install in your workflow.

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }          # needed for diff-aware Quick check
- uses: actions/setup-node@v4
  with: { node-version: "20" }
- run: npm install
- run: npx playwright install --with-deps chromium

# Quick check (diff-aware) on PRs — a fast sanity check, never blocks.
- uses: qashift/verity-action@v1
  with:
    tier: fast
    token: ${{ secrets.VERITY_INGEST_TOKEN }}

# Full regression on merge to main — the safety net.
- uses: qashift/verity-action@v1
  if: github.ref == 'refs/heads/main'
  with:
    tier: full
    token: ${{ secrets.VERITY_INGEST_TOKEN }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `tier` | `fast` | `fast` = Quick check / smoke (diff-aware). `full` = Full regression / load. |
| `token` | — | Your project's Verity ingest token (store as a secret). **Required.** |
| `base` | `origin/main` | Base ref for diff-aware selection on the fast tier. |
| `api-url` | Verity cloud | Override the Verity API base URL (self-hosted). |
| `engines` | `ui` | Comma-separated engines to run: `ui,api,mobile,perf,security,contract`. |

The default (`engines: ui`) keeps existing behavior exactly. Add engines to enable the additive disciplines below. **Every engine runs in YOUR CI — the cost is yours — and all results post through the same Verity ingestion API.** Each discipline maps its native tool output into Verity's unified results schema via a small adapter, so nothing about the existing UI/API flow changes.

---

## Multi-discipline testing

### 📱 Mobile (Maestro)

Runs AI-generated Maestro YAML flows (in `tests/verity/mobile/`) against an Android emulator or iOS simulator. **You must provision the emulator/simulator and the Maestro CLI in your workflow** — GitHub Actions supports both (cost is yours):

```yaml
# Android emulator example (provision BEFORE the Verity step):
- uses: reactivecircus/android-emulator-runner@v2
  with: { api-level: 34, script: echo "emulator ready" }
- run: curl -Ls "https://get.maestro.mobile.dev" | bash   # installs Maestro CLI
- uses: qashift/verity-action@v1
  with:
    token: ${{ secrets.VERITY_INGEST_TOKEN }}
    engines: ui,mobile
    maestro-flows-dir: tests/verity/mobile
```

Self-healing extends to mobile: a broken Maestro selector is repaired from Maestro's **accessibility-tree dump** (the mobile equivalent of the DOM snapshot used for Playwright), delivered as a PR diff through the same GitHub App.

**Real-device add-on (Maestro Cloud — Scale/Enterprise only).** Optional, gated behind `maestro-real-device: true`; never runs otherwise:

```yaml
  with:
    engines: mobile
    maestro-real-device: "true"
    maestro-cloud-api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
    maestro-app-file: build/app.apk
```

| Input | Default | Description |
|---|---|---|
| `maestro-flows-dir` | `tests/verity/mobile` | Directory of Maestro YAML flows. |
| `maestro-real-device` | `false` | Run on real devices via Maestro Cloud (gated). |
| `maestro-cloud-api-key` | — | Maestro Cloud API key (only when real-device is on). |
| `maestro-app-file` | — | Built app (`.apk`/`.app`/`.ipa`) for real-device runs. |

### ⚡ Performance (Artillery)

AI-generated Artillery scenarios are built from the **same OpenAPI spec** you already use for API tests — no second upload. Two tiers mirror Quick check / Full regression:

- **fast** → a lightweight **Perf smoke check** on every PR (few endpoints, ~30s, small VU count). Always labeled "Perf smoke check" — never implied to be a full load test.
- **full** → the complete, customer-configured load test on merge/schedule.

For load beyond what a single runner can generate, set `perf-distributed: true` to use Artillery's native distributed/serverless mode (requires your cloud creds per Artillery docs). Optionally set `lighthouse-url` for a separate, lightweight Core Web Vitals check.

| Input | Default | Description |
|---|---|---|
| `perf-config` | `tests/verity/perf/smoke.yml` | Artillery config to run. |
| `perf-distributed` | `false` | Use Artillery distributed/serverless mode. |
| `lighthouse-url` | — | If set, also run Lighthouse CI for Core Web Vitals. |

### 🔐 Security (ZAP DAST + Semgrep SAST)

Both run as **Docker-based steps** (the official images carry their own Python runtime — you never install Python locally):

- **Semgrep (SAST)** — Community Edition, invoked CLI-only via Docker (never linked into our code). Diff of changed files on PR; full repo on schedule.
- **ZAP (DAST)** — baseline scan on PR, full active scan on merge, against `security-target-url` (a reachable preview/staging URL).

Findings are surfaced as severity-ranked **Security issues** in the dashboard — not pass/fail tests — and never block the build.

| Input | Default | Description |
|---|---|---|
| `security-target-url` | — | Reachable preview/staging URL for the ZAP DAST scan. |

### 🔁 API contract (Schemathesis)

A second, independent contract-testing layer **alongside** the existing Playwright-request flow tests (which are unchanged). Runs as a Docker step against the **same** OpenAPI spec + base URL you already provided:

```yaml
  with:
    engines: api,contract
    openapi-spec: openapi.yaml
    api-base-url: https://staging.example.com
```

> **Constraint:** Schemathesis needs a **reachable base URL** to execute (not just the spec). For public APIs, Verity can do an optional Cloud Trial demo run before CI is wired. For **internal/firewalled APIs this only runs inside your own CI** — there is no way for Verity's cloud to reach a private host.

Only the final **shrunk** failures are reported (Schemathesis minimizes each failure to a minimal reproducing example). In the dashboard, API results are grouped by endpoint then meaning and labeled **Flow** vs **Contract** — never by tool name — and a flow + contract failure with the same underlying cause collapses into one entry tagged as found by both.

| Input | Default | Description |
|---|---|---|
| `openapi-spec` | — | Path/URL to the OpenAPI spec (reused for contract + perf). |
| `api-base-url` | — | Reachable base URL of the API under test. |

---

## Licenses (engines)

All bundled engines are invoked as external CLIs/Docker images or as separate npm tools — **never linked into Verity's own code** — so no copyleft obligation attaches to Verity:

| Engine | License | Notes |
|---|---|---|
| Maestro | Apache-2.0 | Clean. Confirm no GPL/AGPL deps if the Maestro Cloud SDK is used. |
| Artillery | MPL-2.0 | Clean (file-level copyleft; we don't modify its source). |
| OWASP ZAP | Apache-2.0 | Clean. Run via Docker. |
| Semgrep CE | LGPL-2.1 | Clean under **subprocess/Docker-only** use — never imported or linked. |
| Schemathesis | **MIT** | Verified in its repo. Most permissive; Docker subprocess invocation. |
| Lighthouse | Apache-2.0 | Clean. |

MIT licensed.
