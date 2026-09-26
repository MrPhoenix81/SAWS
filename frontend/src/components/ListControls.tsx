import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  FileSpreadsheet,
  FileText
} from 'lucide-react';

/**
 * Shared building blocks for the Discontinue, Inactive and Transfer list
 * pages so all three look and behave the same way.
 */

export const PAGE_SIZE_OPTIONS = [15, 20, 50, 100] as const;
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number] | 'all';
export const ALL_ROWS_PAGE_SIZE = 9999;

/** Tailwind classes that pin a table's header row while its rows scroll. */
export const STICKY_HEAD_CLASS =
  '[&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:bg-white [&_th]:[box-shadow:inset_0_-1px_0_theme(colors.ink.100)]';

/** Each option row is h-9 (36px), so 180px shows exactly 5 branches at a time. */
const BRANCH_LIST_MAX_HEIGHT = 'max-h-[180px]';

/**
 * Branch dropdown. "All branches" stays pinned at the top; the branch list
 * under it shows 5 branches at a time and scrolls for the rest.
 */
export function BranchFilter({
  value,
  onChange,
  branches
}: {
  value: string;
  onChange: (branch: string) => void;
  branches: string[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function pick(branch: string) {
    onChange(branch);
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-56 items-center justify-between gap-2 rounded-md border border-ink-200 bg-white px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
      >
        <span className="truncate">{value || 'All branches'}</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-ink-100 bg-white shadow-panel"
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => pick('')}
            className="flex h-9 w-full items-center justify-between border-b border-ink-100 px-3 text-left text-sm hover:bg-paper transition-colors"
          >
            <span className={!value ? 'font-medium' : ''}>All branches</span>
            {!value && <Check size={14} className="text-ink-700/60" />}
          </button>
          <div className={`${BRANCH_LIST_MAX_HEIGHT} overflow-y-auto`}>
            {branches.map((b) => (
              <button
                key={b}
                type="button"
                role="option"
                aria-selected={value === b}
                onClick={() => pick(b)}
                className="flex h-9 w-full items-center justify-between px-3 text-left text-sm hover:bg-paper transition-colors"
              >
                <span className={`truncate ${value === b ? 'font-medium' : ''}`}>{b}</span>
                {value === b && <Check size={14} className="shrink-0 text-ink-700/60" />}
              </button>
            ))}
            {branches.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-700/50">No branches found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Batch Name filter - a simple text-match input (Batch Name isn't a fixed,
 * enumerable list the way branches are, so this mirrors BranchFilter's
 * placement/styling but as free text rather than a dropdown).
 */
export function BatchFilter({
  value,
  onChange
}: {
  value: string;
  onChange: (batch: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) onChange(draft.trim());
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      placeholder="Filter by batch name"
      className="w-56 rounded-md border border-ink-200 bg-white px-4 py-2 text-sm text-ink-700/80 placeholder:text-ink-700/40 focus:outline-none focus:ring-2 focus:ring-ink-900 transition-colors"
    />
  );
}

/**
 * Clickable, sortable column header. Cycles asc -> desc -> unsorted on
 * repeated clicks; shows a neutral icon when this column isn't the active sort.
 */
export function SortableTh({
  label,
  sortKey,
  sortBy,
  sortDir,
  onSort
}: {
  label: string;
  sortKey: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSort: (key: string) => void;
}) {
  const active = sortBy === sortKey;
  return (
    <th className="px-4 py-3 font-medium">
      <button
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
        className={`flex items-center gap-1 hover:text-ink transition-colors ${active ? 'text-ink' : ''}`}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
        ) : (
          <ArrowUpDown size={12} className="text-ink-700/30" />
        )}
      </button>
    </th>
  );
}

/** Cycles a column: unsorted -> ascending -> descending -> unsorted. */
export function nextSortState(
  field: string,
  sortBy: string,
  sortDir: 'asc' | 'desc'
): { sortBy: string; sortDir: 'asc' | 'desc' } {
  if (sortBy !== field) return { sortBy: field, sortDir: 'asc' };
  if (sortDir === 'asc') return { sortBy: field, sortDir: 'desc' };
  return { sortBy: '', sortDir: 'asc' };
}

/** "Rows per page ... Page X of Y . N total ... < >" footer bar. */
export function ListFooter({
  page,
  totalPages,
  total,
  pageSize,
  onPageSizeChange,
  onPageChange
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: PageSizeOption;
  onPageSizeChange: (size: PageSizeOption) => void;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-700/60">
      <div className="flex items-center gap-2">
        <span>Rows per page</span>
        <select
          value={pageSize}
          onChange={(e) =>
            onPageSizeChange(e.target.value === 'all' ? 'all' : (Number(e.target.value) as PageSizeOption))
          }
          className="rounded-md border border-ink-200 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="all">All</option>
        </select>
      </div>

      <span>
        Page {page} of {totalPages} &middot; {total} total
      </span>

      {totalPages > 1 && (
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            className="p-1.5 rounded-md border border-ink-200 disabled:opacity-40 hover:bg-paper transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            className="p-1.5 rounded-md border border-ink-200 disabled:opacity-40 hover:bg-paper transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** "Download" button with a CSV / Excel / PDF dropdown. */
export function DownloadMenu({
  exporting,
  onExport
}: {
  exporting: boolean;
  onExport: (format: 'csv' | 'xlsx' | 'pdf') => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  function choose(format: 'csv' | 'xlsx' | 'pdf') {
    setOpen(false);
    onExport(format);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={exporting}
        className="flex items-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors disabled:opacity-60"
      >
        <Download size={16} />
        {exporting ? 'Exporting…' : 'Download'}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-md border border-ink-100 bg-white shadow-panel py-1.5 z-20">
          <button
            onClick={() => choose('csv')}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
          >
            <FileText size={15} className="text-ink-700/60" />
            <span>
              CSV <span className="text-ink-700/40">(.csv)</span>
            </span>
          </button>
          <button
            onClick={() => choose('xlsx')}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
          >
            <FileSpreadsheet size={15} className="text-ink-700/60" />
            <span>
              Excel <span className="text-ink-700/40">(.xlsx)</span>
            </span>
          </button>
          <button
            onClick={() => choose('pdf')}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
          >
            <FileDown size={15} className="text-ink-700/60" />
            <span>
              PDF <span className="text-ink-700/40">(.pdf)</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}