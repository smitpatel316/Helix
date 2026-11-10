/// <reference types="node" />
// Plan 00 regression tests P-01..P-11: R-package provisioning. Runs under
// `npm test`, after tests/reference.ts, in its own process (its own R).
//
// The tests install from the BUNDLED repo (webr-repo/, served on localhost),
// never the CDN — on Hatch the WASM side cannot reach the internet at all
// (its network stack bypasses the egress proxy), so the bundled path is the
// only one provable here, and it is the shipping path. If webr-repo/ was not
// built yet, the file prints a warning and skips (never silently passes):
// run scripts/build-webr-repo.sh first.
//
// Expected values were measured in this same webR (R 4.6.0, webR 0.6.0) —
// see the per-test provenance comments. Where WebR disagreed with the plan's
// assumed value, the measured value is pinned and the disagreement is
// recorded, not forced (plan 00's rule).
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensurePackages,
  evalNamedVector,
  installedPackageVersions,
  packageDiagnostics,
  packageStatus,
  setPackageRepo,
  startR,
  PACKAGE_INSTALL_TIMEOUT_MS,
  PACKAGE_REGISTRY,
  R_VERSION,
  WEBR_VERSION,
  PackageError,
} from "../src/stats/webr";
import { packageGate } from "../src/stats";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_DIR = `${ROOT}webr-repo`;
const CONTRIB = `${REPO_DIR}/bin/emscripten/contrib/4.6`;

// ── Harness ────────────────────────────────────────────────────────────

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}
const close = (got: number | null | undefined, want: number, tol: number, label: string) =>
  check(label, got != null && Math.abs(got - want) <= tol, `got ${got}, want ${want} ± ${tol}`);
const relClose = (got: number | null | undefined, want: number, rel: number, label: string) =>
  check(
    label,
    got != null && Math.abs(got - want) <= rel * Math.max(Math.abs(want), 1e-300),
    `got ${got}, want ${want} ± ${rel * 100}%`,
  );

// ── Repo checks (no R needed) ──────────────────────────────────────────

const manifestPath = `${REPO_DIR}/MANIFEST.json`;
if (!existsSync(manifestPath)) {
  console.log(
    "⚠ webr-repo/ is not built — package tests skipped. Run scripts/build-webr-repo.sh, then re-run npm test.",
  );
  process.exit(0);
}
const buildManifest = JSON.parse(readFileSync(`${ROOT}scripts/webr-repo-manifest.json`, "utf8")) as {
  webr: string;
  r: string;
  packages: { name: string; version: string }[];
};
const repoManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  webr: string;
  r: string;
  packages: { name: string; version: string; file: string; md5: string }[];
};
check("manifest webr version", buildManifest.webr === WEBR_VERSION, `${buildManifest.webr} vs ${WEBR_VERSION}`);
check("manifest R version", buildManifest.r === R_VERSION, `${buildManifest.r} vs ${R_VERSION}`);
check("repo manifest webr version", repoManifest.webr === WEBR_VERSION);
check("repo manifest R version", repoManifest.r === R_VERSION);
const manifestVersions = new Map(buildManifest.packages.map((p) => [p.name, p.version]));
check(
  "registry matches build manifest",
  PACKAGE_REGISTRY.length === buildManifest.packages.length &&
    PACKAGE_REGISTRY.every((p) => manifestVersions.get(p.name) === p.version),
  "pinned versions drifted between src/stats/webr.ts and scripts/webr-repo-manifest.json",
);
const repoVersions = new Map(repoManifest.packages.map((p) => [p.name, p.version]));
check(
  "repo manifest matches registry",
  PACKAGE_REGISTRY.every((p) => repoVersions.get(p.name) === p.version),
  "the vendored repo is not the pinned set — rebuild it",
);
const repoFiles = new Set(readdirSync(CONTRIB));
for (const p of repoManifest.packages) {
  check(`repo has ${p.file}`, repoFiles.has(p.file) && statSync(`${CONTRIB}/${p.file}`).isFile());
}
check("repo has trimmed PACKAGES", repoFiles.has("PACKAGES"));
check("repo has PACKAGES.rds", repoFiles.has("PACKAGES.rds")); // R tries the .rds first; without it every session wastes a failed fetch
const indexText = readFileSync(`${CONTRIB}/PACKAGES`, "utf8");
for (const p of repoManifest.packages) {
  check(`index lists ${p.name}`, new RegExp(`^Package: ${p.name}$`, "m").test(indexText));
}
check("repo includes codetools", repoVersions.has("codetools"), "multcomp Imports it; webR's base library does not ship it");

