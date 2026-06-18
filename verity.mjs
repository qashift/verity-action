#!/usr/bin/env node
/**
 * Verity CLI (Path B). Runs the project's Playwright suite, reruns failures N
 * times to separate flaky from broken, and POSTs results to the Verity
 * ingestion API. For the `fast` tier it computes the diff-aware subset from
 * `git diff` against the base ref; the `full` tier always runs everything.
 *
 * Usage:
 *   verity run --tier fast  --token $VERITY_INGEST_TOKEN [--base origin/main]
 *   verity run --tier full  --token $VERITY_INGEST_TOKEN
 *
 * Env:
 *   VERITY_API_URL      defaults to https://verity.qashift.com
 *   VERITY_INGEST_TOKEN alternative to --token
 *   VERITY_RERUNS       default 3
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];
if (cmd !== "run") {
  console.log("Usage: verity run --tier <fast|full> --token <token> [--base origin/main]");
  process.exit(cmd ? 1 : 0);
}

const tier = arg("tier", "fast");
const token = arg("token", process.env.VERITY_INGEST_TOKEN);
const base = arg("base", "origin/main");
const apiUrl = (process.env.VERITY_API_URL ?? "https://verity.qashift.com").replace(/\/$/, "");
const reruns = Number(process.env.VERITY_RERUNS ?? 3);

if (!token) {
  console.error("✗ Missing token. Pass --token or set VERITY_INGEST_TOKEN.");
  process.exit(1);
}
if (tier !== "fast" && tier !== "full") {
  console.error("✗ --tier must be 'fast' or 'full'.");
  process.exit(1);
}

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const commitSha = git("rev-parse HEAD") || "unknown";
const branch = git("rev-parse --abbrev-ref HEAD") || "unknown";
const changedFiles = tier === "fast"
  ? git(`diff --name-only ${base}...HEAD`).split("\n").filter(Boolean)
  : [];

// Run Playwright with JSON reporter, rerunning failures to detect flakes.
function runPlaywright(grep) {
  const reporter = "--reporter=json";
  const grepArg = grep ? ["--grep", grep] : [];
  const res = spawnSync("npx", ["playwright", "test", reporter, ...grepArg], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Playwright JSON goes to stdout even on failure.
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function collectSpecs(report) {
  const out = [];
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const ok = spec.tests?.every((t) => t.results?.every((r) => r.status === "passed" || r.status === "expected"));
      out.push({ file: f, title: spec.title, ok: !!ok });
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report?.suites ?? []) walk(s, s.file);
  return out;
}

console.log(`▶ Verity ${tier === "fast" ? "Quick check" : "Full regression"} — commit ${commitSha.slice(0, 7)} on ${branch}`);

const first = runPlaywright();
if (!first) {
  console.error("✗ Could not parse Playwright JSON output. Is @playwright/test installed?");
  process.exit(1);
}

const specs = collectSpecs(first);
const results = [];
for (const spec of specs) {
  const attempts = [spec.ok];
  // Rerun failures up to N times to classify flaky vs broken.
  if (!spec.ok) {
    for (let i = 1; i < reruns; i++) {
      const rerun = runPlaywright(spec.title);
      const rs = collectSpecs(rerun).find((s) => s.title === spec.title);
      attempts.push(rs ? rs.ok : false);
    }
  }
  results.push({ spec_path: spec.file, name: spec.title, attempts });
}

const payload = {
  tier,
  trigger: tier === "fast" ? "pr" : "merge",
  commit_sha: commitSha,
  branch,
  pr_number: process.env.VERITY_PR_NUMBER ? Number(process.env.VERITY_PR_NUMBER) : null,
  changed_files: changedFiles,
  suite_total: specs.length,
  results,
};

const res = await fetch(`${apiUrl}/api/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(payload),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`✗ Ingest failed (${res.status}): ${data.error ?? "unknown error"}`);
  process.exit(1);
}

console.log(`✓ ${data.tier_label}: ${data.summary.passed} passed, ${data.summary.failed} failed, ${data.summary.flaky} flaky`);
if (data.blocked) {
  console.error("✗ Full regression found real failures — failing the build.");
  process.exit(1);
}
process.exit(0);
