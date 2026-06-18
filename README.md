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
| `tier` | `fast` | `fast` = Quick check (diff-aware subset). `full` = Full regression (entire suite). |
| `token` | — | Your project's Verity ingest token (store as a secret). **Required.** |
| `base` | `origin/main` | Base ref for diff-aware selection on the fast tier. |
| `api-url` | Verity cloud | Override the Verity API base URL (self-hosted). |

The runner executes `playwright test`, reruns failures to separate flaky from broken, and POSTs results to Verity. Only a **Full regression** with real failures can fail the build.

MIT licensed.
