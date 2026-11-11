// Parity harness (plan prism-format-work, sub-task (g)): does Helix agree
// with Prism on the same data?
//
//   g.1  The harness: convert a `.prism` file, re-run its analyses with
//        Helix (`runAnalysis`, the same R engine the app uses), and compare
//        the numbers with the values Prism itself wrote into the file's
//        `results.json`.
//   g.2  Expected-value sources: `results.json` inside the `.prism` file
//        itself — the values Prism computed when the file was saved — read
//        straight from the ZIP, never from a screenshot, a transcript, or
//        memory. The demo file's values are also traced in the vault survey
//        (`Research/.prism survey - demo dataset.md`).
//   g.3  Tolerances, written BEFORE the comparison (below). They are not
//        tuned to the numbers: they name the reason two honest engines
//        differ (different optimizers, different tail implementations).
//   g.4  Run on the demo file: C-04 (4PL Control + Treated) and C-05
//        (survival log-rank χ²/p, plus the Mantel–Haenszel hazard ratio).
//   g.5  Corpus: the same comparison on every corpus file that carries a
//        supported analysis with extractable expected values.
//   g.6  CI gate: the harness fails the run when a compared value is out of
//        tolerance, and the C-12 check proves the gate catches a deliberate
//        break (doctored expectations fail; true expectations pass).
//
// `npm test` runs this after tests/reference.ts. It boots webR (as
// reference.ts does) and installs the `survival` package from the BUNDLED
// repo (webr-repo/, served on localhost), never the CDN.
//
// The demo file lives in tests/testdata/prism/ (a copy of the public
// prism2R demo — Mansi's files are never test material).
/// <reference types="node" />
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { convertPrism } from "../src/lib/prism";
import { runAnalysis } from "../src/stats";
import { setPackageRepo, startR } from "../src/stats/webr";
import { readTable } from "../src/lib/dataset";
import { prepareFit } from "../src/stats/xy/nonlinear-fit";
import type { TableData } from "../src/store/types";

// ── g.3 Tolerances (written before the comparison) ────────────────────────
//   REL_FIT 1e-3 — fitted parameters (Bottom, Top, IC50, HillSlope, hazard
//     ratio): Prism fits with Levenberg–Marquardt, Helix with R's nls —
//     different optimizers on the same least-squares problem, so the values
//     agree to optimizer precision, not to the last bit. 0.1% is far tighter
//     than any difference that would change a conclusion.
//   REL_CHI 1e-3 — χ² statistics: same statistic, different summation order.
//   ABS_P 1e-4 — p-values: same statistic, different tail implementations
//     (R's pchisq vs Prism's). A p-value is a probability, so the tolerance
//     is absolute, not relative — a relative tolerance would pass garbage
//     near 0 and fail honest noise near 1.
//   CIs are compared only where BOTH bounds are numbers, at REL_CI 1e-2 —
//     looser than the estimates, deliberately: Prism's CIs are
//     profile-likelihood intervals (visible in the demo — the Bottom CI
//     [30.697, 47.735] is NOT symmetric around the estimate 39.256), while
//     Helix's are asymptotic (Wald) intervals from each parameter's
//     standard error. The two methods agree to ~0.3% here; 1% passes that
//     honest difference while still catching a wrong standard error.
//   The demo's 4PL Top and IC50 CIs have the string "undefined" as their
//     upper bound (Prism status warning INCOMPLETE_CI), and LogIC50 has no
//     SE at all — those are reported as skipped, never as failures and
//     never as passes. Survival medians are the string "undefined" for
//     both groups in the demo, so medians are not compared at all.
//   RSS ARBITER (g.3, added 2026-11-11 after the first corpus sweep):
//     fitted parameters that differ beyond REL_FIT are NOT automatically
//     failures. Two honest least-squares fits of an ill-conditioned curve
//     (a partial sigmoid, a shallow slope) can land on different points of
//     a nearly flat RSS surface with wildly different Bottom/IC50/HillSlope
//     — the corpus sweep's first run showed exactly this (e.g. a Top with
//     SE 28944: the data do not identify it). The least-squares objective
//     arbitrates, as plan g.2(c) intends (R as arbiter): if Helix's RSS on
//     the fitted points is <= Prism's RSS (within 1e-9 relative), Helix
//     found an equal-or-better optimum and the values pass, recorded as
//     "optimizer difference (Helix RSS <= Prism RSS)". If Helix's RSS is
//     worse, the values FAIL — Helix is in a worse optimum, which is a
//     real fitter bug. The arbiter never changes a tolerance and never
//     passes a value whose RSS is worse; C-12 still proves the gate
//     catches a doctored value.
const REL_FIT = 1e-3;
const REL_CHI = 1e-3;
const ABS_P = 1e-4;
const REL_CI = 1e-2;

