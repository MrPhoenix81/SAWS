import React, { useState } from 'react';
import { UploadCloud, Download, Trash2, CheckCircle2, XCircle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useBulkTasks, type BulkTask, type BulkTaskType } from '@/context/BulkTaskContext';

const TYPE_ICON: Record<BulkTaskType, React.ElementType> = {
  upload: UploadCloud,
  download: Download,
  delete: Trash2
};

function TaskCard({ task, onDismiss }: { task: BulkTask; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TYPE_ICON[task.type];

  return (
    <div className="rounded-lg border border-ink-100 bg-white shadow-panel overflow-hidden">
      <div className="flex items-start gap-2.5 p-3">
        <div
          className={`mt-0.5 rounded-md p-1.5 shrink-0 ${
            task.status === 'error'
              ? 'bg-reject-light text-reject'
              : task.status === 'success'
              ? 'bg-approve-light text-approve'
              : 'bg-paper text-ink-900'
          }`}
        >
          <Icon size={14} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-ink truncate">{task.label}</p>
            {task.status === 'success' && <CheckCircle2 size={13} className="text-approve shrink-0" />}
            {task.status === 'error' && <XCircle size={13} className="text-reject shrink-0" />}
          </div>

          <p className="text-xs text-ink-700/60 mt-0.5">
            {task.status === 'running' && (task.message || 'In progress\u2026')}
            {task.status === 'success' && (task.message || 'Done.')}
            {task.status === 'error' && (task.message || 'Failed.')}
          </p>

          {task.status === 'running' && (
            <div className="mt-2 space-y-1">
              <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-ink-900 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(4, task.progress))}%` }}
                />
              </div>
              <p className="text-[11px] text-ink-700/50 text-right tabular-nums">
                {Math.round(Math.min(99, task.progress))}%
              </p>
            </div>
          )}

          {task.detail && task.status !== 'running' && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink transition-colors"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? 'Hide details' : 'View details'}
            </button>
          )}
        </div>

        {task.status !== 'running' && (
          <button
            onClick={onDismiss}
            className="text-ink-700/40 hover:text-ink-700 transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && task.detail && (
        <div className="border-t border-ink-100 bg-paper/60 px-3 py-2 max-h-48 overflow-y-auto">{task.detail}</div>
      )}
    </div>
  );
}

/**
 * Fixed bottom-right tray showing active/finished bulk Upload, Download,
 * and Delete jobs. Mounted once in AppLayout (Admin only) so it keeps
 * tracking a job regardless of which page the user navigates to next.
 */
export default function BulkTaskTray() {
  const { tasks, dismissTask, clearFinished } = useBulkTasks();

  if (tasks.length === 0) return null;

  const runningCount = tasks.filter((t) => t.status === 'running').length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] space-y-2">
      {tasks.length > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-medium text-ink-700/60">
            {runningCount > 0 ? `${runningCount} task(s) running` : 'Recent tasks'}
          </span>
          <button
            onClick={clearFinished}
            className="text-xs text-ink-700/50 hover:text-ink transition-colors"
          >
            Clear finished
          </button>
        </div>
      )}

      {tasks
        .slice()
        .reverse()
        .map((task) => (
          <TaskCard key={task.id} task={task} onDismiss={() => dismissTask(task.id)} />
        ))}
    </div>
  );
}