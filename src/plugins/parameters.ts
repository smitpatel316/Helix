// Plugin parameters — v3 Phase 4 groundwork (roadmap §4b Definition row).
//
// A plugin analysis declares its parameters reusing the app's existing
// parameter kinds: a choice among options (the wizards' `choice` — the same
// shape as the app's TAILS / CORRELATION_METHODS / POSTHOCS option lists),
// a number with a range and default (ROUT_Q-style min/max), a yes/no
// boolean, free text, picking several names, or picking a data column.
// The shapes here are JSON-serialisable on purpose: a plugin.json can carry
// them, and the wizard adapter (analysis-spec.ts) turns them into the
// wizard's own Question shapes. The runner re-checks every value before a
// run — the same doctrine as the first-party wizards ("the runner re-checks,
// so a bad value passed straight to runAnalysis still fails clearly").

/** One declared parameter. `key` is the param name the computation reads
 *  (and the wizard question id that answers it — see analysis-spec.ts). */
export type PluginParameter =
  | {
      kind: "choice";
      key: string;
      label: string;
      options: (string | { value: string; label: string })[];
      default: string;
    }
  | {
      kind: "number";
      key: string;
      label: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { kind: "boolean"; key: string; label: string; default: boolean }
  | { kind: "text"; key: string; label: string; default?: string; placeholder?: string }
  | { kind: "names"; key: string; label: string; options: string[]; min?: number; default?: string[] }
  /** Pick one data column — the options are the table's columns, resolved at
   *  wizard time (every first-party `y` param asks this way). */
  | { kind: "column"; key: string; label: string; default?: string };

/** One parameter's value, once answered (or defaulted). */
export type PluginParamValue = string | number | boolean | string[];

/** A full set of parameter values, keyed by parameter key. */
export type PluginParamValues = Record<string, PluginParamValue | undefined>;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function optionValues(options: unknown): string[] | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const values: string[] = [];
  for (const o of options) {
    if (typeof o === "string" && o.length > 0) values.push(o);
    else if (typeof o === "object" && o !== null && typeof (o as { value?: unknown }).value === "string")
      values.push((o as { value: string }).value);
    else return null;
  }
  return values;
}

/** Validate a parameter list (from a plugin.json). Duplicate keys, a choice
 *  whose default is not among its options, a number default outside its
 *  range — all install-time rejections, not runtime surprises. */
export function validatePluginParameters(value: unknown): { parameters: PluginParameter[] } | { errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { errors: ["Plugin parameters must be a list (possibly empty)."] };
  const seen = new Set<string>();
  const parameters: PluginParameter[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push("Each plugin parameter must be an object with a kind, key, label and default.");
      continue;
    }
    const p = raw as Record<string, unknown>;
    if (!isNonEmptyString(p.key)) {
      errors.push("Each plugin parameter needs a non-empty key.");
      continue;
    }
    const key = p.key as string;
    if (seen.has(key)) {
      errors.push(`Parameter key “${key}” is declared twice.`);
      continue;
    }
    seen.add(key);
    if (!isNonEmptyString(p.label)) {
      errors.push(`Parameter “${key}” needs a non-empty label.`);
      continue;
    }
    switch (p.kind) {
      case "choice": {
        const options = optionValues(p.options);
        if (options === null) {
          errors.push(`Choice parameter “${key}” needs at least one option.`);
        } else if (typeof p.default !== "string" || !options.includes(p.default)) {
          errors.push(
            `Choice parameter “${key}” has a default that is not one of its options (${options.join(", ")}).`,
          );
        } else {
          parameters.push({
            kind: "choice",
            key,
            label: p.label as string,
            options: p.options as (string | { value: string; label: string })[],
            default: p.default,
          });
        }
        break;
      }
      case "number": {
        const { min, max } = p;
        if (typeof p.default !== "number" || !Number.isFinite(p.default)) {
          errors.push(`Number parameter “${key}” needs a finite default.`);
        } else if ((typeof min === "number" && p.default < min) || (typeof max === "number" && p.default > max)) {
          errors.push(
            `Number parameter “${key}” has a default (${p.default}) outside its range` +
              `${typeof min === "number" ? ` (min ${min})` : ""}${typeof max === "number" ? ` (max ${max})` : ""}.`,
          );
        } else if (
          (typeof min !== "number" && min !== undefined) ||
          (typeof max !== "number" && max !== undefined) ||
          (typeof p.step !== "number" && p.step !== undefined)
        ) {
          errors.push(`Number parameter “${key}” has a min, max or step that is not a number.`);
        } else if (typeof min === "number" && typeof max === "number" && min > max) {
          errors.push(`Number parameter “${key}” has a min (${min}) above its max (${max}).`);
        } else {
          parameters.push({
            kind: "number",
            key,
            label: p.label as string,
            default: p.default,
            ...(typeof min === "number" ? { min } : {}),
            ...(typeof max === "number" ? { max } : {}),
            ...(typeof p.step === "number" ? { step: p.step } : {}),
          });
        }
        break;
      }
      case "boolean": {
        if (typeof p.default !== "boolean") {
          errors.push(`Boolean parameter “${key}” needs a true/false default.`);
        } else {
          parameters.push({ kind: "boolean", key, label: p.label as string, default: p.default });
        }
        break;
      }
      case "text": {
        if (p.default !== undefined && typeof p.default !== "string") {
          errors.push(`Text parameter “${key}” has a default that is not a string.`);
        } else if (p.placeholder !== undefined && typeof p.placeholder !== "string") {
          errors.push(`Text parameter “${key}” has a placeholder that is not a string.`);
        } else {
          parameters.push({
            kind: "text",
            key,
            label: p.label as string,
            ...(typeof p.default === "string" ? { default: p.default } : {}),
            ...(typeof p.placeholder === "string" ? { placeholder: p.placeholder } : {}),
          });
        }
        break;
      }
      case "names": {
        const options = optionValues(p.options);
        if (options === null) {
          errors.push(`Names parameter “${key}” needs at least one option.`);
        } else if (
          p.default !== undefined &&
          (!Array.isArray(p.default) || p.default.some((d) => typeof d !== "string" || !options.includes(d)))
        ) {
          errors.push(`Names parameter “${key}” has a default that is not among its options.`);
        } else if (p.min !== undefined && (typeof p.min !== "number" || p.min < 1)) {
          errors.push(`Names parameter “${key}” has a min below 1.`);
        } else {
          parameters.push({
            kind: "names",
            key,
            label: p.label as string,
            options,
            ...(typeof p.min === "number" ? { min: p.min } : {}),
            ...(Array.isArray(p.default) ? { default: [...p.default] } : {}),
          });
        }
        break;
      }
      case "column": {
        if (p.default !== undefined && typeof p.default !== "string") {
          errors.push(`Column parameter “${key}” has a default that is not a string.`);
        } else {
          parameters.push({
            kind: "column",
            key,
            label: p.label as string,
            ...(typeof p.default === "string" ? { default: p.default } : {}),
          });
        }
        break;
      }
      default:
        errors.push(
          `Parameter “${key}” has an unknown kind “${String(p.kind)}” — use choice, number, boolean, text, names or column.`,
        );
    }
  }
  return errors.length ? { errors } : { parameters };
}