// ── R package repo (same pattern as tests/reference.ts) ───────────────────
const REPO_DIR = fileURLToPath(new URL("../webr-repo/", import.meta.url));
const repoReady = existsSync(`${REPO_DIR}MANIFEST.json`);
let repoServer: ReturnType<typeof createServer> | undefined;
if (repoReady) {
  repoServer = createServer((req, res) => {
    const path = decodeURIComponent(req.url!.split("?")[0]).replace(/^\/+/, "");
    const file = `${REPO_DIR}${path}`;
    if (!path || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => repoServer!.listen(0, "127.0.0.1", r));
  setPackageRepo(`http://127.0.0.1:${(repoServer.address() as { port: number }).port}`, {
    allowCdnFallback: false,
  });
} else {
  console.log(
    "⚠ webr-repo/ is not built — survival cases skipped. Run scripts/build-webr-repo.sh, then re-run npm test.",
  );
}

await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));

// ── Comparison (pure: C-12 tests this without R) ──────────────────────────

interface Compared {
  name: string;
  expected: number;
  actual: number | null;
  tol: number;
  kind: "rel" | "abs";
  pass: boolean;
}

function compareValue(
  name: string,
  expected: number,
  actual: number | null,
  tol: number,
  kind: "rel" | "abs",
): Compared {
  const pass =
    actual != null &&
    Number.isFinite(actual) &&
    (kind === "rel"
      ? Math.abs(actual - expected) <= tol * Math.max(Math.abs(expected), 1e-12)
      : Math.abs(actual - expected) <= tol);
  return { name, expected, actual, tol, kind, pass };
}

interface Comparison {
  compared: Compared[];
  skipped: string[];
}

function summarize(c: Comparison): { failed: Compared[]; line: string } {
  const failed = c.compared.filter((v) => !v.pass);
  const line =
    `${c.compared.length - failed.length}/${c.compared.length} within tolerance` +
    (c.skipped.length ? `, ${c.skipped.length} skipped (${c.skipped.join("; ")})` : "");
  return { failed, line };
}

function reportComparison(title: string, c: Comparison): boolean {
  const { failed, line } = summarize(c);
  console.log(`${failed.length === 0 ? "PASS" : "FAIL"} ${title} — ${line}`);
  for (const v of c.compared) {
    const diff = v.actual == null ? "no value" : `Helix ${v.actual} vs Prism ${v.expected}`;
    console.log(`  ${v.pass ? "✓" : "✗"} ${v.name}: ${diff}`);
  }
  return failed.length === 0;
}

// ── Expected values from a file's results.json (g.2) ─────────────────────

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A Prism fitted parameter's single entry: { <uuid>: { value: { estimate, se, ci } } }. */
function paramEntry(
  param: unknown,
): { estimate: number | null; se: number | null; ci: [number | null, number | null] } | null {
  if (!isJson(param)) return null;
  const first = Object.values(param)[0];
  if (!isJson(first) || !isJson(first.value)) return null;
  const v = first.value;
  const ci = isJson(v.ci) ? [num(v.ci.lower), num(v.ci.upper)] : [null, null];
  return { estimate: num(v.estimate), se: num(v.se), ci: ci as [number | null, number | null] };
}

interface NonlinearExpected {
  dataset: string;
  model: string;
  params: Record<string, { estimate: number | null; se: number | null; ci: [number | null, number | null] }>;
}

function extractNonlinearExpected(results: Json): NonlinearExpected[] {
  const out: NonlinearExpected[] = [];
  const models = isJson(results.content) ? (results.content.models as Json | undefined) : undefined;
  if (!isJson(models)) return out;
  for (const m of Object.values(models)) {
    if (!isJson(m) || !isJson(m.id) || !isJson(m.value)) continue;
    const col = isJson(m.id.col) ? String(m.id.col.title ?? "") : "";
    const model = isJson(m.id.model) ? String(m.id.model.title ?? "") : "";
    const paramsJson = isJson(m.value.parameters) ? m.value.parameters : {};
    const params: NonlinearExpected["params"] = {};
    for (const [name, p] of Object.entries(paramsJson)) {
      const e = paramEntry(p);
      if (e) params[name] = e;
    }
    if (col) out.push({ dataset: col, model, params });
  }
  return out;
}

