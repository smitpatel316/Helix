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
// A queued request whose caller already gave up (watchdog/cancel) still
// runs once when it reaches the front — the shell discards its late result
// — so a cancelled caller never wedges the queue. Per-request cancel of
// queued work would need the shell to tell the engine which ids were
// dropped; it doesn't today, so cancel stays the watchdog + interrupt path.

/** What the queue looks like right now: one evaluation running, the rest waiting. */
export interface RQueueSnapshot {
  running: boolean;
  queued: number;
}

/** A serial FIFO for R evaluations: tasks run in enqueue order, one at a
 *  time; a task that throws never stalls the queue — the next task still
 *  runs, and the error reaches that task's caller. `onChange` fires on
 *  every enqueue, start, and finish. */
export function createEvalQueue(onChange?: (snapshot: RQueueSnapshot) => void) {
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  let queued = 0;
  const snapshot = (): RQueueSnapshot => ({ running, queued });
  const emit = () => onChange?.(snapshot());
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      queued++;
      emit();
      const run = tail.then(async () => {
        queued--;
        running = true;
        emit();
        try {
          return await task();
        } finally {
          running = false;
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
