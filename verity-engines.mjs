#!/usr/bin/env node
/**
 * Verity multi-discipline engine runner (Path B, customer CI).
 *
 * This is an ADDITIVE companion to verity.mjs (which runs the Playwright UI/API
 * suite unchanged). It adapts the NATIVE output of a non-Playwright engine into
 * Verity's unified results schema and posts it through the SAME /api/ingest
 * endpoint, using the additive optional payload fields (discipline / findings /
 * perf). The ingestion API's external contract is never changed.
 *
 * Self-contained: the adapters are vendored here as plain JS (mirroring
 * packages/core/src/adapters.ts) so the Action needs no npm install — same model
 * as verity.mjs.
 *
 * Usage:
 *   node verity-engines.mjs <engine> --tier <fast|full> --report <file> [opts]
 *     engine ∈ mobile | perf | lighthouse | security-dast | security-sast | contract
 *
 * Env: VERITY_API_URL, VERITY_INGEST_TOKEN, VERITY_PR_NUMBER
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

/* --------------------------- arg parsing --------------------------- */
const engine = process.argv[2];
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const tier = arg("tier", "fast");
const reportPath = arg("report", "");
const token = process.env.VERITY_INGEST_TOKEN;
const apiUrl = (process.env.VERITY_API_URL ?? "https://verity.qashift.com").replace(/\/$/, "");

const VALID = ["mobile", "perf", "lighthouse", "security-dast", "security-sast", "contract"];
if (!VALID.includes(engine)) {
  console.error(`✗ Unknown engine '${engine}'. Expected one of: ${VALID.join(", ")}`);
  process.exit(1);
}
if (!token) {
  console.error("✗ Missing VERITY_INGEST_TOKEN.");
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

function readReport() {
  if (!reportPath || !existsSync(reportPath)) {
    console.error(`✗ Report file not found: ${reportPath}`);
    process.exit(1);
  }
  return readFileSync(reportPath, "utf8");
}

/* ----------------- vendored adapters (mirror core) ----------------- */
function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&#9;/g, "\t").replace(/&amp;/g, "&");
}
function xattr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeXml(m[1]) : undefined;
}
function parseJUnit(xml) {
  const cases = [];
  if (!xml) return cases;
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1], body = m[3] ?? "";
    const fail = body.match(/<(failure|error)\b([^>]*)(\/>|>([\s\S]*?)<\/(?:failure|error)>)/i);
    const skipped = /<skipped\b/i.test(body);
    let failureMessage = null;
    if (fail) failureMessage = xattr(fail[2], "message") || (fail[4] ? decodeXml(fail[4].trim()) : "") || "Failed";
    const t = xattr(attrs, "time");
    cases.push({ name: xattr(attrs, "name") ?? "case", classname: xattr(attrs, "classname"), time: t ? Number(t) : undefined, ok: !fail && !skipped, failureMessage, skipped });
  }
  return cases;
}
function normalizeEndpoint(name) {
  const m = name.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s+(\/\S*)/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : name.trim();
}
function inferMeaning(error) {
  const e = (error || "").toLowerCase();
  if (/\b5\d{2}\b/.test(e) && /(missing|required|null|undefined|empty)/.test(e)) return "missing-field-returns-5xx";
  if (/\b500\b/.test(e)) return "server-error-5xx";
  if (/\b(401|403)\b/.test(e) || /unauthor/.test(e)) return "auth-rejected";
  if (/\b404\b/.test(e)) return "not-found-404";
  if (/schema|does not (match|conform)|invalid response|content.type/.test(e)) return "response-schema-mismatch";
  return null;
}
function adaptMaestro(xml) {
  return parseJUnit(xml).filter((c) => !c.skipped).map((c) => ({
    spec_path: c.classname || c.name, name: c.name, attempts: [c.ok],
    duration_ms: c.time != null ? Math.round(c.time * 1000) : undefined,
    error_message: c.ok ? null : c.failureMessage ?? "Maestro flow failed",
    discipline: "mobile", engine: "maestro",
  }));
}
function adaptSchemathesis(xml) {
  return parseJUnit(xml).filter((c) => !c.skipped).map((c) => {
    const endpoint = normalizeEndpoint(c.name);
    return {
      spec_path: `contract:${endpoint}`, name: c.name, attempts: [c.ok],
      duration_ms: c.time != null ? Math.round(c.time * 1000) : undefined,
      error_message: c.ok ? null : c.failureMessage ?? "Contract check failed",
      discipline: "api", engine: "schemathesis", layer: "contract", endpoint,
      meaning: c.ok ? null : inferMeaning(c.failureMessage ?? ""),
    };
  });
}
function zapRisk(r) { return r === "3" ? "high" : r === "2" ? "medium" : r === "1" ? "low" : "info"; }
function stripHtml(s) { return (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function adaptZap(json) {
  const out = [];
  for (const site of json.site ?? []) for (const al of site.alerts ?? []) out.push({
    engine: "zap", ruleId: al.pluginid ?? al.alertRef ?? "zap", title: al.alert ?? al.name ?? "ZAP alert",
    severity: zapRisk(al.riskcode), message: stripHtml(al.desc),
    url: (al.instances?.[0]?.uri) ?? site["@name"] ?? null,
    cwe: al.cweid && al.cweid !== "-1" ? `CWE-${al.cweid}` : null,
    count: al.count ? Number(al.count) : (al.instances?.length ?? 1),
  });
  return collapseFindings(out);
}
function semSev(s) { s = (s ?? "").toUpperCase(); return s === "ERROR" ? "high" : s === "WARNING" ? "medium" : s === "INFO" ? "low" : "info"; }
function adaptSemgrep(json) {
  const out = [];
  for (const r of json.results ?? []) {
    const cw = r.extra?.metadata?.cwe; const cwe = Array.isArray(cw) ? cw[0] : cw;
    out.push({
      engine: "semgrep", ruleId: r.check_id ?? "semgrep",
      title: (r.check_id ?? "Finding").split(".").pop() ?? "Finding",
      severity: semSev(r.extra?.severity), message: r.extra?.message ?? "",
      filePath: r.path ?? null, line: r.start?.line ?? null,
      cwe: cwe ? (String(cwe).startsWith("CWE") ? String(cwe).split(":")[0] : cwe) : null,
    });
  }
  return collapseFindings(out);
}
function collapseFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = [f.engine, f.ruleId, f.filePath ?? "", f.line ?? "", f.url ?? ""].join("|");
    const ex = byKey.get(key);
    if (ex) ex.count = (ex.count ?? 1) + (f.count ?? 1);
    else byKey.set(key, { ...f, count: f.count ?? 1 });
  }
  return [...byKey.values()];
}
function artilleryMetrics(agg) {
  const c = agg.counters ?? {};
  const rt = agg.summaries?.["http.response_time"] ?? agg.summaries?.["http.response_time.2xx"];
  const requests = c["http.requests"] ?? agg.requestsCompleted ?? 0;
  const responses = c["http.responses"] ?? requests;
  let codeErrors = 0;
  for (const [k, v] of Object.entries(c)) { const m = k.match(/^http\.codes\.(\d{3})$/); if (m && Number(m[1]) >= 400) codeErrors += v; }
  const explicit = Object.entries(c).filter(([k]) => k.startsWith("errors.")).reduce((a, [, v]) => a + v, 0);
  const failed = c["vusers.failed"] ?? 0;
  const errors = Math.max(codeErrors + explicit, failed, Math.max(0, requests - responses));
  const denom = requests || responses || 0;
  return {
    requests, errors, errorRate: denom > 0 ? Math.min(1, errors / denom) : 0,
    p50: rt?.median ?? agg.latency?.median ?? null, p95: rt?.p95 ?? agg.latency?.p95 ?? null,
    p99: rt?.p99 ?? agg.latency?.p99 ?? null, min: rt?.min ?? agg.latency?.min ?? null,
    max: rt?.max ?? agg.latency?.max ?? null, rps: agg.rates?.["http.request_rate"] ?? null,
  };
}
function adaptArtillery(json, t) { return { engine: "artillery", tier: t, aggregate: artilleryMetrics(json.aggregate ?? {}) }; }
function adaptLighthouse(lhr, t) {
  const a = lhr.audits ?? {};
  const num = (k) => (a[k]?.numericValue != null ? Math.round(a[k].numericValue) : null);
  const score = lhr.categories?.performance?.score;
  return {
    engine: "lighthouse", tier: t,
    aggregate: { requests: 0, errors: 0, errorRate: 0, p50: null, p95: null, p99: null },
    webVitals: {
      performanceScore: score != null ? Math.round(score * 100) : null,
      lcp: num("largest-contentful-paint"), cls: a["cumulative-layout-shift"]?.numericValue ?? null,
      tbt: num("total-blocking-time"), fcp: num("first-contentful-paint"),
    },
  };
}