// ── Serve the bundled repo on localhost ────────────────────────────────

const MIME: Record<string, string> = { ".tgz": "application/gzip", ".gz": "application/gzip" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url!.split("?")[0]).replace(/^\/+/, "");
  const file = `${REPO_DIR}/${path}`;
  if (!path || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = path.slice(path.lastIndexOf("."));
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const repoUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// No CDN fallback in tests: every install must come from the bundled repo.
setPackageRepo(repoUrl, { allowCdnFallback: false });

await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));

// P-11 — cold-start budget, first: engine-ready to `survival` ready, bundled
// path. (Must run before any other install.)
{
  const t0 = Date.now();
  await ensurePackages(["survival"]);
  const ms = Date.now() - t0;
  console.log(`cold start: survival ready in ${(ms / 1000).toFixed(1)}s (budget ${PACKAGE_INSTALL_TIMEOUT_MS / 1000}s)`);
  check("P-11 cold-start budget", ms < PACKAGE_INSTALL_TIMEOUT_MS, `${ms}ms`);
}

// P-01 — survival loads; version matches the pin (R reports "3.8.12" for
// CRAN "3.8-12": package_version comparison, not string equality); coxph exists.
{
  await ensurePackages(["survival"]);
  check("P-01 survival ready", packageStatus("survival").status === "ready");
  const v = await evalNamedVector(
    `c(match=as.numeric(packageVersion("survival")==package_version("3.8-12")), coxph=as.numeric(exists("coxph", where=asNamespace("survival"))))`,
  );
  check("P-01 survival version is the pin", v.match === 1, `match=${v.match}`);
  check("P-01 coxph exists", v.coxph === 1);
  const versions = await installedPackageVersions();
  check("P-01 installed version reported", versions.survival === "3.8.12", versions.survival);
}

// P-02 — pROC on perfectly separated data: AUC is exactly 1 (hand-computed:
// every positive outranks every negative).
{
  await ensurePackages(["pROC"]);
  const r = await evalNamedVector(
    `r<-pROC::roc(response=c(0,0,1,1), predictor=c(0.1,0.2,0.8,0.9), quiet=TRUE); c(auc=as.numeric(pROC::auc(r)))`,
  );
  check("P-02 pROC AUC is 1", r.auc === 1, `auc=${r.auc}`);
}

// P-03 — survdiff on the survival reference table equals the TypeScript
// log-rank already in tests/reference.json (chi-square 0.5280480582,
// p 0.4674286543). Measured in WebR: 0.5280480582113541 / 0.4674286542802889.
{
  await ensurePackages(["survival"]);
  const r = await evalNamedVector(
    `t<-c(3,7,10,15,20);ts<-c(1,0,1,1,0);p<-c(5,7,8,12,15);ps<-c(1,1,1,0,1);` +
      `d<-survival::survdiff(survival::Surv(c(t,p),c(ts,ps))~factor(rep(c("T","P"),each=5)));` +
      `c(chisq=unname(d$chisq),p=1-pchisq(d$chisq,1))`,
  );
  relClose(r.chisq, 0.5280480582, 1e-6, "P-03 survdiff chi-square matches TS log-rank");
  close(r.p, 0.4674286543, 1e-6, "P-03 survdiff p matches TS log-rank");
}

// P-04 — Grubbs' G on c(1,2,3,4,5,100): hand computation from the definition
// (max deviation / sample SD) gives ≈ 2.04. Measured in WebR
// (outliers 0.15): G 2.0399410222962713, p 1.826019849993088e-06.
// Note: grubbs.test's statistic is a 2-vector c(G, U); G is element 1.
{
  await ensurePackages(["outliers"]);
  const r = await evalNamedVector(
    `g<-outliers::grubbs.test(c(1,2,3,4,5,100)); c(G=unname(g$statistic[1]), p=g$p.value)`,
  );
  relClose(r.G, 2.0399410222962713, 1e-6, "P-04 Grubbs G");
  relClose(r.p, 1.826019849993088e-06, 1e-6, "P-04 Grubbs p");
}