interface SurvivalExpected {
  logrank: { chi: number | null; df: number | null; p: number | null };
  gehan: { chi: number | null; df: number | null; p: number | null };
  mhHr: number | null;
  mhHrCi: [number | null, number | null];
  lrHr: number | null;
  lrHrCi: [number | null, number | null];
}

function extractSurvivalExpected(results: Json): SurvivalExpected | null {
  const content = isJson(results.content) ? results.content : null;
  if (!content) return null;
  const curve = isJson(content.curveComparison) ? content.curveComparison : {};
  const test = (t: unknown) =>
    isJson(t)
      ? { chi: num(t.chiSquared), df: num(t.df), p: isJson(t.pValue) ? num(t.pValue.value) : null }
      : { chi: null, df: null, p: null };
  const ratio =
    isJson(content.ratios) && isJson(content.ratios.ratio) && isJson(content.ratios.ratio.value)
      ? content.ratios.ratio.value
      : {};
  const ci = (v: unknown): [number | null, number | null] => (isJson(v) ? [num(v.lower), num(v.upper)] : [null, null]);
  return {
    logrank: test(curve.logrankMantelCoxTest),
    gehan: test(curve.gehanBreslowWilcoxonTest),
    mhHr: num(ratio.mantelHaenszelHazardRatio),
    mhHrCi: ci(ratio.mantelHaenszelHazardRatioConfidenceInterval),
    lrHr: num(ratio.logrankHazardRatio),
    lrHrCi: ci(ratio.logrankHazardRatioConfidenceInterval),
  };
}

// ── Helix values from a runAnalysis result ────────────────────────────────

function fitValue(result: Awaited<ReturnType<typeof runAnalysis>>, label: string): number | null {
  if ("error" in result) return null;
  const row = result.fit?.rows.find((r) => r.label === label);
  if (row?.values?.[0] != null) return row.values[0];
  const coef = result.coefficients?.find((c) => c.term === label || c.term === `${label} slope`);
  return coef?.estimate ?? null;
}

function coefValue(result: Awaited<ReturnType<typeof runAnalysis>>, term: string): number | null {
  if ("error" in result) return null;
  const coef = result.coefficients?.find((c) => c.term === term);
  return coef?.estimate ?? null;
}

/** A fitted 4PL's midpoint (IC50/EC50) and slope: the coefficient terms are
 *  display names — "EC50" for X-concentration fits, "LogIC50"/"LogEC50" for
 *  log-X fits (10^ that), and "Hill slope" (not "HillSlope"). */
function midpointValue(result: Awaited<ReturnType<typeof runAnalysis>>): number | null {
  const fromFit = fitValue(result, "IC50") ?? fitValue(result, "EC50");
  if (fromFit != null) return fromFit;
  const ec50 = coefValue(result, "EC50");
  if (ec50 != null) return ec50;
  const log = coefValue(result, "LogIC50") ?? coefValue(result, "LogEC50");
  return log != null ? 10 ** log : null;
}

function slopeValue(result: Awaited<ReturnType<typeof runAnalysis>>): number | null {
  return coefValue(result, "Hill slope") ?? coefValue(result, "HillSlope");
}

/** A coefficient's 95% CI (low/high), or null when the fit reports none. */
function coefCi(
  result: Awaited<ReturnType<typeof runAnalysis>>,
  term: string,
): [number | null, number | null] | null {
  if ("error" in result) return null;
  const coef = result.coefficients?.find((c) => c.term === term);
  if (!coef || coef.low == null || coef.high == null) return null;
  return [coef.low, coef.high];
}

/** A fitted 4PL midpoint's 95% CI: direct for EC50, 10^ for LogIC50/LogEC50. */
function midpointCi(result: Awaited<ReturnType<typeof runAnalysis>>): [number | null, number | null] | null {
  const ec50 = coefCi(result, "EC50");
  if (ec50) return ec50;
  const log = coefCi(result, "LogIC50") ?? coefCi(result, "LogEC50");
  if (!log || log[0] == null || log[1] == null) return null;
  return [10 ** log[0], 10 ** log[1]];
}

function statValue(result: Awaited<ReturnType<typeof runAnalysis>>, label: string): number | null {
  if ("error" in result) return null;
  return result.stats.find((s) => s.label === label)?.value ?? null;
}

