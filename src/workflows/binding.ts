// Binding — resolving a step's role-based data bindings against a real
// table. Exact match only: a binding names a column, data set or group by
// its exact name, or by its structural position (the X column, the nth Y
// series). A name that is not there is a clear failure, not a guess —
// header synonyms, unit conversion and learned mappings are the future
// adaptive-replay idea (roadmap §4a) and are explicitly out of this engine.

import { groupsOf, readTable, splitXY, type Dataset } from "../lib/dataset";
import { hasXColumn, type TableData, type TableType } from "../store/types";
import type { AnalysisParams } from "../stats/types";
import type { ColumnBinding, ParamBindings } from "./types";

export type BindingResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): BindingResult<never> => ({ ok: false, error });

/** The single name one binding resolves to on this table. */
export function resolveColumnBinding(
  binding: ColumnBinding,
  dataset: Dataset,
  tableType: TableType,
): BindingResult<string> {
  switch (binding.role) {
    case "x": {
      if (!hasXColumn(tableType))
        return fail(`“x” has no meaning on a ${tableType} table — only XY and Survival tables have an X column.`);
      const [first] = dataset.columns;
      if (!first || !first.values.length)
        return fail(`The X column${first ? ` (“${first.name}”)` : ""} holds no numbers.`);
      return { ok: true, value: first.name };
    }
    case "y": {
      const { ys } = splitXY(dataset.columns);
      const found = ys[binding.index];
      if (!found)
        return fail(`There is no Y series ${binding.index + 1} — the table has ${ys.length} Y series holding numbers.`);
      return { ok: true, value: found.name };
    }
    case "set": {
      if (!dataset.sets.some((s) => s.name === binding.name))
        return fail(
          `No data set is named “${binding.name}” — the table's data sets are ${dataset.sets.map((s) => `“${s.name}”`).join(", ") || "none"}.`,
        );
      return { ok: true, value: binding.name };
    }
    case "column": {
      if (!dataset.columns.some((c) => c.name === binding.name))
        return fail(
          `No column is named “${binding.name}” — the table's columns are ${dataset.columns.map((c) => `“${c.name}”`).join(", ") || "none"}.`,
        );
      return { ok: true, value: binding.name };
    }
    case "group": {
      const groups = groupsOf(dataset.columns);
      if (!groups.some((g) => g.name === binding.name))
        return fail(
          `No group is named “${binding.name}” — the table's groups are ${groups.map((g) => `“${g.name}”`).join(", ") || "none"}.`,
        );
      return { ok: true, value: binding.name };
    }
    case "all-numeric":
      return fail(`“all-numeric” only fills a list of names (sets, predictors…), not a single column.`);
  }
}

/** The names a binding (or list of bindings) resolves to where a list of
 *  names is expected — `all-numeric` expands to every numeric column. */
function resolveNameList(bindings: ColumnBinding[], dataset: Dataset, tableType: TableType): BindingResult<string[]> {
  const names: string[] = [];
  for (const binding of bindings) {
    if (binding.role === "all-numeric") {
      names.push(...dataset.numeric.map((c) => c.name));
      continue;
    }
    const resolved = resolveColumnBinding(binding, dataset, tableType);
    if (!resolved.ok) return resolved;
    names.push(resolved.value);
  }
  return { ok: true, value: names };
}

/**
 * The analysis params for a replay table: every bound field is re-resolved
 * against the table, and the rest of the recorded params replay verbatim.
 * A binding that cannot resolve fails the whole step — the caller reports
 * the error, and nothing runs on a half-bound params object.
 */
export function resolveParamBindings(
  params: AnalysisParams,
  bindings: ParamBindings | undefined,
  data: TableData,
  tableType: TableType,
): BindingResult<AnalysisParams> {
  if (!bindings) return { ok: true, value: params };
  const dataset = readTable(data);
  // JSON-safe params (names, numbers, booleans, arrays) copy by value.
  const resolved = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;

  const single = (binding: ColumnBinding | undefined): BindingResult<string | undefined> => {
    if (!binding) return { ok: true, value: undefined };
    const r = resolveColumnBinding(binding, dataset, tableType);
    return r.ok ? { ok: true, value: r.value } : r;
  };
  const list = (listBindings: ColumnBinding[] | undefined): BindingResult<string[] | undefined> => {
    if (!listBindings) return { ok: true, value: undefined };
    return resolveNameList(listBindings, dataset, tableType);
  };

  const fields: [string, ColumnBinding | ColumnBinding[] | undefined][] = [
    ["y2", bindings.y2],
    ["dependent", bindings.dependent],
    ["reference", bindings.reference],
    ["control", bindings.control],
    ["compareWith", bindings.compareWith],
    ["time", bindings.time],
    ["status", bindings.status],
    ["stratifyBy", bindings.stratifyBy],
    ["sets", bindings.sets],
    ["ys", bindings.ys],
    ["predictors", bindings.predictors],
    ["datasets", bindings.datasets],
    ["covariates", bindings.covariates],
  ];
  for (const [field, binding] of fields) {
    if (binding === undefined) continue;
    if (Array.isArray(binding)) {
      const r = list(binding);
      if (!r.ok) return fail(`Could not bind “${field}”: ${r.error}`);
      resolved[field] = r.value;
    } else {
      const r = single(binding);
      if (!r.ok) return fail(`Could not bind “${field}”: ${r.error}`);
      resolved[field] = r.value;
    }
  }
  // `y` may be one name or a list of names (enzyme inhibition's global fits).
  if (bindings.y !== undefined) {
    if (Array.isArray(bindings.y)) {
      const r = list(bindings.y);
      if (!r.ok) return fail(`Could not bind “y”: ${r.error}`);
      resolved.y = r.value;
    } else {
      const r = single(bindings.y);
      if (!r.ok) return fail(`Could not bind “y”: ${r.error}`);
      resolved.y = r.value;
    }
  }
  return { ok: true, value: resolved as AnalysisParams };
}

/**
 * Whether run-input data fits the table type an import step declares.
 * A mismatch fails the import step before anything is created — a workflow
 * recorded on an XY table does not silently become a Column table.
 */
export function checkTableShape(tableType: TableType, data: TableData): string | undefined {
  const dataColumns = data.columns.length - 1;
  if (data.rows.length === 0) return "The input table has no rows.";
  if (dataColumns < 1) return "The input table has no data columns.";
  if (hasXColumn(tableType) && dataColumns < 2)
    return `An ${tableType} table needs an X column and at least one Y column — the input has ${dataColumns} data column${dataColumns === 1 ? "" : "s"}.`;
  if (tableType === "grouped" && !(data.groups && data.replicates))
    return "A grouped table needs groups × replicates — the input is not grouped.";
  if (tableType === "nested" && !(data.groups && data.subgroups && data.replicates))
    return "A nested table needs groups × subgroups × replicates — the input is not nested.";
  return undefined;
}
