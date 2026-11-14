// The app's one R is single-threaded, and webR already serializes concurrent
// evaluations inside its worker — but that queue is invisible: a graph view
// mounts ~10 analyses at once and each one just shows "Running…" with no
// queue position, and the app has no choke point of its own. This module is
// the app's explicit FIFO: evaluations run strictly in arrival order, one at
// a time, and every change publishes a snapshot (running / queued) the UI
// can show. (M17.)
//
// Runtime check, 2026-11-12: three concurrent evalNamedVector calls
// (Sys.sleep 2 s, 1 s, instant) completed in submission order in 3815 ms —
// webR does serialize internally. The queue below is still needed: webR's
// queue is invisible and unordered from the app's side, and a hung call
// still blocks everything behind it with no position to show. The FIFO
// changes no execution semantics (still one at a time, still in order) —
// it makes the queue observable and gives future priority/cancel work a
// single place to hook in.
//
// A queued request whose caller gave up is dropped by `cancel` (FL-F14):
// the shell tells the engine which request ids it dropped, and the engine
// dequeues them here instead of running them — the shell discards a late
// result anyway, so a dropped request never wedges the queue. Only a
// request that is already running needs the interrupt path; `cancel` says
// whether one of the ids is the running one, and the caller interrupts
// only then. A request whose caller gave up some other way (its window
// closed with no cancel) still runs once when it reaches the front — the
// shell discards its late result — so a cancelled caller never wedges the
// queue.
import { EvalCancelledError } from "./webr";

/** What the queue looks like right now: one evaluation running, the rest waiting. */
export interface RQueueSnapshot {
  running: boolean;
  queued: number;
}

/** A serial FIFO for R evaluations: tasks run in enqueue order, one at a
 *  time; a task that throws never stalls the queue — the next task still
 *  runs, and the error reaches that task's caller. `onChange` fires on
 *  every enqueue, start, finish, and cancel. `enqueue` takes the task's id
 *  (the shell's request id, when the engine window enqueues it) so `cancel`
 *  can drop that one request: a queued request cancelled this way never
 *  runs — its promise rejects with `EvalCancelledError` when its turn
 *  comes — and the running request is never touched by it. */
export function createEvalQueue(onChange?: (snapshot: RQueueSnapshot) => void) {
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  /** The running entry's id, while one runs — what `cancel` checks before
   *  deciding the interrupt is the canceller's to make. */
  let runningId: unknown;
  /** Entries still waiting for their turn, in order — what `cancel` drops. */
  const waiting: { id: unknown; cancelled: boolean }[] = [];
  const snapshot = (): RQueueSnapshot => ({ running, queued: waiting.length });
  const emit = () => onChange?.(snapshot());
  return {
    enqueue<T>(task: () => Promise<T>, id?: unknown): Promise<T> {
      const entry = { id, cancelled: false };
      waiting.push(entry);
      emit();
      const run = tail.then(async () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        if (entry.cancelled) {
          throw new EvalCancelledError();
        }
        running = true;
        runningId = entry.id;
        emit();
        try {
          return await task();
        } finally {
          running = false;
          runningId = undefined;
          emit();
        }
      });
      // The chain itself never rejects, so one task's failure cannot wedge
      // the queue; the caller still sees its own task's error.
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    /** Drop the queued entries with these ids, and say whether one of them
     *  is the entry now running. A dropped entry never runs; the running
     *  entry is reported, not stopped — stopping it is the caller's
     *  interrupt. An id with no entry here cancels nothing. */
    cancel(ids: Iterable<unknown>): { cancelledQueued: number; runningCancelled: boolean } {
      const wanted = new Set(ids);
      let cancelledQueued = 0;
      for (let i = waiting.length - 1; i >= 0; i--) {
        const entry = waiting[i];
        if (entry.id !== undefined && wanted.has(entry.id)) {
          entry.cancelled = true;
          waiting.splice(i, 1);
          cancelledQueued++;
        }
      }
      if (cancelledQueued) emit();
      return {
        cancelledQueued,
        runningCancelled: runningId !== undefined && wanted.has(runningId),
      };
    },
    snapshot,
  };
}

/** The latest queue snapshot any window has heard, for the UI. The engine
 *  window publishes snapshots on the "r-queue" event; project windows keep
 *  the latest here so a view can show "R queue: 2 waiting" while it waits.
 *  Null until the engine has published one — tests and `npm run web` never
 *  do, so the queue line stays hidden there. */
let latest: RQueueSnapshot | null = null;
const listeners = new Set<(snapshot: RQueueSnapshot) => void>();
export function getRQueueSnapshot(): RQueueSnapshot | null {
  return latest;
}
export function setRQueueSnapshot(snapshot: RQueueSnapshot): void {
  latest = snapshot;
  for (const listener of listeners) listener(snapshot);
}
export function onRQueueSnapshot(handler: (snapshot: RQueueSnapshot) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** The queue line a waiting view appends to "Running…": "" when the queue
 *  is empty or unknown, " · R queue: N waiting" while work waits behind the
 *  running evaluation. */
export function rQueueStatusText(snapshot: RQueueSnapshot | null): string {
  if (!snapshot || snapshot.queued <= 0) return "";
  return ` · R queue: ${snapshot.queued} waiting`;
}