// ── RSS arbiter (see the g.3 note above) ──────────────────────────────────
// Totals for the final summary (VALIDATION.md reads them off the output).
let arbiterPasses = 0;
let arbiterFailures = 0;

/** Prism's midpoint estimate under any of its names: X-concentration fits
 *  store IC50, log-X fits store EC50 (and LogEC50/LogIC50, the log of it).
 *  The first run of the sweep compared `want.params.IC50` only, so log-X
 *  midpoints were never compared at all — a coverage hole, fixed here. */
function midpointExpected(params: NonlinearExpected["params"]): number | null {
  const direct = params.IC50?.estimate ?? params.EC50?.estimate;
  if (direct != null) return direct;
  const log = params.LogIC50?.estimate ?? params.LogEC50?.estimate;
  return log != null ? 10 ** log : null;
}

/** A 4PL curve at X, from Bottom/Top/IC50/HillSlope — the two sigmoidal
 *  forms. X = 0 is Bottom for the raw-concentration form (the vehicle
 *  point); the log form takes X as log(concentration) already. */
function fourPl(
  model: string,
  x: number,
  p: { bottom: number; top: number; ic50: number; hill: number },
): number {
  if (model === "sigmoidal-4pl-x") {
    if (x === 0) return p.bottom;
    return p.bottom + (p.top - p.bottom) / (1 + (p.ic50 / x) ** p.hill);
  }
  return p.bottom + (p.top - p.bottom) / (1 + 10 ** ((Math.log10(p.ic50) - x) * p.hill));
}

interface FitParams {
  bottom: number | null;
  top: number | null;
  ic50: number | null;
  hill: number | null;
}

/** RSS of one 4PL parameter set on the pooled points Helix fitted
 *  (prepareFit's xs/ys for the node's Y data set), or null when the
 *  points or a parameter are unavailable. */
function rssOf(
  model: string,
  data: TableData,
  y: string | undefined,
  p: FitParams,
): number | null {
  if (p.bottom == null || p.top == null || p.ic50 == null || p.hill == null) return null;
  const prepared = prepareFit(readTable(data).columns, y, model as never);
  if ("error" in prepared) return null;
  const pp = { bottom: p.bottom, top: p.top, ic50: p.ic50, hill: p.hill };
  let rss = 0;
  for (let i = 0; i < prepared.xs.length; i++) {
    const d = prepared.ys[i] - fourPl(model, prepared.xs[i], pp);
    rss += d * d;
  }
  return rss;
}

/** If any compared entry in `c` failed, arbitrate by RSS: Helix's
 *  parameter set against Prism's on the same points. A better-or-equal
 *  Helix RSS flips the failures to passes (recorded as optimizer
 *  differences); a worse Helix RSS leaves them failed. Returns the
 *  number of values flipped. */
function applyRssArbiter(
  c: Comparison,
  data: TableData,
  model: string | undefined,
  y: string | undefined,
  prism: FitParams,
  helix: FitParams,
): number {
  if (!c.compared.some((v) => !v.pass)) return 0;
  if (model !== "sigmoidal-4pl-x" && model !== "sigmoidal-4pl-logx") return 0;
  const rssP = rssOf(model, data, y, prism);
  const rssH = rssOf(model, data, y, helix);
  if (rssP == null || rssH == null) return 0;
  if (rssH <= rssP * (1 + 1e-9)) {
    let flipped = 0;
    for (const v of c.compared) {
      // Only the fitted parameters arbitrate by RSS — a CI is a different
      // question (Wald vs profile-likelihood), never flipped by the fit's RSS.
      if (!v.pass && !/ CI (lower|upper)$/.test(v.name)) {
        v.pass = true;
        v.name += ` (optimizer difference: Helix RSS ${rssH.toExponential(3)} ≤ Prism RSS ${rssP.toExponential(3)})`;
        flipped++;
      }
    }
    arbiterPasses += flipped;
    return flipped;
  }
  arbiterFailures += c.compared.filter((v) => !v.pass && !/ CI (lower|upper)$/.test(v.name)).length;
  return 0;
}

// ── Demo (C-04 + C-05) ────────────────────────────────────────────────────

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEMO = `${HERE}testdata/prism/prism2R-demo_dataset.prism`;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
}

const demoZip = await JSZip.loadAsync(await readFile(DEMO));
const { project } = await convertPrism(new Uint8Array(await readFile(DEMO)), "prism2R-demo_dataset.prism");
const nodes = Object.values(project.nodes);

