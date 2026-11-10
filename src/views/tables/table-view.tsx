// A data table: the grid, and (grouped tables) the Groups panel. Every edit goes to
// the project store, which keeps the Undo history for the whole project.
import { GROUPED_LIMITS, type ProjectNode, type RowGroup, type TableData } from "../../store/types";
import type { TableMove } from "../../store/references";
import { useProjectActions } from "../../store/use-project-store";
import { Section, Stepper, WithInspector } from "../../components/common/inspector";
import { Button, Input } from "../../ui/controls";
import { useLayout } from "../../store/use-layout";
import { ColumnsIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { Toolbar } from "../../ui/layout";
import { Grid } from "./grid";
import {
  addRowGroup,
  defaultRowGroups,
  regroupLoses,
  regroupTable,
  removeRowGroup,
  renestLoses,
  renestTable,
  rowGroupTotal,
  setRowGroupCount,
  setRowGroupName,
} from "./table-data";
import { isGrouped, isNested } from "../../lib/dataset";
import { seriesKeyOf } from "../../lib/columns";
import { confirmDelete } from "../../native";
import { TABLES } from ".";

// ── View ───────────────────────────────────────────────────────────────

export function TableView({ node }: { node: ProjectNode }) {
  const data = node.data!;
  const { updateTable } = useProjectActions();
  const update = (next: TableData, label: string, move?: TableMove) => {
    if (next !== data) updateTable(node.id, next, label, move);
  };
  const { setLayout } = useLayout();
  const tag = TABLES[node.tableType ?? "column"].label;
  const grid = (
    <Grid
      data={data}
      type={node.tableType ?? "column"}
      update={update}
      showGroups={() => setLayout({ inspector: true })}
    />
  );

  // Only a grouped or nested table has settings of its own: its groups.
  if (!isGrouped(data) && !isNested(data)) {
    return (
      <>
        <Toolbar title={node.name} tag={tag} />
        {grid}
      </>
    );
  }
  return (
    <WithInspector title={node.name} tag={tag} inspector={<GroupsPanel data={data} update={update} />}>
      {grid}
    </WithInspector>
  );
}

/** A grouped table's structure: groups and sub-columns per group, each change at once.
 *  Taking away a group or sub-column that holds values asks first (Undo brings it back).
 *  A nested table's panel adds the subgroups level (add/remove subgroup within a
 *  group, add/remove group) and drops the row-groups editor — a nested table's
 *  rows carry no third factor. */
function GroupsPanel({ data, update }: { data: TableData; update: (next: TableData, label: string) => void }) {
  const groups = data.groups!;
  const replicates = data.replicates!;
  if (isNested(data)) {
    const subgroups = data.subgroups!;
    const renest = async (g: number, s: number, r: number) => {
      if (renestLoses(data, g, s, r)) {
        const [what, its] =
          g < groups
            ? [`group “${seriesKeyOf(data.columns.at(-1)!)}”`, "Its"]
            : s < subgroups
              ? [`subgroup ${subgroups} of each group`, "Their"]
              : [`replicate ${replicates} of each subgroup`, "Their"];
        if (!(await confirmDelete(`Delete ${what}?`, `${its} values will be deleted too. You can undo this.`))) return;
      }
      update(renestTable(data, g, s, r), "Change Groups");
    };
    return (
      <Section title="Groups" icon={<ColumnsIcon />}>
        <Stepper
          label="Groups"
          value={groups}
          {...GROUPED_LIMITS.nested.groups}
          step={1}
          onChange={(g) => void renest(g, subgroups, replicates)}
        />
        <Stepper
          label="Subgroups"
          value={subgroups}
          {...GROUPED_LIMITS.nested.subgroups}
          step={1}
          onChange={(s) => void renest(groups, s, replicates)}
        />
        <Stepper
          label="Replicates"
          value={replicates}
          {...GROUPED_LIMITS.nested.replicates}
          step={1}
          onChange={(r) => void renest(groups, subgroups, r)}
        />
      </Section>
    );
  }
  const regroup = async (g: number, r: number) => {
    if (regroupLoses(data, g, r)) {
      const [what, its] =
        g < groups
          ? [`group “${seriesKeyOf(data.columns.at(-1)!)}”`, "Its"]
          : [`sub-column ${replicates} of each group`, "Their"];
      if (!(await confirmDelete(`Delete ${what}?`, `${its} values will be deleted too. You can undo this.`))) return;
    }
    update(regroupTable(data, g, r), "Change Groups");
  };
  return (
    <Section title="Groups" icon={<ColumnsIcon />}>
      <Stepper
        label="Groups"
        value={groups}
        {...GROUPED_LIMITS.groups}
        step={1}
        onChange={(g) => void regroup(g, replicates)}
      />
      <Stepper
        label="Sub-columns"
        value={replicates}
        {...GROUPED_LIMITS.replicates}
        step={1}
        onChange={(r) => void regroup(groups, r)}
      />
      <RowGroupsEditor data={data} update={update} />
    </Section>
  );
}

/** A grouped table's third factor: consecutive bands of rows, one level each
 *  (e.g. WT rows, then KO rows) — what a three-way ANOVA reads as factor C.
 *  Before the user edits them there is one band covering every row, which
 *  disables the three-way option; splitting into ≥ 2 bands enables it. */
function RowGroupsEditor({ data, update }: { data: TableData; update: (next: TableData, label: string) => void }) {
  const rows = data.rows.length;
  const stored = data.rowGroups;
  const bands: RowGroup[] = stored ?? (rows > 0 ? defaultRowGroups(data) : []);
  const setBands = (next: RowGroup[], label: string) =>
    update({ ...data, rowGroups: next.length > 1 ? next : undefined }, label);
  if (rows === 0) {
    return <p className="text-small text-secondary">Add rows to split them into row groups (a third factor).</p>;
  }
  const canSplit = bands.some((b) => b.count > 1);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-small text-secondary">Row groups (third factor)</span>
      {bands.map((band, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            aria-label={`Row group ${i + 1} name`}
            value={band.name}
            onChange={(e) => setBands(setRowGroupName(bands, i, e.target.value), "Rename Row Group")}
          />
          <Stepper
            label={`Rows in ${band.name}`}
            value={band.count}
            min={1}
            max={Math.max(1, rowGroupTotal(bands) - (bands.length - 1))}
            step={1}
            onChange={(c) => setBands(setRowGroupCount(bands, i, c), "Change Row Groups")}
          />
          {bands.length > 1 && (
            <Button
              size="icon"
              aria-label={`Remove row group ${band.name}`}
              onClick={() => setBands(removeRowGroup(bands, i), "Remove Row Group")}
            >
              <MinusIcon className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      <Button size="small" disabled={!canSplit} onClick={() => setBands(addRowGroup(bands), "Add Row Group")}>
        <PlusIcon className="size-3.5" /> Add row group
      </Button>
      {bands.length < 2 && (
        <p className="text-small text-secondary">
          One band covers every row. Split it into 2 or more bands to run a three-way ANOVA.
        </p>
      )}
    </div>
  );
}
