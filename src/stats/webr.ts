// WebR engine — R compiled to WASM, running in a Web Worker so the UI never
// blocks. The app has ONE: it lives in a hidden window (engine.ts), and project
// windows send it their R code (`connectR`). Tests and `npm run web` run R here.
// The WebR library is loaded only when R starts, so project windows never carry it.
// R packages (plan 00): base R alone cannot run Cox, ROC, mixed-effects,
// Anderson–Darling, Grubbs, Deming or Dunnett. `ensurePackages` below is the
// one way analyses get a package: it installs the named packages from the
// bundled, version-pinned repo (see scripts/build-webr-repo.sh) into this
// engine and verifies each one loads. No analysis calls `library()` inline —
// analyses use `pkg::fn` after `ensurePackages`, or `runAnalysis` ensures
// the analysis's `requiredPackages` first (src/stats/index.ts).
import type { WebR } from "webr";

/** An R result: a named numeric vector, non-finite values as `null`. */
export type RVector = Record<string, number | null>;

let engine: Promise<WebR> | null = null;
let remote: ((code: string) => Promise<RVector>) | null = null;

/** Start (or reuse) the R runtime. A failed boot is retried on the next call.
 *  `baseUrl` locates the R files: served by the app, or a folder when run by the tests. */
export function startR(baseUrl = "/webr/"): Promise<WebR> {
  return (engine ??= (async () => {
    const { WebR } = await import("webr");
    const webR = new WebR({ baseUrl });
    await webR.init();
    return webR;
  })().catch((err) => {
    engine = null;
    throw err;
  }));
}

/** From now on, `evalNamedVector` hands its code to `evaluate` (the app's engine). */
export function connectR(evaluate: (code: string) => Promise<RVector>) {
  remote = evaluate;
}

/**
 * Evaluate R code that returns an unnamed numeric vector, marshalled to a JS
 * array in order. The vector twin of `evalNamedVector` — what lets an
 * analysis return per-point results (fitted values, a dense curve).
 * Non-finite entries come back as NaN, so positions (and lengths) are
 * preserved. In a project window the code runs in the engine window, which
 * only serves named vectors: the entries are named v1..vn in R and read
 * back in that order.
 */
export async function evalNumericVector(code: string): Promise<number[]> {
  if (remote) {
    const named = await remote(`v<-local({${code}});names(v)<-paste0("v",seq_along(v));v`);
    return Object.keys(named)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((k) => named[k] ?? NaN);
  }
  const webR = await startR();
  const shelter = await new webR.Shelter();
  try {
    const result = await shelter.evalR(`local({${code}})`).catch((err: unknown) => {
      // R says "Error in `call`: reason". The call is our generated code: keep the reason.
      throw new Error(String(err instanceof Error ? err.message : err).replace(/^Error in `[^`]*`\s*:\s*/, ""));
    });
    const { values } = (await result.toJs()) as { values: number[] };
    return values.map((v) => (Number.isFinite(v) ? v : NaN));
  } finally {
    shelter.purge();
  }
}

/**
 * Evaluate R code that returns a named numeric vector, marshalled to a plain
 * `{ name: value }` map. The single primitive every analysis builds on. `local()`
 * gives each run a fresh environment, so analyses can never read each other's variables.
 */
export async function evalNamedVector(code: string): Promise<RVector> {
  if (remote) return remote(code);
  const webR = await startR();
  const shelter = await new webR.Shelter();
  try {
    const result = await shelter.evalR(`local({${code}})`).catch((err: unknown) => {
      // R says "Error in `call`: reason". The call is our generated code: keep the reason.
      throw new Error(String(err instanceof Error ? err.message : err).replace(/^Error in `[^`]*`\s*:\s*/, ""));
    });
    const { names, values } = (await result.toJs()) as { names: string[] | null; values: number[] };
    const out: RVector = {};
    (names ?? []).forEach((name, i) => {
      out[name] = Number.isFinite(values[i]) ? values[i] : null;
    });
    return out;
  } finally {
    shelter.purge();
  }
}

// ── R package provisioning (plan 00) ────────────────────────────────────