// P-06 — Anderson–Darling on a seeded normal sample. Pinned from this webR
// (R 4.6.0, nortest 1.0-4): A 0.3090447325819383, p 0.5461174681840957.
{
  await ensurePackages(["nortest"]);
  const r = await evalNamedVector(
    `set.seed(42); x<-rnorm(50); a<-nortest::ad.test(x); c(A=unname(a$statistic), p=a$p.value)`,
  );
  relClose(r.A, 0.3090447325819383, 1e-6, "P-06 ad.test statistic");
  relClose(r.p, 0.5461174681840957, 1e-6, "P-06 ad.test p");
  const hasPearson = await evalNamedVector(`c(e=as.numeric(exists("pearson.test", where=asNamespace("nortest"))))`);
  check("nortest pearson.test exists (D'Agostino–Pearson)", hasPearson.e === 1);
}

// P-07 — lmer on a small balanced repeated-measures design, seeded so the
// fit converges cleanly (a noiseless design is singular in lme4 — the
// residual variance sits on the 0 boundary and the optimizer stalls).
// Pinned from this webR (R 4.6.0, lme4 2.0-6, lmerTest 3.2-1). The REML
// criterion is -2 * logLik(m); summary(m)$logLik carries no REMLcrit
// attribute, so do not read it from there.
{
  await ensurePackages(["lme4", "lmerTest"]);
  const data = `set.seed(11); subj<-factor(rep(1:6,each=4)); grp<-factor(rep(c("A","B"),each=12)); tm<-rep(0:3,6);` +
    ` off<-rep(c(0,2,-1,0,2,-1),each=4); y<-10+5*(grp=="B")+1.5*tm+off+rnorm(24,0,0.5);` +
    ` m<-lmerTest::lmer(y~grp+tm+(1|subj), REML=TRUE);`;
  const r = await evalNamedVector(
    data +
      ` vc<-as.data.frame(lme4::VarCorr(m)); s<-summary(m);` +
      ` c(intercept=unname(lme4::fixef(m)[1]), grpB=unname(lme4::fixef(m)[2]), time=unname(lme4::fixef(m)[3]),` +
      ` reml=-2*as.numeric(stats::logLik(m)), subjVar=vc$vcov[1], residVar=vc$vcov[2],` +
      ` p_grpB=s$coefficients["grpB","Pr(>|t|)"], p_time=s$coefficients["tm","Pr(>|t|)"],` +
      ` singular=as.numeric(lme4::isSingular(m)))`,
  );
  relClose(r.intercept, 10.192633519429153, 1e-6, "P-07 lmer intercept");
  relClose(r.grpB, 4.965601637538997, 1e-6, "P-07 lmer group effect");
  relClose(r.time, 1.4972051425844526, 1e-6, "P-07 lmer time effect");
  relClose(r.reml, 43.655232600536834, 1e-4, "P-07 lmer REML criterion");
  relClose(r.subjVar, 2.933609226396992, 1e-6, "P-07 lmer subject variance");
  relClose(r.residVar, 0.1337003144264081, 1e-6, "P-07 lmer residual variance");
  relClose(r.p_grpB, 0.024216126543452936, 1e-6, "P-07 lmerTest Satterthwaite p (group)");
  relClose(r.p_time, 4.567767328845441e-14, 1e-6, "P-07 lmerTest Satterthwaite p (time)");
  check("P-07 lmer fit is not singular", r.singular === 0, `singular=${r.singular}`);
}

// P-08 — three concurrent ensurePackages(["multcomp"]) install it once.
{
  const before = packageDiagnostics().installsStarted;
  await Promise.all([ensurePackages(["multcomp"]), ensurePackages(["multcomp"]), ensurePackages(["multcomp"])]);
  const after = packageDiagnostics().installsStarted;
  check("P-08 concurrent calls all resolve", packageStatus("multcomp").status === "ready");
  check("P-08 package installed once", after - before === 1, `installs started: ${after - before}`);
}

