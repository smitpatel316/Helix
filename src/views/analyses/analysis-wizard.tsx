// Asks an analysis's questions (wizards.ts) like a macOS assistant: one question at
// a time, Cancel, Back, then Next — or Run on the last one. A "Not sure" answer
// runs Shapiro-Wilk and answers for the user. Mounts fresh for each analysis.
import * as React from "react";
import { Button, Checkbox, Field, Input, NumberInput, RadioList } from "../../ui/controls";
import { Dialog } from "../../ui/dialog";
import { readTable } from "../../lib/dataset";
import type { AnalysisParams, AnalysisType } from "../../stats/types";
import type { TableData } from "../../store/types";
import { useProjectStore } from "../../store/use-project-store";
import { checkNormality } from "./normality-check";
import { useAnalysisLauncher } from "./use-analysis-launcher";
import { analysisLabel } from ".";
import { packageGate } from "../../stats";
import { ensurePackages } from "../../stats/webr";
import { chosenSets, parseUnknowns, toggled, WIZARDS, type Answer, type Answers, type Question, type Wizard } from "./wizards";

const NOT_SURE = { value: "check", label: "Not sure — check for normality first (Shapiro-Wilk)" };

export function AnalysisWizard() {
  const { nodes, selector, closeSelector } = useProjectStore();
  const launch = useAnalysisLauncher();
  if (selector?.kind !== "analysis-params") return null;
  const data = nodes[selector.tableId]?.data;
  const wizard = WIZARDS[selector.testType];
  if (!data || !wizard) return null;
  return (
    <Steps
      title={analysisLabel(selector.testType)}
      wizard={wizard}
      data={data}
      onClose={closeSelector}
      onDone={(type, params) => {
        launch(selector.tableId, type, params);
        closeSelector();
      }}
    />
  );
}

/** The answer a question starts with: the one given before (going back), else its first option. */
function initialAnswer(q: Question, given: Answer | undefined): Answer | null {
  if (q.kind === "choice") return q.options.some((o) => o.value === given) ? given! : q.options[0].value;
  if (q.kind === "number") return typeof given === "number" ? given : q.initial;
  if (q.kind === "text") return typeof given === "string" ? given : q.initial;
  return Array.isArray(given) ? given.filter((n) => q.options.includes(n)) : q.options;
}