/** The webR release this repo is built against (package.json pins it exactly). */
export const WEBR_VERSION = "0.6.0";
/** The R release webR 0.6.0 ships (verified: `R.version.string`). */
export const R_VERSION = "4.6.0";
/** The repo layout's major.minor dir (repo.r-wasm.org uses 4.6, not 4.6.0). */
export const R_MAJOR_MINOR = "4.6";
/** The CDN repo root webR installs from when no bundled repo is configured. */
export const CDN_REPO_URL = "https://repo.r-wasm.org";
/** The bundled repo, served from the app bundle (vite copies webr-repo/). */
export const BUNDLED_REPO_URL = "/webr-repo";

/** One pinned package: CRAN version (as in PACKAGES), CRAN license, and
 *  which plans need it. Versions are pinned, never "latest": a parity result
 *  proven against survival 3.8-12 is not proven against 3.8-13. */
export interface PackageEntry {
  name: string;
  /** CRAN form, e.g. "3.8-12" (R reports it dotted: "3.8.12"). */
  version: string;
  license: string;
  /** Dependent plan numbers, e.g. ["10", "27"]. */
  plans: string[];
  /** What the dependent analyses use it for. */
  uses: string;
}

export const PACKAGE_REGISTRY: PackageEntry[] = [
  { name: "survival", version: "3.8-12", license: "LGPL (>= 2)", plans: ["10", "27"], uses: "Cox regression (coxph), log-rank (survdiff), Kaplan-Meier (survfit)" },
  { name: "pROC", version: "1.19.1", license: "GPL (>= 3)", plans: ["05"], uses: "ROC curves (roc, auc, ci.auc, coords)" },
  { name: "lme4", version: "2.0-6", license: "GPL (>= 2)", plans: ["14", "20"], uses: "Mixed-effects models (lmer); nested-test v2" },
  { name: "lmerTest", version: "3.2-1", license: "GPL (>= 2)", plans: ["20"], uses: "Satterthwaite p-values for lmer fits (lmer wrapper)" },
  { name: "multcomp", version: "1.4-32", license: "GPL-2", plans: ["25"], uses: "Dunnett multiple comparisons (glht)" },
  { name: "mvtnorm", version: "1.2-4", license: "GPL-2", plans: ["25"], uses: "Multivariate t/normal probabilities under multcomp::glht" },
  { name: "nortest", version: "1.0-4", license: "GPL (>= 2)", plans: ["23"], uses: "Anderson–Darling (ad.test); NOT D'Agostino–Pearson — nortest::pearson.test is a binned chi-square goodness-of-fit test, not the omnibus K2 (plan 23 implements K2 in TypeScript)" },
  { name: "outliers", version: "0.15", license: "GPL (>= 2)", plans: ["24"], uses: "Grubbs' outlier test (grubbs.test)" },
  { name: "deming", version: "1.4-1", license: "LGPL (>= 2)", plans: ["13"], uses: "Deming regression (deming); cross-check for the closed-form path" },
  { name: "MethComp", version: "1.30.2", license: "GPL (>= 2)", plans: ["13"], uses: "Deming regression alternative (Deming)" },
  { name: "nlme", version: "3.1-171", license: "GPL (>= 2)", plans: ["14", "20"], uses: "Mixed-effects alternative (lme); Deming via MethComp's dependency" },
];

const registryByName = new Map(PACKAGE_REGISTRY.map((p) => [p.name, p]));

/** A package's install state in this engine's lifetime. Installs are NOT
 *  persisted: webR mounts packages into the in-memory filesystem, so an app
 *  restart re-installs lazily, per analysis — never all at startup. */
export type PackageStatus = "not-loaded" | "loading" | "ready" | "failed";

export type PackageErrorKind =
  | "not-in-registry"
  | "not-in-repo"
  | "network"
  | "install-failed"
  | "load-failed"
  | "timeout";

/** A typed provisioning failure: `kind` decides the user-facing message and
 *  whether a retry can help; `message` is the plain-language detail. */
export class PackageError extends Error {
  constructor(
    readonly kind: PackageErrorKind,
    readonly packageName: string,
    message: string,
  ) {
    super(message);
    this.name = "PackageError";
  }
}

interface PackageState {
  status: PackageStatus;
  /** Last failure's message, while `failed`. */
  error?: string;
  /** Last failure's kind, while `failed`. */
  kind?: PackageErrorKind;
  /** Where the installed copy came from, while `ready`. */
  source?: "bundled" | "cdn";
}