// P-10 — offline simulation: the repo URL is unreachable (connection
// refused). Must reject with the network error inside the install bound — and
// a retry against the good repo must then succeed (failed is sticky only
// until a successful reinstall). MethComp is still fresh here.
{
  setPackageRepo("http://127.0.0.1:1", { allowCdnFallback: false });
  const t0 = Date.now();
  let kind: string | null = null;
  try {
    await ensurePackages(["MethComp"]);
  } catch (err) {
    kind = err instanceof PackageError ? err.kind : "other";
  }
  const ms = Date.now() - t0;
  check("P-10 unreachable repo rejects as network", kind === "network", `kind=${kind}`);
  check("P-10 rejects within the bound", ms < PACKAGE_INSTALL_TIMEOUT_MS, `${ms}ms`);
  check("P-10 status is failed", packageStatus("MethComp").status === "failed");
  setPackageRepo(repoUrl, { allowCdnFallback: false });
  await ensurePackages(["MethComp"]);
  check("P-10 retry after failure succeeds", packageStatus("MethComp").status === "ready");
}

// P-09 — a bogus name rejects typed, is recorded failed, and poisons nothing:
// a good package still installs afterwards (nlme is fresh here).
{
  let kind: string | null = null;
  try {
    await ensurePackages(["not-a-real-package"]);
  } catch (err) {
    kind = err instanceof PackageError ? err.kind : "other";
  }
  check("P-09 bogus name rejects as not-in-registry", kind === "not-in-registry", `kind=${kind}`);
  check("P-09 bogus name status is failed", packageStatus("not-a-real-package").status === "failed");
  await ensurePackages(["nlme"]);
  check("P-09 good package still installs", packageStatus("nlme").status === "ready");
}

// P-05 — Deming on exact linear data y = 2x (error ratio 1). The plan
// assumed slope 2 / intercept 0 to 1e-9; WebR disagrees: deming::deming
// 1.4-1 returns slope 1.9999988928883004, intercept 0.000003321335098949163
// — the same values for n = 5 and n = 10, a deterministic artifact of its
// internal fitting routine, not data noise. Pinned as measured, tolerance
// 1e-5 (10x the observed deviation). MethComp::Deming on the same data is
// exact (0 / 2), which is the cross-check the plan asked for.
{
  await ensurePackages(["deming", "MethComp"]);
  const r = await evalNamedVector(
    `d<-deming::deming(c(2,4,6,8,10)~c(1,2,3,4,5)); c(slope=unname(d$coefficients[2]), intercept=unname(d$coefficients[1]))`,
  );
  relClose(r.slope, 1.9999988928883004, 1e-9, "P-05 deming slope is reproducible");
  close(r.slope, 2, 1e-5, "P-05 deming slope is 2 within its numerical error");
  close(r.intercept, 0, 1e-5, "P-05 deming intercept is 0 within its numerical error");
  const m = await evalNamedVector(
    `d<-MethComp::Deming(y=c(2,4,6,8,10), x=c(1,2,3,4,5)); c(intercept=unname(d[1]), slope=unname(d[2]))`,
  );
  check("P-05 MethComp Deming is exact", m.intercept === 0 && m.slope === 2, `intercept=${m.intercept} slope=${m.slope}`);
}