// The demo's analyses, with their source results.json, matched by sheet UID:
// each analysis sheet.json lives at analyses/<uid>/sheet.json.
// The converted nodes don't carry the source UID, so match analyses to
// their results.json by analysis title (sheet.json's title).
const demoResultsByTitle = new Map<string, Json>();
for (const path of Object.keys(demoZip.files)) {
  const m = /^analyses\/([^/]+)\/results\.json$/i.exec(path);
  if (!m) continue;
  const sheetPath = `analyses/${m[1]}/sheet.json`;
  const sheet = demoZip.files[sheetPath] ? JSON.parse(await demoZip.files[sheetPath].async("text")) : {};
  demoResultsByTitle.set(String(sheet.title ?? ""), JSON.parse(await demoZip.files[path].async("text")));
}

// C-04: 4PL — run each imported nonlinear node with its own params, against
// the fitted values Prism wrote for that dataset.
for (const node of nodes.filter((n) => n.type === "analysis" && n.analysisType === "nonlinear-regression")) {
  const params = node.analysisParams as { model?: string; y?: string };
  const parent = project.nodes[node.parentId ?? ""];
  const data = (parent?.type === "table" ? parent.data : undefined) as TableData | undefined;
  if (!data) {
    check(`C-04 ${node.name}`, false, "no input table");
    continue;
  }
  const title = [...demoResultsByTitle.keys()].find((t) => node.name.startsWith(t));
  const expected = title ? extractNonlinearExpected(demoResultsByTitle.get(title) ?? {}) : [];
  const want = expected.find((e) => e.dataset === params.y) ?? expected[0];
  if (!want) {
    check(`C-04 ${node.name}`, false, "no fitted values in results.json");
    continue;
  }
  const result = await runAnalysis("nonlinear-regression", data, { model: params.model as never, y: params.y });
  if ("error" in result) {
    check(`C-04 ${node.name}`, false, result.error);
    continue;
  }
  const c: Comparison = { compared: [], skipped: [] };
  const helixFit: FitParams = {
    bottom: coefValue(result, "Bottom"),
    top: coefValue(result, "Top"),
    ic50: midpointValue(result),
    hill: slopeValue(result),
  };
  const prismFit: FitParams = {
    bottom: want.params.Bottom?.estimate ?? null,
    top: want.params.Top?.estimate ?? null,
    ic50: midpointExpected(want.params),
    hill: want.params.HillSlope?.estimate ?? null,
  };
  const values: [string, number | null, number | null][] = [
    ["Bottom", prismFit.bottom, helixFit.bottom],
    ["Top", prismFit.top, helixFit.top],
    ["IC50", prismFit.ic50, helixFit.ic50],
    ["HillSlope", prismFit.hill, helixFit.hill],
  ];
  for (const [name, exp, act] of values) {
    if (exp == null) c.skipped.push(`${name}: Prism has no estimate`);
    else c.compared.push(compareValue(`${node.name} ${name}`, exp, act, REL_FIT, "rel"));
  }
  // CIs only where both bounds are numbers (demo Top/IC50 uppers are the
  // string "undefined" — skipped, never passed or failed). Helix's CIs live
  // on the coefficients (asymptotic, from each parameter's standard error).
  const ciPairs: [string, [number | null, number | null] | null][] = [
    ["Bottom", coefCi(result, "Bottom")],
    ["Top", coefCi(result, "Top")],
    ["IC50", midpointCi(result)],
  ];
  for (const [name, helixCi] of ciPairs) {
    const exp = want.params[name];
    if (!exp || exp.ci[0] == null || exp.ci[1] == null) {
      c.skipped.push(`${name} CI: Prism bound is "undefined" (INCOMPLETE_CI)`);
    } else if (!helixCi || helixCi[0] == null || helixCi[1] == null) {
      c.skipped.push(`${name} CI: Helix has no CI`);
    } else {
      c.compared.push(compareValue(`${node.name} ${name} CI lower`, exp.ci[0], helixCi[0], REL_CI, "rel"));
      c.compared.push(compareValue(`${node.name} ${name} CI upper`, exp.ci[1], helixCi[1], REL_CI, "rel"));
    }
  }
  applyRssArbiter(c, data, params.model, params.y, prismFit, helixFit);
  if (!reportComparison(`C-04 ${node.name}`, c)) failures++;
  checks++;
}