const states = new Map<string, PackageState>();
/** One in-flight install batch, per package it installs. `batch` is the
 *  promise the batch settles on; `cancel` is set by a timeout eviction (B2)
 *  so a batch that outlives its caller never starts a queued install and
 *  its late completion writes no states; `releaseGate` frees the chain
 *  gate so the next batch can start even while this one is still hung. */
interface InstallTicket {
  batch: Promise<void>;
  cancel: { current: boolean };
  releaseGate: () => void;
}
const inflight = new Map<string, InstallTicket>();
/** Serialises install batches: two batches never download at once. Each
 *  batch owns a gate promise; the gate resolves when the batch settles OR
 *  when a timeout evicts it (B2) — so a hung batch can never wedge the
 *  chain: eviction, not the batch's own settlement, advances it. */
let chain: Promise<void> = Promise.resolve();
/** How many install batches actually started (P-08: concurrent calls install once). */
let installsStarted = 0;

const stateOf = (name: string): PackageState =>
  states.get(name) ?? { status: "not-loaded" };

/** The repo installs read from: the bundled repo by default. Tests point it
 *  at a localhost server for the same directory. `null` means webR's default
 *  (the CDN repo root). Never a user-supplied URL. */
let repoUrl: string = BUNDLED_REPO_URL;
let allowCdnFallback = true;

export function setPackageRepo(url: string | null, opts?: { allowCdnFallback?: boolean }) {
  repoUrl = url ?? CDN_REPO_URL;
  if (opts?.allowCdnFallback !== undefined) allowCdnFallback = opts.allowCdnFallback;
}

export function packageRepoSource(): { url: string; allowCdnFallback: boolean } {
  return { url: repoUrl, allowCdnFallback };
}

/** One package's status, for wizards (grey out / explain) and Settings. */
export function packageStatus(name: string): {
  status: PackageStatus;
  version?: string;
  error?: string;
  source?: "bundled" | "cdn";
} {
  const entry = registryByName.get(name);
  const state = stateOf(name);
  return {
    status: state.status,
    version: entry?.version,
    error: state.error,
    source: state.source,
  };
}

/** Diagnostics for tests and Settings: installs started, and every known
 *  package's status. */
export function packageDiagnostics(): {
  installsStarted: number;
  packages: Record<string, { status: PackageStatus; error?: string; source?: "bundled" | "cdn" }>;
} {
  const packages: Record<string, { status: PackageStatus; error?: string; source?: "bundled" | "cdn" }> = {};
  for (const name of new Set([...registryByName.keys(), ...states.keys()])) {
    const s = stateOf(name);
    packages[name] = { status: s.status, error: s.error, source: s.source };
  }
  return { installsStarted, packages };
}

/** The installed version of every `ready` package, for the Settings row.
 *  Versions cross the `evalNamedVector` boundary as numbers: each package
 *  contributes `<name>_n` (component count) + `<name>_1..k` (components),
 *  reassembled here into "3.8.12". A package installed from the bundled repo
 *  is necessarily the pinned version; a CDN install reports what it got. */
export async function installedPackageVersions(): Promise<Record<string, string>> {
  const ready = PACKAGE_REGISTRY.filter((p) => stateOf(p.name).status === "ready").map((p) => p.name);
  if (!ready.length) return {};
  const parts = ready.flatMap((n) => [
    `${JSON.stringify(`${n}_n`)}=length(unlist(packageVersion(${JSON.stringify(n)})))`,
    `${JSON.stringify(`${n}_1`)}=unlist(packageVersion(${JSON.stringify(n)}))[1]`,
    `${JSON.stringify(`${n}_2`)}=unlist(packageVersion(${JSON.stringify(n)}))[2]`,
    `${JSON.stringify(`${n}_3`)}=unlist(packageVersion(${JSON.stringify(n)}))[3]`,
    `${JSON.stringify(`${n}_4`)}=unlist(packageVersion(${JSON.stringify(n)}))[4]`,
    `${JSON.stringify(`${n}_5`)}=unlist(packageVersion(${JSON.stringify(n)}))[5]`,
  ]);
  const out = await evalNamedVector(`c(${parts.join(",")})`);
  const versions: Record<string, string> = {};
  for (const name of ready) {
    const n = out[`${name}_n`];
    if (n == null) continue;
    const comps: number[] = [];
    for (let i = 1; i <= n; i++) {
      const v = out[`${name}_${i}`];
      if (v == null) break;
      comps.push(v);
    }
    if (comps.length === n) versions[name] = comps.join(".");
  }
  return versions;
}