/** Every parameter's default, as the values a run starts from. */
export function pluginParamDefaults(parameters: readonly PluginParameter[]): PluginParamValues {
  const values: PluginParamValues = {};
  for (const p of parameters) {
    switch (p.kind) {
      case "choice":
      case "number":
      case "boolean":
        values[p.key] = p.default;
        break;
      case "text":
      case "column":
        if (p.default !== undefined) values[p.key] = p.default;
        break;
      case "names":
        if (p.default !== undefined) values[p.key] = [...p.default];
        break;
    }
  }
  return values;
}

/** Check supplied values against the declarations (range, options, type).
 *  Missing keys are fine — they take their defaults. Returns the problems,
 *  if any; the runner refuses to run on a non-empty list. */
export function validatePluginParamValues(parameters: readonly PluginParameter[], values: PluginParamValues): string[] {
  const errors: string[] = [];
  for (const p of parameters) {
    const v = values[p.key];
    if (v === undefined) continue;
    switch (p.kind) {
      case "choice": {
        const options = p.options.map((o) => (typeof o === "string" ? o : o.value));
        if (typeof v !== "string" || !options.includes(v))
          errors.push(`“${p.label}” must be one of ${options.join(", ")}.`);
        break;
      }
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`“${p.label}” must be a number.`);
        else if (p.min !== undefined && v < p.min) errors.push(`“${p.label}” must be at least ${p.min}.`);
        else if (p.max !== undefined && v > p.max) errors.push(`“${p.label}” must be at most ${p.max}.`);
        break;
      }
      case "boolean": {
        if (typeof v !== "boolean") errors.push(`“${p.label}” must be yes or no.`);
        break;
      }
      case "text":
      case "column": {
        if (typeof v !== "string") errors.push(`“${p.label}” must be text.`);
        break;
      }
      case "names": {
        if (!Array.isArray(v) || v.some((d) => typeof d !== "string" || !p.options.includes(d)))
          errors.push(`“${p.label}” must be chosen from ${p.options.join(", ")}.`);
        else if (p.min !== undefined && v.length < p.min)
          errors.push(`“${p.label}” needs at least ${p.min} choice${p.min === 1 ? "" : "s"}.`);
        break;
      }
    }
  }
  return errors;
}

/** Merge supplied values over the defaults, refusing invalid ones. */
export function resolvePluginParamValues(
  parameters: readonly PluginParameter[],
  supplied?: PluginParamValues,
): { values: PluginParamValues } | { errors: string[] } {
  const errors = validatePluginParamValues(parameters, supplied ?? {});
  if (errors.length) return { errors };
  return { values: { ...pluginParamDefaults(parameters), ...(supplied ?? {}) } };
}