/* ----------------------- build + post payload ---------------------- */
const base = {
  tier,
  trigger: tier === "fast" ? "pr" : "merge",
  commit_sha: commitSha,
  branch,
  pr_number: process.env.VERITY_PR_NUMBER ? Number(process.env.VERITY_PR_NUMBER) : null,
  results: [],
};

let payload;
let label;
switch (engine) {
  case "mobile": {
    const results = adaptMaestro(readReport());
    payload = { ...base, discipline: "mobile", results };
    label = `Mobile (Maestro) — ${results.length} flow(s)`;
    break;
  }
  case "contract": {
    const results = adaptSchemathesis(readReport());
    // API discipline so it groups with flow tests in the dashboard (Flow vs Contract).
    payload = { ...base, discipline: "api", results };
    label = `API contract (Schemathesis) — ${results.length} operation(s)`;
    break;
  }
  case "perf": {
    const perf = adaptArtillery(JSON.parse(readReport()), tier);
    payload = { ...base, discipline: "performance", results: [], perf };
    label = `Performance (Artillery) — ${tier === "fast" ? "Perf smoke check" : "Full load test"}`;
    break;
  }
  case "lighthouse": {
    const perf = adaptLighthouse(JSON.parse(readReport()), tier);
    payload = { ...base, discipline: "performance", results: [], perf };
    label = `Performance (Lighthouse) — Core Web Vitals`;
    break;
  }
  case "security-dast": {
    const findings = adaptZap(JSON.parse(readReport()));
    payload = { ...base, discipline: "security", results: [], findings };
    label = `Security DAST (ZAP) — ${findings.length} finding(s)`;
    break;
  }
  case "security-sast": {
    const findings = adaptSemgrep(JSON.parse(readReport()));
    payload = { ...base, discipline: "security", results: [], findings };
    label = `Security SAST (Semgrep) — ${findings.length} finding(s)`;
    break;
  }
}

console.log(`▶ Verity ${label} — commit ${commitSha.slice(0, 7)} on ${branch}`);
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
console.log(`✓ ${data.tier_label ?? label} ingested (run ${data.run_id ?? "?"}).`);
// New disciplines never fail the build here — security findings are advisory and
// perf is informational; the dashboard/Check Run surfaces severity.
process.exit(0);