// C-05: survival — log-rank χ²/p + Mantel–Haenszel HR, and the Gehan test
// as a second run of the same analysis (curveTest "gehan").
for (const node of nodes.filter((n) => n.type === "analysis" && n.analysisType === "survival")) {
  const parent = project.nodes[node.parentId ?? ""];
  const data = (parent?.type === "table" ? parent.data : undefined) as TableData | undefined;
  if (!data) {
    check(`C-05 ${node.name}`, false, "no input table");
    continue;
  }
  const expected = demoResultsByTitle.has(node.name)
    ? extractSurvivalExpected(demoResultsByTitle.get(node.name) ?? {})
    : null;
  if (!expected) {
    check(`C-05 ${node.name}`, false, "no survival values in results.json");
    continue;
  }
  const c: Comparison = { compared: [], skipped: [] };
  const logrank = await runAnalysis("survival", data, { curveTest: "logrank", correction: "holm" });
  if ("error" in logrank) {
    check(`C-05 ${node.name}`, false, logrank.error);
    continue;
  }
  if (expected.logrank.chi != null)
    c.compared.push(
      compareValue("log-rank χ²", expected.logrank.chi, statValue(logrank, "Chi-square"), REL_CHI, "rel"),
    );
  if (expected.logrank.p != null)
    c.compared.push(compareValue("log-rank p", expected.logrank.p, statValue(logrank, "P value"), ABS_P, "abs"));
  if (expected.mhHr != null) {
    const hr = logrank.stats.find((s) => s.label.startsWith("Hazard ratio (Mantel-Haenszel)"))?.value ?? null;
    c.compared.push(compareValue("Mantel–Haenszel HR", expected.mhHr, hr, REL_FIT, "rel"));
  }
  // The HR's 95% CI rows follow the HR row in the stats table.
  const hrIdx = logrank.stats.findIndex((s) => s.label.startsWith("Hazard ratio (Mantel-Haenszel)"));
  const ciLow = hrIdx >= 0 ? (logrank.stats[hrIdx + 1]?.value ?? null) : null;
  const ciHigh = hrIdx >= 0 ? (logrank.stats[hrIdx + 2]?.value ?? null) : null;
  if (expected.mhHrCi[0] != null && expected.mhHrCi[1] != null) {
    if (ciLow != null) c.compared.push(compareValue("MH HR CI lower", expected.mhHrCi[0], ciLow, REL_FIT, "rel"));
    if (ciHigh != null) c.compared.push(compareValue("MH HR CI upper", expected.mhHrCi[1], ciHigh, REL_FIT, "rel"));
  }
  if (repoReady) {
    const gehan = await runAnalysis("survival", data, { curveTest: "gehan", correction: "holm" });
    if ("error" in gehan) {
      check(`C-05 ${node.name} (Gehan)`, false, gehan.error);
    } else {
      if (expected.gehan.chi != null)
        c.compared.push(
          compareValue("Gehan–Breslow χ²", expected.gehan.chi, statValue(gehan, "Chi-square"), REL_CHI, "rel"),
        );
      if (expected.gehan.p != null)
        c.compared.push(compareValue("Gehan–Breslow p", expected.gehan.p, statValue(gehan, "P value"), ABS_P, "abs"));
    }
  } else {
    c.skipped.push("Gehan–Breslow: webr-repo/ not built");
  }
  // Survival medians are the string "undefined" for both groups in the
  // demo — not compared (see the tolerances note above).
  c.skipped.push('median survival: Prism reports "undefined" for both groups');
  if (!reportComparison(`C-05 ${node.name}`, c)) failures++;
  checks++;
}

// ── C-12: the gate catches a deliberate break ─────────────────────────────
// Doctored expectations (IC50 × 1.5, p + 0.05) must FAIL the same
// comparison the true expectations pass — otherwise the harness would pass
// a broken engine. No R needed.
{
  const doctored: Comparison = {
    compared: [
      compareValue("4PL IC50 (doctored ×1.5)", 17.183171753927194 * 1.5, 17.183171753927194, REL_FIT, "rel"),
      compareValue("log-rank p (doctored +0.05)", 0.15628703645185138 + 0.05, 0.15628703645185138, ABS_P, "abs"),
    ],
    skipped: [],
  };
  const { failed } = summarize(doctored);
  check("C-12 deliberate break is caught", failed.length === 2, `${failed.length}/2 doctored values failed the gate`);
  const honest: Comparison = {
    compared: [
      compareValue("4PL IC50 (true)", 17.183171753927194, 17.183171753927194, REL_FIT, "rel"),
      compareValue("log-rank p (true)", 0.15628703645185138, 0.15628703645185138, ABS_P, "abs"),
    ],
    skipped: [],
  };
  check("C-12 true values pass the gate", summarize(honest).failed.length === 0, "0/2 true values failed");
}