/** `ensurePackages` rejects when the install runs past this long. A timed-out
 *  call EVICTS the stuck batch (B2): its packages leave `inflight`, are
 *  marked `failed` with kind `timeout`, and the chain gate is released, so a
 *  later call starts a fresh install instead of queueing behind the dead
 *  one. The underlying R call itself keeps running in the engine — webR
 *  cannot cancel it — but it can no longer poison anything: a batch evicted
 *  while queued never starts, and its late completion writes no states, so
 *  the retry's install is the one that counts. If the engine itself is
 *  wedged, the retry's install queues behind the hung call in the worker
 *  and times out the same way, bounded, until the engine frees up.
 *
 *  360 s, re-measured 2026-11-12 (B2) — not a guess. The 2026-11-09
 *  120 s budget no longer holds on this host: the largest single batch,
 *  lme4 + lmerTest (21 packages / 27 MB, because lmerTest Imports
 *  ggplot2), now takes 213.6 s cold end to end (base code, fresh engine,
 *  scratch probe `scratch-time-lme4.ts`, shared host at load 6–9 with
 *  other lanes contending) — up from the 71 s worst case measured
 *  2026-11-09. With a 120 s cap the reference suite's mixed-effects
 *  analyses fail even though the install is healthy and progressing;
 *  worse, under B2 eviction the retry then queues behind the still-running
 *  first install in the worker and times out too, so one slow batch fails
 *  twice. The seconds go to WASM-side work, not the network: every .tgz
 *  arrives from localhost in <0.1 s, then R spends ~1–6 s per package
 *  unpacking it and building its lazy-load database, single-threaded,
 *  while the shared host runs at load 6–9. No code change can shrink
 *  that — the closure is the pinned hard-dependency set, and webR cannot
 *  parallelise installs (no fork under Emscripten). 360 s covers the
 *  worst measured batch (213.6 s) with ~1.7x headroom, the same rule the
 *  old 120 s cap used; if the closure grows, re-measure before touching
 *  this again. (A hung install still evicts on timeout — the B2 fix —
 *  it just takes up to 360 s for the caller to learn the install is hung
 *  rather than slow.) */
export const PACKAGE_INSTALL_TIMEOUT_MS = 360_000;

/**
 * Guarantee the named packages are installed and loadable in this engine,
 * then resolve. Concurrent calls for the same package join the one in-flight
 * install; a second call after success is a no-op; a call after failure
 * retries the install — including after a timeout (B2): a timed-out call
 * evicts the stuck batch, so the retry starts a fresh install instead of
 * joining the dead one. Unknown names reject at once with `not-in-registry`
 * and are recorded `failed` — a typo never triggers a download.
 *
 * Installs run through the same `evalNamedVector` path analyses use, so in a
 * project window they execute in the engine window, exactly like R code.
 * Installs read from the bundled repo; on a network/unreachable error they
 * fall back once to the CDN (unless disabled) — a package missing from the
 * bundled repo is a build error and never falls back, so versions cannot
 * drift silently.
 */
