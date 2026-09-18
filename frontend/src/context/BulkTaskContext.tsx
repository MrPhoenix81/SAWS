import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

/**
 * Background task tracker for Admin's bulk Upload / Download / Delete
 * operations on the Data page.
 *
 * This context is mounted once above the router (see App.tsx) so it
 * survives page navigation - starting a bulk job and then clicking away
 * to Overview, Students, etc. no longer cancels it or blocks the rest of
 * the app. Progress is surfaced via a small tray in the bottom-right
 * corner (see components/BulkTaskTray.tsx), not by keeping the user
 * pinned to the Data page.
 */

export type BulkTaskType = 'upload' | 'download' | 'delete';
export type BulkTaskStatus = 'running' | 'success' | 'error';

export interface BulkTask {
  id: string;
  type: BulkTaskType;
  label: string;
  status: BulkTaskStatus;
  /** 0-100. If `indeterminate` is true, the tray shows a moving stripe instead of a fixed fill. */
  progress: number;
  indeterminate: boolean;
  message?: string;
  /** Optional structured detail (e.g. skipped-row list) the tray can expand in place. */
  detail?: React.ReactNode;
  startedAt: number;
  finishedAt?: number;
}

interface RunTaskOptions {
  type: BulkTaskType;
  label: string;
  /** Do the work, calling `update` as progress is made. Throw to mark the task failed. */
  run: (update: (patch: Partial<Pick<BulkTask, 'progress' | 'indeterminate' | 'message'>>) => void) => Promise<{
    message?: string;
    detail?: React.ReactNode;
  } | void>;
}

interface BulkTaskContextValue {
  tasks: BulkTask[];
  runTask: (opts: RunTaskOptions) => string;
  dismissTask: (id: string) => void;
  clearFinished: () => void;
}

const BulkTaskContext = createContext<BulkTaskContextValue | undefined>(undefined);

let taskCounter = 0;

export function BulkTaskProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<BulkTask[]>([]);
  // Guards against a task's async work resolving/rejecting after it was
  // already dismissed from the tray (avoids "ghost" state updates).
  const liveIds = useRef<Set<string>>(new Set());
  // Interval handles for the fake-progress ramp on indeterminate tasks.
  const rampRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const patchTask = useCallback((id: string, patch: Partial<BulkTask>) => {
    if (!liveIds.current.has(id)) return;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const runTask = useCallback(
    ({ type, label, run }: RunTaskOptions) => {
      const id = `task-${Date.now()}-${taskCounter++}`;
      liveIds.current.add(id);

      const task: BulkTask = {
        id,
        type,
        label,
        status: 'running',
        progress: 0,
        indeterminate: true,
        startedAt: Date.now()
      };
      setTasks((prev) => [...prev, task]);

      // For steps that can't report real progress (e.g. a single upload
      // API call with no server-side progress events), climb toward 90%
      // on a decaying curve so the tray still shows a moving percentage
      // instead of a plain spinner. Any call to `update` that sets
      // `indeterminate: false` (real, step-counted progress) stops this.
      const ramp = setInterval(() => {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== id || !t.indeterminate || t.status !== 'running') return t;
            const next = t.progress + (90 - t.progress) * 0.15;
            return { ...t, progress: Math.min(90, next) };
          })
        );
      }, 400);
      rampRefs.current.set(id, ramp);

      const stopRamp = () => {
        const iv = rampRefs.current.get(id);
        if (iv) {
          clearInterval(iv);
          rampRefs.current.delete(id);
        }
      };

      (async () => {
        try {
          const result = await run((patch) => {
            if (patch.indeterminate === false) stopRamp();
            patchTask(id, patch);
          });
          stopRamp();
          patchTask(id, {
            status: 'success',
            progress: 100,
            indeterminate: false,
            message: result?.message,
            detail: result?.detail,
            finishedAt: Date.now()
          });
        } catch (err) {
          stopRamp();
          patchTask(id, {
            status: 'error',
            indeterminate: false,
            message: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
            finishedAt: Date.now()
          });
        }
      })();

      return id;
    },
    [patchTask]
  );

  const dismissTask = useCallback((id: string) => {
    liveIds.current.delete(id);
    const iv = rampRefs.current.get(id);
    if (iv) {
      clearInterval(iv);
      rampRefs.current.delete(id);
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((prev) => {
      const stillRunning = prev.filter((t) => t.status === 'running');
      const finishedIds = prev.filter((t) => t.status !== 'running').map((t) => t.id);
      finishedIds.forEach((fid) => {
        liveIds.current.delete(fid);
        const iv = rampRefs.current.get(fid);
        if (iv) {
          clearInterval(iv);
          rampRefs.current.delete(fid);
        }
      });
      return stillRunning;
    });
  }, []);

  return (
    <BulkTaskContext.Provider value={{ tasks, runTask, dismissTask, clearFinished }}>
      {children}
    </BulkTaskContext.Provider>
  );
}

export function useBulkTasks() {
  const ctx = useContext(BulkTaskContext);
  if (!ctx) throw new Error('useBulkTasks must be used within a BulkTaskProvider');
  return ctx;
}