// Registry smoke — every remaining pinned package proves it computes, so a
// dependent plan starts from a verified install, not an index listing.
{
  // Dunnett via multcomp::glht (plan 25), on the reference column table's
  // Control/Low/High values. Pinned from this webR (multcomp 1.4-32).
  const dunnett = await evalNamedVector(
    `v<-c(12.1,11.4,13.2,12.8,10.9,12.5,11.8,14, 14.3,15.1,13.8,16.2,14.9,14.1,15.5,14.5,` +
      ` 18.2,19.9,17.5,21.3,18.8,20.1,19.4,19); gr<-factor(rep(c("C","L","H"),each=8));` +
      ` g<-multcomp::glht(aov(v~gr), linfct=multcomp::mcp(gr="Dunnett")); s<-summary(g);` +
      ` c(p_LC=s$test$pvalues[1], p_HC=s$test$pvalues[2])`,
  );
  relClose(dunnett.p_LC, 1.0460521338018225e-11, 1e-6, "multcomp Dunnett p (Low vs Control)");
  relClose(dunnett.p_HC, 0.00014778820969441053, 1e-6, "multcomp Dunnett p (High vs Control)");
  // mvtnorm under multcomp (plan 25).
  const mvt = await evalNamedVector(
    `c(p=mvtnorm::pmvnorm(lower=c(-1,-1), upper=c(1,1), mean=c(0,0), sigma=diag(2))[1])`,
  );
  relClose(mvt.p, 0.46606494267439214, 1e-6, "mvtnorm pmvnorm");
  // Cox regression (plan 10) on the survival reference data.
  const cox = await evalNamedVector(
    `t<-c(3,7,10,15,20,5,7,8,12,15); s<-c(1,0,1,1,0,1,1,1,0,1); x<-rep(c(0,1),each=5);` +
      ` c(coef=unname(survival::coxph(survival::Surv(t,s)~x)$coefficients))`,
  );
  relClose(cox.coef, 0.5785983558686906, 1e-6, "survival coxph coefficient");
  // nlme agrees with lmer on the P-07 data to 1e-9 (plan 20's alternative).
  const nlme = await evalNamedVector(
    `set.seed(11); subj<-factor(rep(1:6,each=4)); grp<-factor(rep(c("A","B"),each=12)); tm<-rep(0:3,6);` +
      ` off<-rep(c(0,2,-1,0,2,-1),each=4); y<-10+5*(grp=="B")+1.5*tm+off+rnorm(24,0,0.5);` +
      ` m<-nlme::lme(y~grp+tm, random=~1|subj, method="REML");` +
      ` c(intercept=unname(nlme::fixef(m)[1]), grpB=unname(nlme::fixef(m)[2]), time=unname(nlme::fixef(m)[3]))`,
  );
  close(nlme.intercept, 10.192633519429153, 1e-9, "nlme intercept matches lmer");
  close(nlme.grpB, 4.965601637538997, 1e-9, "nlme group effect matches lmer");
  close(nlme.time, 1.4972051425844526, 1e-9, "nlme time effect matches lmer");
  // The wizard gate: no current analysis needs a package, so nothing blocks.
  check("package gate is open with no required packages", !packageGate("anova").blocked);
  // The vendored PACKAGES.rds (plan 00 fix, 2026-11-09): R's
  // available.packages reads it before falling back to PACKAGES.gz, so a
  // repo without it wastes a failed fetch on the first install of a session.
  // It must list exactly the vendored closure (repoManifest.packages — the
  // 45-package closure, not the 11-package registry: the registry names
  // only the pinned direct dependencies, the repo also ships their
  // transitive deps). A stale or foreign .rds would let install.packages
  // resolve against packages this build does not ship.
  {
    const names = repoManifest.packages.map((p) => JSON.stringify(p.name)).join(",");
    const rds = await evalNamedVector(
      `f<-tempfile(fileext=".rds"); download.file(paste0(${JSON.stringify(repoUrl)}, "/bin/emscripten/contrib/4.6/PACKAGES.rds"), f, quiet=TRUE);` +
        ` d<-readRDS(f); c(n=nrow(d), match=as.numeric(setequal(d[,"Package"], c(${names}))))`,
    );
    check(
      "PACKAGES.rds lists exactly the vendored closure",
      rds.n === repoManifest.packages.length && rds.match === 1,
      `n=${rds.n} match=${rds.match}`,
    );
  }
  // Installed versions report the pins (R-normalized: 3.8-12 -> 3.8.12).
  const versions = await installedPackageVersions();
  check("installed versions report lme4", versions.lme4 === "2.0.6", versions.lme4);
  check("installed versions report multcomp", versions.multcomp === "1.4.32", versions.multcomp);
}

server.close();
for (const f of failures) console.log(`✗ ${f}`);
console.log(failures.length ? `${failures.length} of ${checks} package checks failed.` : `All ${checks} package checks pass.`);
process.exitCode = failures.length ? 1 : 0;
process.exit();