function Steps({
  title,
  wizard,
  data,
  onDone,
  onClose,
}: {
  title: string;
  wizard: Wizard;
  data: TableData;
  onDone: (type: AnalysisType, params?: AnalysisParams) => void;
  onClose: () => void;
}) {
  const table = readTable(data);
  const [answers, setAnswers] = React.useState<Answers>({});
  const [step, setStep] = React.useState(0);
  const [checking, setChecking] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  // Each question takes the keyboard (its chosen answer), so ↑↓ and Return go on working.
  const field = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const input = (selector: string) => field.current?.querySelector<HTMLInputElement>(selector);
    (input("input:checked") ?? input("input"))?.focus();
  }, [step]);
  const asked = (a: Answers) => wizard.questions(a, table).filter((q): q is Question => q !== false);
  const q = asked(answers)[step];
  const [value, setValue] = React.useState<Answer | null>(() => initialAnswer(q, undefined));

  const go = (to: number, a: Answers) => {
    const next = asked(a)[to];
    setAnswers(a);
    setStep(to);
    setValue(initialAnswer(next, a[next.id]));
  };
  const last = value !== NOT_SURE.value && asked({ ...answers, [q.id]: value ?? undefined }).length === step + 1;
  // The test this wizard would create once the step is answered (finish is a
  // pure mapping), so a required package that already failed to install
  // blocks Run before it is pressed — with Retry. A package that merely
  // is not loaded yet does not block: the analysis installs it on first run.
  const finished = last ? wizard.finish({ ...answers, [q.id]: value ?? undefined }, table) : null;
  const gate = finished ? packageGate(finished.type) : { blocked: false, message: null, packages: [] as string[] };
  const retry = async () => {
    setRetrying(true);
    try {
      await ensurePackages(gate.packages);
    } catch {
      // The gate recomputes from packageStatus on the next render.
    }
    setRetrying(false);
  };

  const next = async () => {
    let answer = value!;
    if (answer === NOT_SURE.value) {
      setChecking(true);
      const gaussian = await checkNormality(data, chosenSets(answers));
      setChecking(false);
      if (gaussian == null) return;
      answer = gaussian ? "yes" : "no";
    }
    const a = { ...answers, [q.id]: answer };
    if (asked(a).length > step + 1) go(step + 1, a);
    else {
      const { type, params } = wizard.finish(a, table);
      if (packageGate(type).blocked) return; // re-checked: Run was disabled, but status can change
      onDone(type, params);
    }
  };

  // A free-text answer only counts once it parses: a question with its own
  // `parse` (the spline's spar: blank = automatic) uses that, otherwise the
  // text must be comma-separated numbers (the standard-curve unknowns); its
  // error, when the user has typed something, replaces the question text.
  const parseText = (value: string): string | null =>
    q.kind === "text" ? ((q.parse?.(value) ?? parseUnknowns(value)).error ?? null) : null;
  const textError = q.kind === "text" && String(value ?? "").trim() !== "" ? parseText(String(value ?? "")) : null;
  // A number answer only counts once it passes its question's validation;
  // its error, like the free-text one, replaces the question text.
  const numberError = q.kind === "number" && typeof value === "number" ? (q.validate?.(value) ?? null) : null;
  const ready =
    value !== null &&
    !(Array.isArray(value) && value.length < (q.kind === "names" ? (q.min ?? 1) : 1)) &&
    !(q.kind === "text" && parseText(String(value ?? ""))) &&
    !numberError;

  return (
    <Dialog
      open
      onClose={checking ? undefined : onClose}
      onReturn={ready && !checking ? () => void next() : undefined}
      title={title}
      description={
        gate.blocked
          ? gate.message!
          : checking
            ? "Running the Shapiro-Wilk normality test…"
            : (textError ?? numberError ?? q.ask)
      }
      footer={
        !checking && (
          <>
            {step > 0 && <Button onClick={() => go(step - 1, answers)}>Back</Button>}
            {gate.blocked && (
              <Button disabled={retrying} onClick={() => void retry()}>
                {retrying ? "Retrying…" : "Retry installing packages"}
              </Button>
            )}
            <Button variant="accent" disabled={!ready || gate.blocked} onClick={() => void next()}>
              {last ? "Run" : "Next"}
            </Button>
          </>
        )
      }
    >
      {!checking && (
        <div ref={field}>
          <AnswerField question={q} value={value} onChange={setValue} />
        </div>
      )}
    </Dialog>
  );
}

function AnswerField({
  question: q,
  value,
  onChange,
}: {
  question: Question;
  value: Answer | null;
  onChange: (value: Answer | null) => void;
}) {
  if (q.kind === "choice") {
    return (
      <RadioList
        value={value as string}
        onChange={onChange}
        options={q.normality ? [...q.options, NOT_SURE] : q.options}
      />
    );
  }
  if (q.kind === "number") {
    return (
      <Field label={q.label}>
        <NumberInput value={value as number | null} onChange={onChange} min={q.min} max={q.max} step={q.step} />
      </Field>
    );
  }
  if (q.kind === "text") {
    return (
      <Field label={q.label}>
        <Input
          value={(value as string | null) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={q.placeholder}
        />
      </Field>
    );
  }
  const ticked = value as string[];
  return (
    <div className="flex flex-col gap-2">
      {q.options.map((name) => (
        <label key={name} className="flex items-center gap-2 text-regular">
          <Checkbox checked={ticked.includes(name)} onChange={(on) => onChange(toggled(q.options, ticked, name, on))} />
          {name}
        </label>
      ))}
    </div>
  );
}