export async function ensurePackages(names: string[], opts?: { timeoutMs?: number }): Promise<void> {
  const wanted = [...new Set(names)];
  for (const name of wanted) {
    if (!/^[A-Za-z0-9.]+$/.test(name) || !registryByName.has(name)) {
      const error = new PackageError(
        "not-in-registry",
        name,
        `The R package “${name}” is not in this build's package registry — no such analysis exists.`,
      );
      states.set(name, { status: "failed", error: error.message, kind: "not-in-registry" });
      throw error;
    }
  }
  if (!wanted.length) return;
  // Join in-flight installs, then install what's still missing — all decided
  // synchronously, before the first await, so concurrent callers cannot
  // start a second install of the same package.
  const joined = wanted.filter((n) => inflight.has(n)).map((n) => inflight.get(n)!.batch);
  const missing = wanted.filter((n) => stateOf(n).status !== "ready" && !inflight.has(n));
  let batch: Promise<void> | null = null;
  if (missing.length) {
    for (const n of missing) states.set(n, { status: "loading" });
    // The gate resolves when this batch settles OR when a timeout evicts it
    // (B2): the next batch is released by eviction, not by the hung batch.
    const cancel = { current: false };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    batch = chain.then(() => {
      // Evicted while queued behind a hung batch: never start the install —
      // a zombie install would only contend with the retry that replaced it.
      if (cancel.current) return;
      return installBatch(missing, cancel);
    });
    batch.then(
      () => releaseGate(),
      () => releaseGate(),
    );
    chain = gate;
    const ticket: InstallTicket = { batch, cancel, releaseGate };
    for (const n of missing) inflight.set(n, ticket);
    const done = batch.then(
      () => {
        for (const n of missing) if (inflight.get(n)?.batch === batch) inflight.delete(n);
      },
      () => {
        for (const n of missing) if (inflight.get(n)?.batch === batch) inflight.delete(n);
      },
    );
    void done;
  }
  const timeoutMs = opts?.timeoutMs ?? PACKAGE_INSTALL_TIMEOUT_MS;
  // The timeout covers EVERYTHING this call waits on — the installs it
  // joined as well as its own batch. (Before B2, a caller that only joined
  // a hung install awaited it before the race and hung forever with no
  // timeout at all.)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      Promise.all([...joined.map((p) => p.catch(() => {})), ...(batch ? [batch] : [])]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new PackageError(
              "timeout",
              wanted.join(", "),
              `Installing ${wanted.map((n) => `“${n}”`).join(", ")} timed out after ${Math.round(timeoutMs / 1000)} seconds — the attempt was abandoned. Try again to start a fresh install.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (timedOut) evictTimedOut(wanted, err as PackageError);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const failed = wanted.filter((n) => stateOf(n).status === "failed");
  if (failed.length) {
    const first = failed[0];
    const state = stateOf(first);
    throw new PackageError(
      state.kind ?? "install-failed",
      first,
      state.error ?? `The R package “${first}” could not be installed.`,
    );
  }
}

/** B2 — evict every package this call was waiting on after a timeout, so a
 *  hung batch can never poison a later install:
 *  - the batch is cancelled: a queued start is skipped, and a late
 *    completion writes no states (the retry's install is the one that
 *    counts — even if the evicted attempt eventually succeeds, its
 *    packages stay `failed` until the retry installs them);
 *  - the chain gate is released, so the next batch starts instead of
 *    queueing behind the dead one;
 *  - the packages leave `inflight` and are marked `failed`/`timeout`
 *    (only while still `loading` — a package that already resolved `ready`
 *    is never clobbered).
 *  Idempotent: a second caller evicting the same packages finds no ticket
 *  and does nothing, so the owning caller's own timeout is a harmless no-op. */
function evictTimedOut(names: string[], error: PackageError): void {
  for (const name of names) {
    const ticket = inflight.get(name);
    if (!ticket) continue;
    ticket.cancel.current = true;
    ticket.releaseGate();
    inflight.delete(name);
    if (stateOf(name).status === "loading") {
      states.set(name, { status: "failed", error: error.message, kind: "timeout" });
    }
  }
}

/** One install batch: `webr::install` from a repo, then prove each package
 *  loads (`requireNamespace`). Never throws — failures land in `states`.
 *  A batch evicted by a timeout (`cancel.current`) writes no states at all:
 *  the retry owns the packages now. */
async function installBatch(names: string[], cancel: { current: boolean }): Promise<void> {
  installsStarted++;
  const attempts: { repos: string | null; source: "bundled" | "cdn" }[] =
    repoUrl === CDN_REPO_URL
      ? [{ repos: null, source: "cdn" }]
      : [
          { repos: repoUrl, source: "bundled" },
          ...(allowCdnFallback ? [{ repos: null as string | null, source: "cdn" as const }] : []),
        ];
  let lastError: PackageError | null = null;
  for (const { repos, source } of attempts) {
    const code =
      `webr::install(c(${names.map((n) => JSON.stringify(n)).join(",")})` +
      `${repos === null ? "" : `, repos=${JSON.stringify(repos)}`}, quiet=TRUE);` +
      `c(${names.map((n) => `${JSON.stringify(n)}=as.numeric(requireNamespace(${JSON.stringify(n)}, quietly=TRUE))`).join(",")})`;
    try {
      const loaded = await evalNamedVector(code);
      const unloaded = names.filter((n) => loaded[n] !== 1);
      if (!unloaded.length) {
        // Evicted while this install was running (B2): the retry owns these
        // packages now — write nothing, even on success.
        if (!cancel.current) for (const n of names) states.set(n, { status: "ready", source });
        return;
      }
      // Installed (or partially) but the namespace will not load. Diagnose
      // why: the repo may be unreachable, the package absent from it, or a
      // dependency broken. A network diagnosis retries with the CDN below.
      lastError = await diagnoseLoadFailure(unloaded, repos);
      if (lastError.kind === "network" && repos !== null && allowCdnFallback) continue;
      break; // a load failure will not fix itself from another repo
    } catch (err) {
      lastError = classifyInstallError(err, names);
      if (lastError.kind === "network" && repos !== null && allowCdnFallback) continue;
      break;
    }
  }
  const message = lastError?.message ?? `The R packages ${names.map((n) => `“${n}”`).join(", ")} could not be installed.`;
  // As above: an evicted batch never overwrites the retry's states.
  if (!cancel.current) {
    for (const n of names) states.set(n, { status: "failed", error: message, kind: lastError?.kind ?? "install-failed" });
  }
}

/** An R/eval error while installing: network (retryable, CDN fallback) or a
 *  hard install failure. */
function classifyInstallError(err: unknown, names: string[]): PackageError {
  const detail = err instanceof Error ? err.message : String(err);
  if (/download|unable to access index|Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|NetworkError|network|timed? ?out|TLS|certificate/i.test(detail)) {
    return new PackageError(
      "network",
      names.join(", "),
      `${names.map((n) => `“${n}”`).join(", ")} need${names.length > 1 ? "" : "s"} to be downloaded once — no network connection was found. Check your connection and retry.`,
    );
  }
  return new PackageError(
    "install-failed",
    names.join(", "),
    `Installing ${names.map((n) => `“${n}”`).join(", ")} failed: ${detail}`,
  );
}

/** `requireNamespace` is false after install: is the repo unreachable (the
 *  index cannot even be read — a network error, retryable with the CDN), the
 *  package absent from the repo index (a build error — never fall back), or
 *  present but unloadable (a broken transitive dependency)? */
async function diagnoseLoadFailure(names: string[], repos: string | null): Promise<PackageError> {
  const indexUrl = `${repos ?? CDN_REPO_URL}/bin/emscripten/contrib/${R_MAJOR_MINOR}/PACKAGES`;
  let indexText: string | null = null;
  try {
    const res = await fetch(indexUrl, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) indexText = await res.text();
  } catch {
    // The index could not be read at all: the repo is unreachable.
  }
  if (indexText === null) {
    return new PackageError(
      "network",
      names.join(", "),
      `${names.map((n) => `“${n}”`).join(", ")} need${names.length > 1 ? "" : "s"} to be downloaded once — no network connection was found. Check your connection and retry.`,
    );
  }
  const absent = names.filter((n) => !new RegExp(`^Package: ${n}$`, "m").test(indexText));
  if (absent.length) {
    return new PackageError(
      "not-in-repo",
      absent.join(", "),
      `${absent.map((n) => `“${n}”`).join(", ")} ${absent.length > 1 ? "are" : "is"} not in this build's package library — the app was built without ${absent.length > 1 ? "them" : "it"}. The analyses that need ${absent.length > 1 ? "them" : "it"} cannot run in this build.`,
    );
  }
  return new PackageError(
    "load-failed",
    names.join(", "),
    `The R package${names.length > 1 ? "s" : ""} ${names.map((n) => `“${n}”`).join(", ")} installed but could not be loaded — a dependency it needs is missing from this build.`,
  );
}

/** The user-facing message for a provisioning failure: never a raw R error. */
export function packageErrorMessage(err: unknown): string {
  if (err instanceof PackageError) return err.message;
  return `Could not install the R packages this test needs: ${err instanceof Error ? err.message : String(err)}`;
}