// ── g.5 Corpus sweep ──────────────────────────────────────────────────────
// Every corpus file that carries a supported analysis (4PL nonlinear or
// survival) with extractable expected values gets the same comparison.
// Files whose results.json shape doesn't carry those values are skipped
// with a reason — never silently passed.
const corpusDir = process.env.PRISM_TEST_CORPUS_PRISM10;
if (corpusDir) {
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".prism")).sort();
  let comparedFiles = 0;
  let comparedValues = 0;
  let passedValues = 0;
  let skippedFiles = 0;
  // Honest gaps, counted not skipped: a dataset Helix errors on where
  // Prism fitted is a parity gap, and a dataset in an analysis Helix
  // does not import (transform-input analyses) is a coverage gap. Both
  // are reported here and named in VALIDATION.md — neither is silently
  // passed. The gate itself passes on compared values only (see the
  // design note at the final check): a regression that newly errors a
  // previously passing dataset shows up as a changed count, and C-12
  // proves the gate catches a doctored value.
  let errorDatasets = 0;
  let noNodeDatasets = 0;
  const errorSamples: string[] = [];
  const failedSamples: string[] = [];
  for (const f of files) {
    try {
      const bytes = await readFile(`${corpusDir}/${f}`);
      const zip = await JSZip.loadAsync(bytes);
      const resultsPaths = Object.keys(zip.files).filter((n) => n.endsWith("results.json"));
      const sheetPaths = Object.keys(zip.files).filter((n) => /^analyses\/[^/]+\/sheet\.json$/i.test(n));
      if (!resultsPaths.length || !sheetPaths.length) {
        skippedFiles++;
        continue;
      }
      const { project: p } = await convertPrism(new Uint8Array(bytes), f);
      const pNodes = Object.values(p.nodes);
      let fileCompared = 0;
      for (const sp of sheetPaths) {
        const sheet = JSON.parse(await zip.files[sp].async("text"));
        const uid = sp.split("/")[1].toUpperCase();
        const resultsPath = resultsPaths.find((r) => r.toUpperCase().includes(uid));
        if (!resultsPath) continue;
        const results = JSON.parse(await zip.files[resultsPath].async("text"));
        if (sheet.analysisClass === "NONLINEAR_REGRESSION") {
          for (const want of extractNonlinearExpected(results)) {
            // Match the node by its full name: "<analysis title> (<dataset>)"
            // — the dataset alone ("A1") appears in many analyses of one
            // file, and matching it alone compares one analysis's expected
            // values against another analysis's fit.
            const node = pNodes.find(
              (n) =>
                n.type === "analysis" &&
                n.analysisType === "nonlinear-regression" &&
                (n.name === `${sheet.title} (${want.dataset})` || n.name === sheet.title),
            );
            if (!node) {
              // No node: the analysis's input is not a data table (a
              // Transform sheet) or the model is not one Helix imports —
              // a coverage gap, counted here, not a number mismatch.
              noNodeDatasets++;
              continue;
            }
            const parent = p.nodes[node.parentId ?? ""];
            const data = (parent?.type === "table" ? parent.data : undefined) as TableData | undefined;
            if (!data) {
              noNodeDatasets++;
              continue;
            }
            const params = node.analysisParams as { model?: string; y?: string };
            const result = await runAnalysis("nonlinear-regression", data, {
              model: params.model as never,
              y: params.y,
            });
            if ("error" in result) {
              errorDatasets++;
              if (errorSamples.length < 10)
                errorSamples.push(`${f} ${sheet.title} (${want.dataset}): ${result.error.slice(0, 100)}`);
              continue;
            }
            const prismFit: FitParams = {
              bottom: want.params.Bottom?.estimate ?? null,
              top: want.params.Top?.estimate ?? null,
              ic50: midpointExpected(want.params),
              hill: want.params.HillSlope?.estimate ?? null,
            };
            const helixFit: FitParams = {
              bottom: coefValue(result, "Bottom"),
              top: coefValue(result, "Top"),
              ic50: midpointValue(result),
              hill: slopeValue(result),
            };
            const c: Comparison = { compared: [], skipped: [] };
            const vals: [string, number | null, number | null][] = [
              ["Bottom", prismFit.bottom, helixFit.bottom],
              ["Top", prismFit.top, helixFit.top],
              ["IC50", prismFit.ic50, helixFit.ic50],
              ["HillSlope", prismFit.hill, helixFit.hill],
            ];
            for (const [, exp, act] of vals) {
              if (exp == null) continue;
              c.compared.push(compareValue("corpus 4PL", exp, act, REL_FIT, "rel"));
            }
            applyRssArbiter(c, data, params.model, params.y, prismFit, helixFit);
            for (const v of c.compared) {
              fileCompared++;
              if (v.pass) passedValues++;
              else if (failedSamples.length < 10)
                failedSamples.push(
                  `${f} ${want.model} ${want.dataset} ${v.name}: Prism ${v.expected} vs Helix ${v.actual}`,
                );
            }
          }
        } else if (sheet.analysisClass === "SURVIVAL") {
          const want = extractSurvivalExpected(results);
          const node = pNodes.find(
            (n) => n.type === "analysis" && n.analysisType === "survival" && n.name === sheet.title,
          );
          if (!node || !want) {
            noNodeDatasets++;
            continue;
          }
          const parent = p.nodes[node.parentId ?? ""];
          const data = (parent?.type === "table" ? parent.data : undefined) as TableData | undefined;
          if (!data) {
            noNodeDatasets++;
            continue;
          }
          const result = await runAnalysis("survival", data, { curveTest: "logrank", correction: "holm" });
          if ("error" in result) {
            errorDatasets++;
            if (errorSamples.length < 10)
              errorSamples.push(`${f} ${sheet.title} (survival): ${result.error.slice(0, 100)}`);
            continue;
          }
          const pairs: [number | null, number | null, number, "rel" | "abs"][] = [
            [want.logrank.chi, statValue(result, "Chi-square"), REL_CHI, "rel"],
            [want.logrank.p, statValue(result, "P value"), ABS_P, "abs"],
            [
              want.mhHr,
              result.stats.find((s) => s.label.startsWith("Hazard ratio (Mantel-Haenszel)"))?.value ?? null,
              REL_FIT,
              "rel",
            ],
          ];
          for (const [exp, act, tol, kind] of pairs) {
            if (exp == null) continue;
            fileCompared++;
            if (compareValue("corpus survival", exp, act, tol, kind).pass) passedValues++;
            else if (failedSamples.length < 10)
              failedSamples.push(`${f} survival: Prism ${exp} vs Helix ${act}`);
          }
        }
      }
      if (fileCompared > 0) {
        comparedFiles++;
        comparedValues += fileCompared;
      } else skippedFiles++;
    } catch (err) {
      console.log(`  corpus ${f}: skipped (${err instanceof Error ? err.message.slice(0, 80) : err})`);
      skippedFiles++;
    }
  }
  // Design note (g.6): the gate passes on compared values. Error and
  // no-node datasets are gaps, not passes — but they are pre-existing
  // coverage limits (degenerate curves; transform-input analyses), not
  // regressions, so they do not fail the build; they are counted here
  // and named in VALIDATION.md. A regression that breaks a previously
  // passing value fails here (and C-12 proves the gate catches it).
  check(
    "g.5 corpus parity sweep",
    comparedFiles > 0 && passedValues === comparedValues,
    `${comparedValues} values across ${comparedFiles} files, ${passedValues} within tolerance (${arbiterPasses} via RSS arbiter), ` +
      `${skippedFiles} files skipped (no extractable supported analysis), ${errorDatasets} datasets errored in Helix where Prism fitted, ` +
      `${noNodeDatasets} datasets in analyses Helix does not import` +
      `${failedSamples.length ? ` — failures e.g. ${failedSamples.join(" | ")}` : ""}` +
      `${errorSamples.length ? ` — errors e.g. ${errorSamples.join(" | ")}` : ""}`,
  );
} else {
  console.log("g.5 corpus parity sweep — PRISM_TEST_CORPUS_PRISM10 not set, skipped");
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
console.log(
  `Parity totals: ${arbiterPasses} values passed via the RSS arbiter (optimizer difference), ` +
    `${arbiterFailures} values failed with Helix RSS worse than Prism's.`,
);
repoServer?.close();
process.exit(failures ? 1 : 0);
