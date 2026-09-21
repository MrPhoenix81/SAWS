import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  X,
  Check,
  XCircle,
  Clock,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  FileText,
  FileSpreadsheet,
  FileDown,
  Copy,
  CheckCheck,
  Info,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Image as ImageIcon,
  Loader2
} from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  listStudents,
  listBranches,
  submitStudentEntry,
  submitScmReason,
  submitHofReason,
  submitManagerReason,
  headOfficeApprove,
  headOfficeReject,
  approveStudentEntry,
  rejectStudentEntry,
  deleteStudentEntry,
  scmUpdateStudentDetails,
  adminUpdateStudent,
  exportStudents,
  markPageSeen,
  getReasonScreenshotUrl,
  ApiError
} from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import { BranchFilter } from '@/components/ListControls';
import type { StudentEntry, StudentStatus } from '@/types';
import { STATUS_LABELS } from '@/types';

// Matches the real 7 backend statuses (see Config.gs STATUS_LABELS / STATUS_LABELS
// in types/index.ts) - there is no plain 'REJECTED' status; a rejection sends the
// record back to PENDING_SCM instead.
const STATUS_STYLES: Record<StudentStatus, string> = {
  PENDING_HOF_MANAGER: 'bg-amber-light text-amber',
  WAITING_FOR_MANAGER: 'bg-amber-light text-amber',
  WAITING_FOR_HOF: 'bg-amber-light text-amber',
  PENDING_HEAD_OFFICE: 'bg-amber-light text-amber',
  PENDING_ADMIN: 'bg-amber-light text-amber',
  APPROVED: 'bg-approve-light text-approve',
  PENDING_SCM: 'bg-reject-light text-reject',
  PENDING_CORRECTION: 'bg-reject-light text-reject'
};

/** The 3 roles Head Office can flag on a rejection. */
const CORRECTABLE_ROLES: { value: 'SCM' | 'HOF' | 'Manager'; label: string }[] = [
  { value: 'SCM', label: 'SCM' },
  { value: 'HOF', label: 'HOF' },
  { value: 'Manager', label: 'Manager' }
];

const PAGE_SIZE_OPTIONS = [15, 20, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number] | 'all';
const ALL_ROWS_PAGE_SIZE = 9999;

/**
 * Builds a CSV Blob from row objects and triggers a browser download.
 */
function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escapeCell = (value: unknown) => {
    const s = value === null || value === undefined ? '' : String(value);
    // Quote any cell containing a comma, quote, or newline; double up
    // internal quotes per the CSV spec (RFC 4180).
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Builds a real .xlsx workbook (one sheet, auto-sized columns) and
 * triggers a browser download.
 */
function downloadXlsx(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  worksheet['!cols'] = headers.map((h) => {
    const maxLen = Math.max(h.length, ...rows.map((r) => String(r[h] ?? '').length));
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');
  XLSX.writeFile(workbook, filename);
}

/**
 * Builds a landscape PDF table and triggers a browser download. Column
 * text is shrunk to fit since student rows can have a dozen+ columns.
 */
function downloadPdf(filename: string, title: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(13);
  doc.text(title, 32, 28);
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString()} · ${rows.length} row(s)`, 32, 42);
  autoTable(doc, {
    startY: 52,
    head: [headers],
    body: rows.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? '' : String(r[h])))),
    styles: { fontSize: 6.5, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [28, 27, 26], textColor: 255 },
    margin: { left: 24, right: 24 },
    theme: 'striped'
  });
  doc.save(filename);
}

/**
 * Turns an ApiError into something actionable instead of a generic
 * "please try again" - surfaces the server's error code (and message,
 * if any) so mismatches like AUTH_FORBIDDEN or a stale deployment
 * returning UNKNOWN_ACTION are visible instead of silently swallowed.
 */
function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const KNOWN_CODES: Record<string, string> = {
      AUTH_FORBIDDEN: "You don't have permission to do this (branch mismatch, role restriction, or this entry has already moved past your step).",
      STUDENT_NOT_FOUND: 'This entry could not be found — it may have already been approved (and moved to Discontinued) or removed.',
      UNKNOWN_ACTION: "The server doesn't recognize this request yet — the backend deployment likely needs to be updated to a new version.",
      AUTH_INVALID_TOKEN: 'Your session has expired. Please sign in again.',
      AUTH_NOT_REGISTERED: 'Your account is no longer registered.',
      SERVER_ERROR: 'The server hit an unexpected error. Check the Apps Script Executions log for details.'
    };
    const known = KNOWN_CODES[err.code];
    if (known) return known;
    return err.message ? `${fallback} (${err.code}: ${err.message})` : `${fallback} (${err.code})`;
  }
  return fallback;
}

export default function Students() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<'response' | 'completed'>(
    searchParams.get('tab') === 'completed' ? 'completed' : 'response'
  );
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [branchFilter, setBranchFilter] = useState<string>('');

  const [sortBy, setSortBy] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  // Rows-per-page selector: defaults to 15, with 20/50/100/All also
  // available. "All" just requests a very large page size in one go
  // rather than switching to a different fetch strategy.
  const [pageSize, setPageSize] = useState<PageSizeOption>(15);
  const effectivePageSize = pageSize === 'all' ? ALL_ROWS_PAGE_SIZE : pageSize;

  function selectPageSize(value: string) {
    setPageSize(value === 'all' ? 'all' : (Number(value) as PageSizeOption));
    setPage(1);
  }

  // Item 7: opening this page clears the sidebar's red "unseen" badge
  // for Discontinue - it does NOT depend on acting on anything, just
  // on having opened the page. Re-fetch the badge right after so it
  // drops to 0 immediately instead of waiting for the next poll.
  useEffect(() => {
    markPageSeen('discontinue')
      .then(() => queryClient.invalidateQueries({ queryKey: ['activeCounts'] }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lets NotificationBell deep-link here as /students?search=<MID> - only
  // reacts to the URL changing (e.g. clicking another notification while
  // already on this page), not to the user's own typing.
  useEffect(() => {
    const fromUrl = searchParams.get('search');
    if (fromUrl && fromUrl !== search) {
      setSearch(fromUrl);
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Lets the sidebar's Active/Discontinued sub-links deep-link here as
  // /students?tab=active or /students?tab=completed - reacts to the URL
  // changing so clicking those links while already on this page still
  // switches the tab.
  useEffect(() => {
    const fromUrl = searchParams.get('tab') === 'completed' ? 'completed' : 'response';
    if (fromUrl !== tab) {
      setTab(fromUrl);
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Switches the in-page tab and keeps the URL's ?tab= param in sync, so
  // the sidebar sub-links stay highlighted correctly and the tab survives
  // a refresh or direct link.
  function selectTab(t: 'response' | 'completed') {
    setTab(t);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (t === 'completed') {
      next.set('tab', 'completed');
    } else {
      next.delete('tab');
    }
    setSearchParams(next, { replace: true });
  }

  const [reasonTarget, setReasonTarget] = useState<{
    row: StudentEntry;
    role: 'SCM' | 'HOF' | 'Manager';
  } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<StudentEntry | null>(null);
  const [adminEditTarget, setAdminEditTarget] = useState<StudentEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudentEntry | null>(null);
  const [scmEditTarget, setScmEditTarget] = useState<StudentEntry | null>(null);
  const [selectedStudentForDetails, setSelectedStudentForDetails] = useState<StudentEntry | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const branchesQuery = useQuery({ queryKey: ['branches'], queryFn: listBranches });

  const params = useMemo(
    () => ({
      // Single combined box: same term is matched against MID, name, and
      // all phone numbers server-side (OR, not AND). See note in apiClient.ts -
      // students.list on the backend needs to do the same OR-style match.
      search: search || undefined,
      branch: branchFilter || undefined,
      sortBy: sortBy || undefined,
      sortDir: sortBy ? sortDir : undefined,
      page,
      pageSize: effectivePageSize
    }),
    [
      search,
      branchFilter,
      sortBy,
      sortDir,
      page,
      effectivePageSize
    ]
  );

  const studentsQuery = useQuery({
    queryKey: ['students', tab, params],
    queryFn: () => listStudents(tab, params)
  });

  // Only SCM may create a brand new discontinuation entry - not even
  // Admin. Admin can still edit/approve/reject/delete existing entries,
  // just can't originate one (see submitStudentEntry_ in Students.gs,
  // which now also enforces this server-side).
  // Admin and Head Office both get the full, cross-branch, all-reasons view
  // (see Filters.gs filterStudentRowForRole_ - Head Office is treated exactly
  // like Admin on the backend). SCM/HOF/Manager stay scoped to their own branch.
  const hasFullVisibility = user?.role === 'Admin' || user?.role === 'Head Office';
  const totalPages = studentsQuery.data
    ? Math.max(1, Math.ceil(studentsQuery.data.total / effectivePageSize))
    : 1;

  function resetFiltersAndReload() {
    setPage(1);
    queryClient.invalidateQueries({ queryKey: ['students'] });
    queryClient.invalidateQueries({ queryKey: ['activeCounts'] });
  }

  /**
   * Cycles a column header through: unsorted -> ascending -> descending ->
   * back to unsorted (the backend's default ordering, which bubbles
   * actionable rows to the top for Admin/Head Office). Clicking a
   * different column always starts that column fresh at ascending.
   */
  function toggleSort(field: string) {
    setPage(1);
    if (sortBy !== field) {
      setSortBy(field);
      setSortDir('asc');
      return;
    }
    if (sortDir === 'asc') {
      setSortDir('desc');
      return;
    }
    setSortBy('');
    setSortDir('asc');
  }

  /**
   * Reuses the exact filters currently applied to the table (search,
   * status, branch) but with a high pageSize so every matching row
   * comes back in one call instead of just the current page.
   */
  async function handleExport(format: 'csv' | 'xlsx' | 'pdf') {
    setExportError(null);
    setExporting(true);
    setExportMenuOpen(false);
    try {
      const result = await exportStudents(tab, {
        search: search || undefined,
        branch: branchFilter || undefined,
        sortBy: sortBy || undefined,
        sortDir: sortBy ? sortDir : undefined,
        page: 1,
        pageSize: 9999
      });
      if (result.rows.length === 0) {
        setExportError('No rows match the current filters - nothing to export.');
        return;
      }
      const rows = result.rows as unknown as Record<string, unknown>[];
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `students-${tab}-${stamp}`;
      if (format === 'csv') downloadCsv(`${base}.csv`, rows);
      else if (format === 'xlsx') downloadXlsx(`${base}.xlsx`, rows);
      else
        downloadPdf(
          `${base}.pdf`,
          `Discontinue — ${tab === 'response' ? 'Active' : 'Approved list'}`,
          rows
        );
    } catch (err) {
      setExportError(describeApiError(err, 'Could not export. Please try again.'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <div className="shrink-0 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">{tab === 'response' ? 'Discontinue' : 'Approved'}</h2>
          <p className="text-sm text-ink-700/60 mt-1">
            {hasFullVisibility ? 'Every branch.' : `${user?.branch} branch.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasFullVisibility && (
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors disabled:opacity-60"
            >
              <Download size={16} />
              {exporting ? 'Exporting…' : 'Download'}
              <ChevronDown size={14} className={`transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {exportMenuOpen && (
              <div className="absolute right-0 mt-2 w-72 rounded-md border border-ink-100 bg-white shadow-panel py-1.5 z-10">
                <p className="px-3 pt-1 pb-2 text-xs text-ink-700/50 border-b border-ink-100 mb-1">
                  Downloads every row matching your current search and branch filter
                  {hasFullVisibility && branchFilter ? ` (${branchFilter})` : ''}.
                </p>
                <button
                  onClick={() => handleExport('csv')}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
                >
                  <FileText size={15} className="text-ink-700/60" />
                  <span>
                    CSV <span className="text-ink-700/40">(.csv)</span>
                  </span>
                </button>
                <button
                  onClick={() => handleExport('xlsx')}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
                >
                  <FileSpreadsheet size={15} className="text-ink-700/60" />
                  <span>
                    Excel <span className="text-ink-700/40">(.xlsx)</span>
                  </span>
                </button>
                <button
                  onClick={() => handleExport('pdf')}
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
          )}
        </div>
      </div>

      {exportError && (
        <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{exportError}</div>
      )}

      <div className="shrink-0 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, MID, or phone number"
            className="w-full rounded-md border border-ink-200 pl-8 pr-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>

        {hasFullVisibility && (
          <BranchFilter
            value={branchFilter}
            onChange={(b) => {
              setBranchFilter(b);
              setPage(1);
            }}
            branches={branchesQuery.data || []}
          />
        )}

        {(search || branchFilter) && (
          <button
            onClick={() => {
              setSearch('');
              setBranchFilter('');
              setPage(1);
            }}
            className="flex items-center gap-1 text-sm text-ink-700/50 hover:text-ink-700 transition-colors px-1"
          >
            <X size={13} />
            Clear filters
          </button>
        )}
      </div>

      {studentsQuery.isLoading && (
        <p className="text-sm text-ink-700/60 px-1">Loading students&hellip;</p>
      )}
      {studentsQuery.isError && (
        <p className="text-sm text-reject px-1">Couldn&rsquo;t load the list. Please refresh.</p>
      )}

      {studentsQuery.data && (() => {
        // Split into two separate tables so a user can tell at a glance
        // which entries are actually theirs to act on right now, vs.
        // everything else. Only relevant on the active tab - once
        // nothing is left awaiting this user (or we're on the
        // Approved/completed tab), only the single full table remains.
        const allRows = studentsQuery.data.rows;
        const attentionRows = tab === 'response' ? allRows.filter((r) => r['Awaiting My Action']) : [];
        const hasAttention = attentionRows.length > 0;
        const mainRows = hasAttention ? allRows.filter((r) => !r['Awaiting My Action']) : allRows;

        const renderHead = () => (
          <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:bg-white [&_th]:[box-shadow:inset_0_-1px_0_theme(colors.ink.100)]">
            <tr className="text-left text-xs uppercase tracking-wide text-ink-700/50">
              <th className="px-4 py-3 font-medium">#</th>
              {showsBillingColumns(user?.role) && (
                <SortableTh label="MID" sortKey="MID" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
              )}
              <SortableTh label="Student" sortKey="Student Name" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
              {user?.role === 'Head Office' && (
                <SortableTh label="Branch" sortKey="Branch" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
              )}
              <th className="px-4 py-3 font-medium">Phone numbers</th>
              <SortableTh label="Status" sortKey="Status" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3 font-medium">{reasonColumnLabel(user?.role)}</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
        );

        const renderRows = (rows: StudentEntry[], emptyMessage: string) => (
          <tbody>
            {rows.map((row, index) => (
              <StudentRow
                key={row.MID}
                row={row}
                serial={(page - 1) * effectivePageSize + index + 1}
                isAdmin={user?.role === 'Admin'}
                isHeadOffice={user?.role === 'Head Office'}
                sheet={tab}
                onFillReason={(role) => setReasonTarget({ row, role })}
                onReject={() => setRejectTarget(row)}
                onEditFull={() => setAdminEditTarget(row)}
                onDelete={() => setDeleteTarget(row)}
                onEditDetails={() => setScmEditTarget(row)}
                onShowDetails={() => setSelectedStudentForDetails(row)}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-5 py-8 text-center text-ink-700/50 text-sm">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        );

        return (
          <div className="flex-1 min-h-0 overflow-auto space-y-6">
            {hasAttention && (
              <div className="bg-white rounded-lg border-2 border-amber shadow-panel overflow-clip min-w-fit">
                <div className="px-4 py-2.5 bg-amber-light border-b border-amber/30">
                  <h3 className="text-sm font-semibold text-amber">
                    Needs Your Attention ({attentionRows.length})
                  </h3>
                </div>
                <table className="w-full text-sm min-w-[900px]">
                  {renderHead()}
                  {renderRows(attentionRows, 'Nothing here.')}
                </table>
              </div>
            )}

            <div className="bg-white rounded-lg border border-ink-100 shadow-panel overflow-clip min-w-fit">
              <table className="w-full text-sm min-w-[900px]">
                {renderHead()}
                {renderRows(mainRows, 'No entries match this search.')}
              </table>
            </div>
          </div>
        );
      })()}

      {studentsQuery.data && (
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-700/60">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => selectPageSize(e.target.value)}
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
            Page {page} of {totalPages} &middot; {studentsQuery.data.total} total
          </span>

          {totalPages > 1 && (
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="p-1.5 rounded-md border border-ink-200 disabled:opacity-40 hover:bg-paper transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1.5 rounded-md border border-ink-200 disabled:opacity-40 hover:bg-paper transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      {reasonTarget && (
        <ReasonModal
          row={reasonTarget.row}
          role={reasonTarget.role}
          onClose={() => setReasonTarget(null)}
          onSaved={() => {
            setReasonTarget(null);
            resetFiltersAndReload();
          }}
        />
      )}

      {rejectTarget && (
        <RejectModal
          row={rejectTarget}
          actingRole={user?.role === 'Head Office' ? 'Head Office' : 'Admin'}
          onClose={() => setRejectTarget(null)}
          onSaved={() => {
            setRejectTarget(null);
            resetFiltersAndReload();
          }}
        />
      )}

      {adminEditTarget && (
        <AdminEditModal
          row={adminEditTarget}
          sheet={tab}
          canEditReasons={user?.role === 'Head Office'}
          onClose={() => setAdminEditTarget(null)}
          onSaved={() => {
            setAdminEditTarget(null);
            resetFiltersAndReload();
          }}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          row={deleteTarget}
          sheet={tab}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            resetFiltersAndReload();
          }}
        />
      )}

      {scmEditTarget && (
        <ScmEditDetailsModal
          row={scmEditTarget}
          onClose={() => setScmEditTarget(null)}
          onSaved={() => {
            setScmEditTarget(null);
            resetFiltersAndReload();
          }}
        />
      )}

      {selectedStudentForDetails && (
        <StudentDetailsModal
          row={selectedStudentForDetails}
          isAdmin={user?.role === 'Admin'}
          isHeadOffice={user?.role === 'Head Office'}
          sheet={tab}
          onFillReason={(role) => {
            setReasonTarget({ row: selectedStudentForDetails, role });
            setSelectedStudentForDetails(null);
          }}
          onReject={() => {
            setRejectTarget(selectedStudentForDetails);
            setSelectedStudentForDetails(null);
          }}
          onEditFull={() => {
            setAdminEditTarget(selectedStudentForDetails);
            setSelectedStudentForDetails(null);
          }}
          onDelete={() => {
            setDeleteTarget(selectedStudentForDetails);
            setSelectedStudentForDetails(null);
          }}
          onEditDetails={() => {
            setScmEditTarget(selectedStudentForDetails);
            setSelectedStudentForDetails(null);
          }}
          onClose={() => setSelectedStudentForDetails(null)}
        />
      )}

    </div>
  );
}

/**
 * Shared derived state used by both the table row and the detail popup, so
 * the two never disagree about who can do what to a given entry.
 *
 * IMPORTANT: whether SCM/HOF/Manager may currently edit their reason is
 * NOT re-derived from Status here anymore. The server (Filters.py) is the
 * single source of truth for that - it returns `row.canEdit`, which is
 * false once that role has submitted their reason, and only becomes true
 * again if Head Office rejects and names that specific role. We just
 * read that flag; we never guess it from Status on the client.
 */
// Item 1: prefer the server-computed 'Current Stage' label, which
// spells out exactly which role(s) - SCM, HOF, Manager - are still
// pending correction (e.g. "Pending Correction: SCM & Manager") and
// automatically narrows down as each flagged role resubmits. Falls
// back to the plain status label for statuses without that detail.
function statusDisplay(row: StudentEntry): string {
  return row['Current Stage'] || STATUS_LABELS[row.Status] || row.Status;
}

function computeStudentRowState(
  row: StudentEntry,
  isAdmin: boolean,
  isHeadOffice: boolean,
  sheet: 'response' | 'completed',
  userRole?: string
) {
  const hasFullView = isAdmin || isHeadOffice;
  const status = row.Status;
  const locked = !row.canEdit;
  const phones = [row['Phone Number 1'], row['Phone Number 2'], row['Phone Number 3']].filter(
    Boolean
  ) as string[];

  const roleReasonKey: 'Reason (SCM)' | 'Confirmed Reason' | 'Verified Reason' =
    userRole === 'HOF' ? 'Confirmed Reason' : userRole === 'Manager' ? 'Verified Reason' : 'Reason (SCM)';
  const reasonText = (row as unknown as Record<string, string>)[roleReasonKey] || '';

  const adminReasons: { label: string; role: 'SCM' | 'HOF' | 'Manager'; value?: string; updatedAt?: string }[] = hasFullView
    ? [
        { label: 'SCM', role: 'SCM', value: row['Reason (SCM)'], updatedAt: row['SCM Updated Date'] },
        { label: 'HOF', role: 'HOF', value: row['Reason (HOF)'], updatedAt: row['HOF Updated Date'] },
        { label: 'Manager', role: 'Manager', value: row['Reason (Manager)'], updatedAt: row['Manager Updated Date'] }
      ]
    : [];

  // sheet === 'response' guards against a stale/cached row from the
  // Completed list ever showing action buttons.
  const scmCanAct = userRole === 'SCM' && row.canEdit === true && sheet === 'response';
  const hofCanAct = userRole === 'HOF' && row.canEdit === true && sheet === 'response';
  const managerCanAct = userRole === 'Manager' && row.canEdit === true && sheet === 'response';
  const adminCanDecide = userRole === 'Admin' && status === 'PENDING_ADMIN' && sheet === 'response';
  const headOfficeCanDecide = userRole === 'Head Office' && status === 'PENDING_HEAD_OFFICE' && sheet === 'response';
  // True once this row has been rejected at least once and is now
  // sitting back with SCM (full reset) or with specific flagged
  // role(s) (targeted correction).
  const wasRejected = status === 'PENDING_SCM' || status === 'PENDING_CORRECTION';

  return {
    row,
    hasFullView,
    status,
    locked,
    phones,
    reasonText,
    adminReasons,
    scmCanAct,
    hofCanAct,
    managerCanAct,
    adminCanDecide,
    headOfficeCanDecide,
    wasRejected
  };
}

/**
 * Plain-language "what should I do here" line shown at the top of the
 * detail popup, tailored to the viewing user's role and this entry's stage.
 */
function getGuidanceMessage(
  state: ReturnType<typeof computeStudentRowState>,
  userRole: string | undefined,
  sheet: 'response' | 'completed'
): string {
  const { status, hasFullView, scmCanAct, hofCanAct, managerCanAct, adminCanDecide, headOfficeCanDecide, reasonText } =
    state;

  if (sheet === 'completed' || status === 'APPROVED') {
    return 'This entry is fully approved and marked as discontinued. No further action is needed.';
  }
  if (headOfficeCanDecide) {
    return 'This is waiting on your decision. Approve to send it to Admin for final verification, or Reject to send it back to SCM for revision.';
  }
  if (adminCanDecide) {
    return 'Head Office has approved this entry. Approve to mark it fully discontinued, or Reject to send it back to SCM for revision.';
  }
  if ((scmCanAct || hofCanAct || managerCanAct) && !reasonText) {
    return 'This entry needs your reason before it can move forward. Use "Add reason" below.';
  }
  if ((scmCanAct || hofCanAct || managerCanAct) && reasonText) {
    return status === 'PENDING_SCM' || status === 'PENDING_CORRECTION'
      ? 'This was rejected and sent back for revision. Update your reason and it will re-enter the approval queue.'
      : 'You\u2019ve submitted your reason. It\u2019s still waiting on the others in the approval chain \u2014 no further action needed from you right now.';
  }
  if (hasFullView) {
    if (status === 'PENDING_SCM') return 'This entry was rejected (full reset) and is back with SCM for revision.';
    if (status === 'PENDING_CORRECTION') {
      const flagged = state.row['Rejected Roles List'];
      return flagged && flagged.length
        ? `Head Office rejected this and flagged ${flagged.join(', ')} to correct their reason. Waiting on them.`
        : 'Head Office rejected this and flagged specific role(s) to correct their reason.';
    }
    if (status === 'PENDING_HOF_MANAGER' || status === 'WAITING_FOR_HOF' || status === 'WAITING_FOR_MANAGER') {
      return 'Waiting on HOF and/or Manager to submit their reasons before this can reach Head Office.';
    }
    if (status === 'PENDING_HEAD_OFFICE') return 'Waiting on Head Office to approve or reject this entry.';
    if (status === 'PENDING_ADMIN') return 'Waiting on Admin to give final verification.';
  }
  return 'No action is available on this entry for your role at its current stage.';
}

/**
 * Clickable, sortable column header. Cycles asc -> desc -> unsorted on
 * repeated clicks (see toggleSort in Students()); shows a neutral icon
 * when this column isn't the active sort.
 */
function SortableTh({
  label,
  sortKey,
  sortBy,
  sortDir,
  onSort,
  align
}: {
  label: string;
  sortKey: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSort: (key: string) => void;
  align?: 'right';
}) {
  const active = sortBy === sortKey;
  return (
    <th className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
        className={`flex items-center gap-1 hover:text-ink transition-colors ${
          align === 'right' ? 'ml-auto' : ''
        } ${active ? 'text-ink' : ''}`}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : (
          <ArrowUpDown size={12} className="text-ink-700/30" />
        )}
      </button>
    </th>
  );
}

function reasonColumnLabel(role?: string) {
  if (role === 'HOF') return 'Confirmed reason';
  if (role === 'Manager') return 'Verified reason';
  if (role === 'SCM') return 'Reason';
  if (role === 'Admin' || role === 'Head Office') return 'Reasons';
  return 'Reason';
}

// Billing (MID / Arrear) columns are only meaningful for SCM, Admin, and Head
// Office - HOF/Manager get the narrow view (see Filters.gs) which omits them.
function showsBillingColumns(role?: string) {
  return role === 'SCM' || role === 'Admin' || role === 'Head Office';
}

function formatUpdatedAt(value?: string) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function ReasonBox({
  label, value, defaultOpen = false, updatedAt, imageSlot
}: { label: string; value?: string; defaultOpen?: boolean; updatedAt?: string; imageSlot?: React.ReactNode }) {
  const stamp = formatUpdatedAt(updatedAt);
  return (
    <details open={defaultOpen} className="rounded-lg border border-ink-100 bg-white overflow-hidden">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium hover:bg-paper transition-colors flex items-center justify-between">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {imageSlot}
          <ChevronDown size={16} className="text-ink-700/40" />
        </span>
      </summary>
      <div className="border-t border-ink-100 p-3">
        {stamp && (
          <p className="text-xs text-ink-700/40 mb-1.5">Last updated: {stamp}</p>
        )}
        {/* min-h sets the starting size; no max-h so the resize handle (resize-y)
            can grow the box as large as the user drags it, not just shrink it. */}
        <div className="min-h-[80px] overflow-y-auto resize-y whitespace-pre-wrap break-words text-sm leading-6 text-ink-700/80 pr-2">
          {value?.trim() || <span className="italic text-ink-700/30">Not yet provided</span>}
        </div>
      </div>
    </details>
  );
}

/**
 * One row per role in the full-view reasons section: role label fixed
 * on the left, its reason in a scrollable box on the right. Rows stack
 * vertically (SCM, then HOF, then Manager) per the requested layout.
 */
function ReasonRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-stretch gap-4 rounded-lg border border-ink-100 bg-white p-3">
      <div className="w-20 shrink-0 flex items-start pt-1">
        <span className="text-sm font-medium text-ink-900">{label}</span>
      </div>
      <div className="flex-1 min-w-0 min-h-[70px] overflow-y-auto resize-y whitespace-pre-wrap break-words text-sm leading-6 text-ink-700/80 border-l border-ink-100 pl-4 pr-2 py-1">
        {value?.trim() || <span className="italic text-ink-700/30">Not yet provided</span>}
      </div>
    </div>
  );
}

function StudentDetailsModal({
  row, isAdmin, isHeadOffice, sheet, onFillReason, onReject, onEditFull, onDelete, onEditDetails, onClose
}: {
  row: StudentEntry; isAdmin: boolean; isHeadOffice: boolean; sheet: 'response' | 'completed';
  onFillReason: (role: 'SCM' | 'HOF' | 'Manager') => void; onReject: () => void; onEditFull: () => void;
  onDelete: () => void; onEditDetails: () => void; onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = computeStudentRowState(row, isAdmin, isHeadOffice, sheet, user?.role);
  const { hasFullView, status, phones, reasonText, adminReasons, scmCanAct, hofCanAct, managerCanAct, adminCanDecide, headOfficeCanDecide, wasRejected } = state;
  const zoom = useImageZoom();

  const approveMutation = useMutation({
    mutationFn: () => approveStudentEntry(row.MID),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['students'] }); queryClient.invalidateQueries({ queryKey: ['activeCounts'] }); onClose(); },
    onError: (err) => setActionError(describeApiError(err, 'Could not approve this entry. Please try again.'))
  });
  const headOfficeApproveMutation = useMutation({
    mutationFn: () => headOfficeApprove(row.MID),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['students'] }); queryClient.invalidateQueries({ queryKey: ['activeCounts'] }); onClose(); },
    onError: (err) => setActionError(describeApiError(err, 'Could not approve this entry. Please try again.'))
  });

  async function copyPhone(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      setCopiedPhone(phone);
      setTimeout(() => setCopiedPhone((cur) => (cur === phone ? null : cur)), 1500);
    } catch {
      setActionError('Could not copy — your browser may be blocking clipboard access.');
    }
  }

  const canFillOwnReason = (scmCanAct || hofCanAct || managerCanAct) && !hasFullView;
  // Same rule as the table preview: SCM/HOF/Manager only see their own
  // reason while it's still theirs to act on. Admin/Head Office always see
  // everything via adminReasons (hasFullView), regardless of this flag.
  const canSeeOwnReason = canFillOwnReason;

  return (
    <ModalShell onClose={onClose} wide>
      {zoom.node}
      <div className="space-y-5">
        <div>
          <h2 className="font-display text-xl mb-1">{row['Student Name']}</h2>
          <p className="text-sm text-ink-700/60">{row.MID}</p>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Student details</p>
            <dl className="space-y-1.5 text-sm">
              <div><dt className="inline text-ink-700/50">MID:</dt> <dd className="inline font-mono">{row.MID || '—'}</dd></div>
              <div><dt className="inline text-ink-700/50">Name:</dt> <dd className="inline">{row['Student Name'] || '—'}</dd></div>
              {hasFullView && <div><dt className="inline text-ink-700/50">Branch:</dt> <dd className="inline">{row.Branch || '—'}</dd></div>}
              <div><dt className="inline text-ink-700/50">Status:</dt> <dd className="inline">{statusDisplay(row)}</dd></div>
            </dl>
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Phone numbers</p>
            {phones.length ? (
              <div className="space-y-2">
                {[
                  ['Phone 1 — Student', row['Phone Number 1']],
                  ['Phone 2 — Parent 1', row['Phone Number 2']],
                  ['Phone 3 — Parent 2', row['Phone Number 3']]
                ].map(([label, phone]) => phone ? (
                  <div key={String(label)} className="flex items-center justify-between gap-3 text-sm">
                    <div><span className="text-ink-700/50 text-xs block">{label}</span><span className="font-mono">{phone}</span></div>
                    <button onClick={(e) => { e.stopPropagation(); copyPhone(String(phone)); }} className="inline-flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink-900" title="Copy phone number">
                      {copiedPhone === phone ? <CheckCheck size={14} className="text-approve" /> : <Copy size={14} />} {copiedPhone === phone ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : null)}
              </div>
            ) : <p className="text-sm text-ink-700/30 italic">No phone numbers on file</p>}
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Other information</p>
            <div className="space-y-1.5 text-sm text-ink-700/80">
              <p>Last present: {row['Last Present Day'] || '—'}</p>
              <p>Days Since Last Present: {row['Days Since Last Present'] ?? row['Days Since Present'] ?? '—'}</p>
              <p>Entry date: {row['Entry Date'] ? new Date(row['Entry Date']).toLocaleDateString() : '—'}</p>
              {showsBillingColumns(user?.role) && <>
                <p>Total billed: ₹{Number(row['Total Billed'] || 0).toLocaleString('en-IN')}</p>
                <p>Total paid: ₹{Number(row['Total Paid'] || 0).toLocaleString('en-IN')}</p>
                <p className="text-reject">Arrear: ₹{Number(row.Arrear || 0).toLocaleString('en-IN')}</p>
              </>}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-ink-700/50">Reasons</p>
          {hasFullView ? (
            <div className="space-y-2.5">
              {adminReasons.map((r) => (
                <ReasonBox
                  key={r.label}
                  label={r.label}
                  value={r.value}
                  updatedAt={r.updatedAt}
                  defaultOpen
                  imageSlot={
                    <ReasonBoxImageIcon
                      mid={row.MID}
                      sheet={sheet}
                      role={r.role}
                      uploaded={Boolean((row as unknown as Record<string, boolean>)[`${r.role} Screenshot Uploaded`])}
                      onView={zoom.open}
                    />
                  }
                />
              ))}
            </div>
          ) : canSeeOwnReason ? (
            <ReasonBox label={reasonColumnLabel(user?.role)} value={reasonText} defaultOpen />
          ) : (
            <p className="text-sm text-ink-700/50 italic">You've submitted your reason. It's no longer shown here — only Admin and Head Office can view it from this point.</p>
          )}
          {row['Last Rejection Reason'] && (
            <ReasonBox label={`Last rejection — ${row['Last Rejected By'] || 'Unknown'} (${row['Last Rejected Stage'] || '—'})`} value={row['Last Rejection Reason']} defaultOpen />
          )}
        </div>

        {wasRejected && !hasFullView && (scmCanAct || hofCanAct || managerCanAct) && (
          <p className="text-sm text-reject">This request was rejected. Please revise and resubmit your assigned correction.</p>
        )}
        {actionError && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{actionError}</div>}

        <div className="flex flex-wrap gap-2 pt-4 border-t border-ink-100">
          {canFillOwnReason && (
            <button onClick={() => onFillReason(user!.role as 'SCM' | 'HOF' | 'Manager')} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white">
              <Clock size={14} /> {reasonText ? 'Edit reason' : 'Add reason'}
            </button>
          )}
          {scmCanAct && (
            <button onClick={() => onEditDetails()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white">
              <Pencil size={14} /> Edit student details
            </button>
          )}
          {headOfficeCanDecide && <>
            <button disabled={headOfficeApproveMutation.isPending} onClick={() => headOfficeApproveMutation.mutate()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm disabled:opacity-60"><Check size={14} /> Approve</button>
            <button onClick={() => onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14} /> Reject</button>
          </>}
          {adminCanDecide && <>
            <button disabled={approveMutation.isPending} onClick={() => approveMutation.mutate()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm disabled:opacity-60"><Check size={14} /> Approve</button>
            <button onClick={() => onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14} /> Reject</button>
          </>}
          {(isAdmin || isHeadOffice) && (
            <button onClick={() => onEditFull()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white"><Pencil size={14} /> Edit full record</button>
          )}
          {(isAdmin || isHeadOffice) && (
            <button onClick={() => onDelete()} className="inline-flex items-center gap-1.5 rounded-md border border-reject/30 text-reject px-3 py-1.5 text-sm hover:bg-reject-light"><Trash2 size={14} /> Delete permanently</button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function StudentExpandedDetails({
  row, isAdmin, isHeadOffice, sheet, onFillReason, onReject, onEditFull, onDelete, onEditDetails, onClose
}: {
  row: StudentEntry; isAdmin: boolean; isHeadOffice: boolean; sheet: 'response' | 'completed';
  onFillReason: (role: 'SCM' | 'HOF' | 'Manager') => void; onReject: () => void; onEditFull: () => void;
  onDelete: () => void; onEditDetails: () => void; onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = computeStudentRowState(row, isAdmin, isHeadOffice, sheet, user?.role);
  const { hasFullView, status, phones, reasonText, adminReasons, scmCanAct, hofCanAct, managerCanAct, adminCanDecide, headOfficeCanDecide, wasRejected } = state;
  const zoom = useImageZoom();

  const approveMutation = useMutation({
    mutationFn: () => approveStudentEntry(row.MID),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['students'] }); queryClient.invalidateQueries({ queryKey: ['activeCounts'] }); onClose(); },
    onError: (err) => setActionError(describeApiError(err, 'Could not approve this entry. Please try again.'))
  });
  const headOfficeApproveMutation = useMutation({
    mutationFn: () => headOfficeApprove(row.MID),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['students'] }); queryClient.invalidateQueries({ queryKey: ['activeCounts'] }); onClose(); },
    onError: (err) => setActionError(describeApiError(err, 'Could not approve this entry. Please try again.'))
  });

  async function copyPhone(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      setCopiedPhone(phone);
      setTimeout(() => setCopiedPhone((cur) => (cur === phone ? null : cur)), 1500);
    } catch {
      setActionError('Could not copy — your browser may be blocking clipboard access.');
    }
  }

  const canFillOwnReason = (scmCanAct || hofCanAct || managerCanAct) && !hasFullView;
  const canSeeOwnReason = canFillOwnReason;

  return (
    <tr className="bg-paper/40 border-b border-ink-100">
      <td colSpan={99} className="px-5 py-5">
        {zoom.node}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Student details</p>
            <dl className="space-y-1.5 text-sm">
              <div><dt className="inline text-ink-700/50">MID:</dt> <dd className="inline font-mono">{row.MID || '—'}</dd></div>
              <div><dt className="inline text-ink-700/50">Name:</dt> <dd className="inline">{row['Student Name'] || '—'}</dd></div>
              {hasFullView && <div><dt className="inline text-ink-700/50">Branch:</dt> <dd className="inline">{row.Branch || '—'}</dd></div>}
              <div><dt className="inline text-ink-700/50">Status:</dt> <dd className="inline">{statusDisplay(row)}</dd></div>
            </dl>
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Phone numbers</p>
            {phones.length ? (
              <div className="space-y-2">
                {[
                  ['Phone 1 — Student', row['Phone Number 1']],
                  ['Phone 2 — Parent 1', row['Phone Number 2']],
                  ['Phone 3 — Parent 2', row['Phone Number 3']]
                ].map(([label, phone]) => phone ? (
                  <div key={String(label)} className="flex items-center justify-between gap-3 text-sm">
                    <div><span className="text-ink-700/50 text-xs block">{label}</span><span className="font-mono">{phone}</span></div>
                    <button onClick={(e) => { e.stopPropagation(); copyPhone(String(phone)); }} className="inline-flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink-900" title="Copy phone number">
                      {copiedPhone === phone ? <CheckCheck size={14} className="text-approve" /> : <Copy size={14} />} {copiedPhone === phone ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : null)}
              </div>
            ) : <p className="text-sm text-ink-700/30 italic">No phone numbers on file</p>}
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Other information</p>
            <div className="space-y-1.5 text-sm text-ink-700/80">
              <p>Last present: {row['Last Present Day'] || '—'}</p>
              <p>Days Since Last Present: {row['Days Since Last Present'] ?? row['Days Since Present'] ?? '—'}</p>
              <p>Entry date: {row['Entry Date'] ? new Date(row['Entry Date']).toLocaleDateString() : '—'}</p>
              {showsBillingColumns(user?.role) && <>
                <p>Total billed: ₹{Number(row['Total Billed'] || 0).toLocaleString('en-IN')}</p>
                <p>Total paid: ₹{Number(row['Total Paid'] || 0).toLocaleString('en-IN')}</p>
                <p className="text-reject">Arrear: ₹{Number(row.Arrear || 0).toLocaleString('en-IN')}</p>
              </>}
            </div>
          </div>
        </div>

        <div className="space-y-3 mb-5">
          <p className="text-xs uppercase tracking-wide text-ink-700/50">Reasons</p>
          {hasFullView ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {adminReasons.map((r) => (
                <ReasonBox
                  key={r.label}
                  label={r.label}
                  value={r.value}
                  updatedAt={r.updatedAt}
                  defaultOpen
                  imageSlot={
                    <ReasonBoxImageIcon
                      mid={row.MID}
                      sheet={sheet}
                      role={r.role}
                      uploaded={Boolean((row as unknown as Record<string, boolean>)[`${r.role} Screenshot Uploaded`])}
                      onView={zoom.open}
                    />
                  }
                />
              ))}
            </div>
          ) : canSeeOwnReason ? (
            <ReasonBox label={reasonColumnLabel(user?.role)} value={reasonText} defaultOpen />
          ) : (
            <p className="text-sm text-ink-700/50 italic">You've submitted your reason. It's no longer shown here — only Admin and Head Office can view it from this point.</p>
          )}
          {row['Last Rejection Reason'] && (
            <ReasonBox label={`Last rejection — ${row['Last Rejected By'] || 'Unknown'} (${row['Last Rejected Stage'] || '—'})`} value={row['Last Rejection Reason']} defaultOpen />
          )}
        </div>

        {wasRejected && !hasFullView && (scmCanAct || hofCanAct || managerCanAct) && (
          <p className="text-sm text-reject mb-4">This request was rejected. Please revise and resubmit your assigned correction.</p>
        )}
        {actionError && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2 mb-4">{actionError}</div>}

        <div className="flex flex-wrap gap-2 pt-4 border-t border-ink-100">
          {canFillOwnReason && (
            <button onClick={(e) => { e.stopPropagation(); onFillReason(user!.role as 'SCM' | 'HOF' | 'Manager'); }} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white">
              <Clock size={14} /> {reasonText ? 'Edit reason' : 'Add reason'}
            </button>
          )}
          {scmCanAct && (
            <button onClick={(e) => { e.stopPropagation(); onEditDetails(); }} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white">
              <Pencil size={14} /> Edit student details
            </button>
          )}
          {headOfficeCanDecide && <>
            <button disabled={headOfficeApproveMutation.isPending} onClick={(e) => { e.stopPropagation(); headOfficeApproveMutation.mutate(); }} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm disabled:opacity-60"><Check size={14} /> Approve</button>
            <button onClick={(e) => { e.stopPropagation(); onReject(); }} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14} /> Reject</button>
          </>}
          {adminCanDecide && <>
            <button disabled={approveMutation.isPending} onClick={(e) => { e.stopPropagation(); approveMutation.mutate(); }} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm disabled:opacity-60"><Check size={14} /> Approve</button>
            <button onClick={(e) => { e.stopPropagation(); onReject(); }} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14} /> Reject</button>
          </>}
          {(isAdmin || isHeadOffice) && (
            <button onClick={(e) => { e.stopPropagation(); onEditFull(); }} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-white"><Pencil size={14} /> Edit full record</button>
          )}
          {(isAdmin || isHeadOffice) && (
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="inline-flex items-center gap-1.5 rounded-md border border-reject/30 text-reject px-3 py-1.5 text-sm hover:bg-reject-light"><Trash2 size={14} /> Delete permanently</button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-ink-700/60 hover:text-ink-900">Close</button>
        </div>
      </td>
    </tr>
  );
}

function StudentRow({
  row, serial, isAdmin, isHeadOffice, sheet, onShowDetails, onFillReason, onReject, onEditFull, onDelete, onEditDetails
}: {
  row: StudentEntry; serial: number; isAdmin: boolean; isHeadOffice: boolean; sheet: 'response' | 'completed'; 
  onShowDetails: () => void; onFillReason: (role: 'SCM' | 'HOF' | 'Manager') => void; onReject: () => void; onEditFull: () => void; onDelete: () => void; onEditDetails: () => void;
}) {
  const { user } = useAuth();
  const { hasFullView, status, phones, reasonText, adminReasons, scmCanAct, hofCanAct, managerCanAct } = computeStudentRowState(row, isAdmin, isHeadOffice, sheet, user?.role);
  // SCM/HOF/Manager only see their own reason while they can still act on it
  // (not yet submitted, or sent back to them for correction). Once it's
  // submitted and out of their hands, it's hidden from them — only Admin
  // and Head Office retain full visibility.
  const canSeeOwnReason = scmCanAct || hofCanAct || managerCanAct;
  // Admin/Head Office now see records at every stage, not just the one
  // they can act on - this keeps "needs your decision" visually distinct
  // from "someone else's status" instead of hiding the latter entirely.
  const awaitingMyAction = (isAdmin || isHeadOffice) && !!row['Awaiting My Action'];
  return (
    <tr
      onClick={onShowDetails}
      className={`border-b border-ink-100 align-top cursor-pointer hover:bg-paper/60 ${
        awaitingMyAction ? 'bg-amber-light/40 border-l-2 border-l-amber' : ''
      }`}
    >
      <td className="px-4 py-3 text-ink-700/50">{serial}</td>
      {showsBillingColumns(user?.role) && <td className="px-4 py-3 font-mono text-xs">{row.MID}</td>}
      <td className="px-4 py-3 font-medium">{row['Student Name']}</td>
      {isHeadOffice && <td className="px-4 py-3 text-ink-700/70">{row.Branch || '—'}</td>}
      <td className="px-4 py-3 text-ink-700/70">{phones.length ? phones.map((p, i) => <div key={i} className="font-mono text-xs">{p}</div>) : <span className="text-ink-700/30 italic">—</span>}</td>
      <td className="px-4 py-3">
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLES[status]}`}>{statusDisplay(row)}</span>
        {awaitingMyAction && (
          <span className="ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber text-white align-middle">
            Needs your decision
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-ink-700/70 max-w-xs">
        {hasFullView
          ? <div className="truncate text-xs">{adminReasons.map((r) => r.value).find(Boolean) || 'Not yet provided'}</div>
          : <div className="truncate text-xs">{canSeeOwnReason ? (reasonText || 'Not yet provided') : <span className="text-ink-700/40 italic">Submitted</span>}</div>}
      </td>
      <td className="px-4 py-3 text-right text-ink-700/40">→</td>
    </tr>
  );
}

const REASON_MODAL_COPY: Record<
  'SCM' | 'HOF' | 'Manager',
  { title: string; placeholder: string; field: keyof StudentEntry }
> = {
  SCM: { title: 'Reason', placeholder: 'Reason for discontinuation…', field: 'Reason (SCM)' },
  HOF: { title: 'Confirmed reason', placeholder: 'Confirm the reason for discontinuation…', field: 'Confirmed Reason' },
  Manager: { title: 'Verified reason', placeholder: 'Verify the reason for discontinuation…', field: 'Verified Reason' }
};

function ReasonModal({
  row,
  role,
  onClose,
  onSaved
}: {
  row: StudentEntry;
  role: 'SCM' | 'HOF' | 'Manager';
  onClose: () => void;
  onSaved: () => void;
}) {
  const copy = REASON_MODAL_COPY[role];
  const rowAny = row as unknown as Record<string, string>;
  // HOF/Manager's own narrow view exposes 'Confirmed Reason'/'Verified Reason'
  // aliases (see Filters.gs); Admin's full view exposes the raw
  // 'Reason (HOF)'/'Reason (Manager)' columns instead. Check both so the
  // field pre-fills correctly regardless of which role is opening it.
  const existing =
    rowAny[copy.field] ||
    (role === 'HOF' ? rowAny['Reason (HOF)'] : role === 'Manager' ? rowAny['Reason (Manager)'] : '') ||
    '';
  const isEdit = Boolean(existing);
  const [reason, setReason] = useState(existing);
  const isMulti = role === 'SCM';
  const MAX_SCREENSHOTS = 6;
  // SCM: multi-image (screenshotFiles). HOF/Manager: single image only,
  // kept in screenshotFiles[0] for a shared submit path.
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [screenshotPreviews, setScreenshotPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    setError(null);
    if (!files.length) return;
    for (const file of files) {
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        setError('Please upload JPG or PNG images only.');
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setError('Each image must be under 8MB.');
        return;
      }
    }
    if (isMulti) {
      if (screenshotFiles.length + files.length > MAX_SCREENSHOTS) {
        setError(`You can attach up to ${MAX_SCREENSHOTS} images.`);
        return;
      }
      setScreenshotFiles((prev) => [...prev, ...files]);
      setScreenshotPreviews((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))]);
    } else {
      setScreenshotFiles([files[0]]);
      setScreenshotPreviews([URL.createObjectURL(files[0])]);
    }
  }

  function removeScreenshotAt(index: number) {
    setScreenshotFiles((prev) => prev.filter((_, i) => i !== index));
    setScreenshotPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const screenshots = await Promise.all(
        screenshotFiles.map(async (f) => ({ base64: await fileToBase64(f), mimeType: f.type }))
      );
      if (role === 'SCM') return submitScmReason(row.MID, reason, screenshots);
      if (role === 'HOF') return submitHofReason(row.MID, reason, screenshots[0]);
      return submitManagerReason(row.MID, reason, screenshots[0]);
    },
    onSuccess: onSaved,
    onError: (err) => setError(describeApiError(err, 'Could not save this reason. Please try again.'))
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <ModalShell onClose={onClose} wide>
      <h3 className="font-display text-xl mb-1">
        {isEdit ? `Edit ${copy.title.toLowerCase()}` : copy.title}
      </h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {row['Student Name']} &middot; {row.MID}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <textarea
          required
          autoFocus
          rows={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={copy.placeholder}
          className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[120px]"
        />

        <div>
          <label className="block text-sm text-ink-700/80 mb-1">
            {isMulti ? 'Call log screenshots (optional)' : 'Call log screenshot (optional)'}
          </label>
          <p className="text-xs text-ink-700/50 mb-2">
            {isMulti
              ? 'Upload proof you called the student to verify this reason, if you have any — you can attach more than one. Only Head Office and Admin can view them, and they\'re deleted automatically after final approval.'
              : "Upload proof you called the student to verify this reason, if you have one. Only Head Office and Admin can view it, and it's deleted automatically after final approval."}
          </p>
          <input
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            multiple={isMulti}
            onChange={handleFileChange}
            className="block w-full text-sm text-ink-700/80 file:mr-3 file:rounded-md file:border-0 file:bg-ink-900 file:text-paper file:px-3 file:py-2 file:text-sm"
          />
          {screenshotPreviews.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {screenshotPreviews.map((src, i) => (
                <div key={src} className="relative">
                  <img src={src} alt={`Attachment ${i + 1}`} className="h-20 w-20 object-cover rounded-md border border-ink-200" />
                  {isMulti && (
                    <button
                      type="button"
                      onClick={() => removeScreenshotAt(i)}
                      aria-label="Remove image"
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-ink-900 text-white text-xs leading-5 text-center hover:bg-reject"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * Item 2: a zoomable, scalable popup for viewing call-log
 * screenshot(s) in place - never a new tab/window. Mouse wheel and the
 * +/-/slider controls all adjust zoom manually; once zoomed in, the
 * image can be dragged around to pan. When more than one image is
 * passed in, arrow buttons at either end move between them without
 * closing the popup.
 */
function ImageZoomModal({ urls, initialIndex = 0, onClose }: { urls: string[]; initialIndex?: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function resetZoom() {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }

  function goTo(next: number) {
    setIndex((i) => {
      const n = (next + urls.length) % urls.length;
      return n;
    });
    resetZoom();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && urls.length > 1) goTo(index - 1);
      if (e.key === 'ArrowRight' && urls.length > 1) goTo(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, index, urls.length]);

  function clampScale(next: number) {
    return Math.min(6, Math.max(1, next));
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setScale((s) => {
      const next = clampScale(s - e.deltaY * 0.0018);
      if (next === 1) setPos({ x: 0, y: 0 });
      return next;
    });
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (scale <= 1) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    setDragging(true);
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!dragState.current) return;
    setPos({
      x: dragState.current.origX + (e.clientX - dragState.current.startX),
      y: dragState.current.origY + (e.clientY - dragState.current.startY)
    });
  }
  function stopDrag() {
    dragState.current = null;
    setDragging(false);
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/85 flex flex-col" onClick={onClose}>
      <div
        className="flex items-center justify-end gap-2 px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {urls.length > 1 && <span className="text-white/70 text-xs mr-2">{index + 1} / {urls.length}</span>}
        <button type="button" onClick={() => setScale((s) => clampScale(s - 0.25))} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">−</button>
        <input
          type="range"
          min={1}
          max={6}
          step={0.1}
          value={scale}
          onChange={(e) => setScale(clampScale(Number(e.target.value)))}
          className="w-32 accent-ink-900"
          aria-label="Zoom level"
        />
        <button type="button" onClick={() => setScale((s) => clampScale(s + 0.25))} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">+</button>
        <span className="text-white/70 text-xs w-10 text-center">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={resetZoom} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">Reset</button>
        <button type="button" onClick={onClose} className="rounded-md bg-white/90 hover:bg-white p-1.5" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div
        className="relative flex-1 overflow-hidden flex items-center justify-center select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
        onClick={(e) => e.stopPropagation()}
      >
        {urls.length > 1 && (
          <button
            type="button"
            onClick={() => goTo(index - 1)}
            aria-label="Previous image"
            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 hover:bg-white p-2 z-10"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <img
          src={urls[index]}
          alt="Call log screenshot"
          draggable={false}
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default'
          }}
          className="max-w-[95vw] max-h-[80vh] object-contain"
        />
        {urls.length > 1 && (
          <button
            type="button"
            onClick={() => goTo(index + 1)}
            aria-label="Next image"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 hover:bg-white p-2 z-10"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Small hook so any component can open the shared ImageZoomModal
 * without re-implementing the zoom/pan/carousel logic. Usage:
 *   const zoom = useImageZoom();
 *   zoom.open(urls); ... {zoom.node}
 */
function useImageZoom() {
  const [urls, setUrls] = useState<string[] | null>(null);
  return {
    open: (u: string[]) => setUrls(u),
    node: urls && urls.length ? <ImageZoomModal urls={urls} onClose={() => setUrls(null)} /> : null
  };
}

function ViewScreenshotButton({
  mid,
  sheet,
  role,
  uploaded,
  onView
}: {
  mid: string;
  sheet: 'response' | 'completed';
  role: 'SCM' | 'HOF' | 'Manager';
  uploaded: boolean;
  onView: (urls: string[]) => void;
}) {
  const [loading, setLoading] = useState(false);

  if (!uploaded) return <span className="text-xs text-ink-700/40 italic">No screenshot</span>;

  async function handleClick() {
    setLoading(true);
    try {
      const { urls } = await getReasonScreenshotUrl(mid, sheet, role);
      onView(urls);
    } catch {
      alert('Could not load the screenshot. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1 text-xs underline text-ink-900 hover:text-ink-700 disabled:opacity-50"
    >
      <ImageIcon size={12} /> {loading ? 'Loading…' : `View ${role} call log`}
    </button>
  );
}

/**
 * Requirement 2: a small image icon dropped directly on a ReasonBox's
 * header (next to SCM / HOF / Manager) so Admin/Head Office can open
 * that role's call-log screenshot(s) without leaving the reasons
 * section. Renders nothing if that role has no screenshot on file.
 */
function ReasonBoxImageIcon({
  mid,
  sheet,
  role,
  uploaded,
  onView
}: {
  mid: string;
  sheet: 'response' | 'completed';
  role: 'SCM' | 'HOF' | 'Manager';
  uploaded: boolean;
  onView: (urls: string[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  if (!uploaded) return null;

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    setLoading(true);
    try {
      const { urls } = await getReasonScreenshotUrl(mid, sheet, role);
      onView(urls);
    } catch {
      alert('Could not load the screenshot. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      title={`View ${role} call log screenshot(s)`}
      className="shrink-0 text-ink-700/50 hover:text-ink-900 disabled:opacity-50"
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
    </button>
  );
}

function RejectModal({
  row,
  actingRole,
  onClose,
  onSaved
}: {
  row: StudentEntry;
  /** Which stage's rejection this is - decides which backend action gets called. */
  actingRole: 'Head Office' | 'Admin';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rejectionReason, setRejectionReason] = useState('');
  const [rejectedRoles, setRejectedRoles] = useState<Array<'SCM' | 'HOF' | 'Manager'>>([]);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      actingRole === 'Head Office'
        ? headOfficeReject(row.MID, rejectionReason, rejectedRoles)
        : rejectStudentEntry(row.MID, rejectionReason),
    onSuccess: onSaved,
    onError: (err) => setError(describeApiError(err, 'Could not reject this entry. Please try again.'))
  });

  function toggleRole(role: 'SCM' | 'HOF' | 'Manager') {
    setRejectedRoles((cur) => (cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (actingRole === 'Head Office' && rejectedRoles.length === 0) {
      setError('Select at least one role that needs to correct their reason.');
      return;
    }
    mutation.mutate();
  }

  return (
    <ModalShell onClose={onClose} wide>
      <h3 className="font-display text-xl mb-1">Reject entry</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {actingRole === 'Head Office' ? (
          <>
            {row['Student Name']} &middot; {row.MID}. Pick exactly who provided the wrong reason — only
            they will be able to edit and resubmit; everyone else stays as-is. Once everyone you pick
            below has resubmitted, this comes straight back to you.
          </>
        ) : (
          <>
            {row['Student Name']} &middot; {row.MID}. This sends the entry all the way back to SCM, and
            HOF/Manager will need to submit their reasons again from scratch.
          </>
        )}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {actingRole === 'Head Office' && (
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Who needs to correct their reason?</p>
            <div className="flex gap-4">
              {CORRECTABLE_ROLES.map((r) => (
                <label key={r.value} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rejectedRoles.includes(r.value)}
                    onChange={() => toggleRole(r.value)}
                    className="rounded border-ink-200"
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>
        )}

        <textarea
          required
          autoFocus
          rows={5}
          value={rejectionReason}
          onChange={(e) => setRejectionReason(e.target.value)}
          placeholder="Why is this entry being rejected?"
          className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[120px]"
        />

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-reject text-white px-4 py-2 text-sm hover:bg-reject/90 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Rejecting…' : 'Reject entry'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * Admin-only: edit any field on a student entry directly, regardless
 * of workflow stage - pending, waiting on HOF/Manager, pending Admin,
 * REJECTED, or already APPROVED (in which case `sheet` is 'completed').
 */
function AdminEditModal({
  row,
  sheet,
  canEditReasons,
  onClose,
  onSaved
}: {
  row: StudentEntry;
  sheet: 'response' | 'completed';
  /** Head Office gets the 3 reason fields here too; Admin does not. */
  canEditReasons: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [studentName, setStudentName] = useState(row['Student Name'] || '');
  const [phone1, setPhone1] = useState(row['Phone Number 1'] || '');
  const [phone2, setPhone2] = useState(row['Phone Number 2'] || '');
  const [phone3, setPhone3] = useState(row['Phone Number 3'] || '');
  const [totalBilled, setTotalBilled] = useState(String(row['Total Billed'] ?? ''));
  const [totalPaid, setTotalPaid] = useState(String(row['Total Paid'] ?? ''));
  const [lastPresentDay, setLastPresentDay] = useState(row['Last Present Day'] || '');
  const [reasonScm, setReasonScm] = useState(row['Reason (SCM)'] || '');
  const [reasonHof, setReasonHof] = useState(row['Confirmed Reason'] || row['Reason (HOF)'] || '');
  const [reasonManager, setReasonManager] = useState(row['Verified Reason'] || row['Reason (Manager)'] || '');
  const [error, setError] = useState<string | null>(null);
  const zoom = useImageZoom();

  const mutation = useMutation({
    mutationFn: () =>
      adminUpdateStudent(row.MID, sheet, {
        'Student Name': studentName,
        'Phone Number 1': phone1,
        'Phone Number 2': phone2 || undefined,
        'Phone Number 3': phone3 || undefined,
        'Total Billed': totalBilled ? Number(totalBilled) : undefined,
        'Total Paid': totalPaid ? Number(totalPaid) : undefined,
        'Last Present Day': lastPresentDay || undefined,
        ...(canEditReasons
          ? {
              'Reason (SCM)': reasonScm,
              'Reason (HOF)': reasonHof,
              'Reason (Manager)': reasonManager
            }
          : {})
      }),
    onSuccess: onSaved,
    onError: (err) => setError(describeApiError(err, 'Could not save these changes. Please try again.'))
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <ModalShell onClose={onClose} wide>
      {zoom.node}
      <h3 className="font-display text-xl mb-1">Edit entry</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {row.MID} &middot; {row.Branch}. {canEditReasons
          ? 'As Head Office you can correct any field here, including all three reasons, at any stage of the workflow.'
          : 'You can correct any field here except the reasons, at any stage of the workflow — including after approval or rejection.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Student name">
          <input
            required
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
            className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Phone 1">
            <input
              value={phone1}
              onChange={(e) => setPhone1(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Phone 2">
            <input
              value={phone2}
              onChange={(e) => setPhone2(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Phone 3">
            <input
              value={phone3}
              onChange={(e) => setPhone3(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Total billed">
            <input
              type="number"
              value={totalBilled}
              onChange={(e) => setTotalBilled(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Total paid">
            <input
              type="number"
              value={totalPaid}
              onChange={(e) => setTotalPaid(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Last present day">
            <input
              type="date"
              value={lastPresentDay}
              onChange={(e) => setLastPresentDay(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
        </div>

        <Field label="Call log screenshots">
          <div className="flex flex-wrap gap-4 rounded-md border border-ink-200 px-3 py-2">
            <ViewScreenshotButton
              mid={row.MID}
              sheet={sheet}
              role="SCM"
              uploaded={Boolean((row as unknown as Record<string, boolean>)['SCM Screenshot Uploaded'])}
              onView={zoom.open}
            />
            <ViewScreenshotButton
              mid={row.MID}
              sheet={sheet}
              role="HOF"
              uploaded={Boolean((row as unknown as Record<string, boolean>)['HOF Screenshot Uploaded'])}
              onView={zoom.open}
            />
            <ViewScreenshotButton
              mid={row.MID}
              sheet={sheet}
              role="Manager"
              uploaded={Boolean((row as unknown as Record<string, boolean>)['Manager Screenshot Uploaded'])}
              onView={zoom.open}
            />
          </div>
        </Field>

        {canEditReasons && (
          <>
            <Field label="Reason (SCM)">
              <textarea
                rows={3}
                value={reasonScm}
                onChange={(e) => setReasonScm(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[80px]"
              />
            </Field>
            <Field label="Reason (HOF)">
              <textarea
                rows={3}
                value={reasonHof}
                onChange={(e) => setReasonHof(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[80px]"
              />
            </Field>
            <Field label="Reason (Manager)">
              <textarea
                rows={3}
                value={reasonManager}
                onChange={(e) => setReasonManager(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[80px]"
              />
            </Field>
          </>
        )}

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">{label}</label>
      {children}
    </div>
  );
}

function ScmEditDetailsModal({
  row,
  onClose,
  onSaved
}: {
  row: StudentEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mid, setMid] = useState(row.MID);
  const [studentName, setStudentName] = useState(row['Student Name'] || '');
  const [phone1, setPhone1] = useState(row['Phone Number 1'] || '');
  const [phone2, setPhone2] = useState(row['Phone Number 2'] || '');
  const [phone3, setPhone3] = useState(row['Phone Number 3'] || '');
  const [totalBilled, setTotalBilled] = useState(String(row['Total Billed'] ?? ''));
  const [totalPaid, setTotalPaid] = useState(String(row['Total Paid'] ?? ''));
  const [lastPresentDay, setLastPresentDay] = useState(row['Last Present Day'] || '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      scmUpdateStudentDetails(row.MID, {
        MID: mid,
        'Student Name': studentName,
        'Phone Number 1': phone1,
        'Phone Number 2': phone2 || undefined,
        'Phone Number 3': phone3 || undefined,
        'Total Billed': totalBilled ? Number(totalBilled) : undefined,
        'Total Paid': totalPaid ? Number(totalPaid) : undefined,
        'Last Present Day': lastPresentDay || undefined
      }),
    onSuccess: onSaved,
    onError: (err) =>
      setError(
        describeApiError(
          err,
          err instanceof ApiError && err.code === 'MID_ALREADY_EXISTS'
            ? 'That MID is already used by another entry.'
            : 'Could not save these changes. Please try again.'
        )
      )
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <ModalShell onClose={onClose} wide>
      <h3 className="font-display text-xl mb-1">Edit student details</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {row['Student Name']} &middot; {row.MID} &middot; {row.Branch}. This is only the
        student's own details — to change your reason, use the reason field instead. Locks once
        Head Office decides on this entry.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="MID">
            <input
              required
              value={mid}
              onChange={(e) => setMid(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Student name">
            <input
              required
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Phone 1">
            <input
              value={phone1}
              onChange={(e) => setPhone1(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Phone 2">
            <input
              value={phone2}
              onChange={(e) => setPhone2(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Phone 3">
            <input
              value={phone3}
              onChange={(e) => setPhone3(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Total billed">
            <input
              type="number"
              min="0"
              value={totalBilled}
              onChange={(e) => setTotalBilled(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Total paid">
            <input
              type="number"
              min="0"
              value={totalPaid}
              onChange={(e) => setTotalPaid(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
          <Field label="Last present day">
            <input
              type="date"
              value={lastPresentDay}
              onChange={(e) => setLastPresentDay(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </Field>
        </div>

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function DeleteConfirmModal({
  row,
  sheet,
  onClose,
  onDeleted
}: {
  row: StudentEntry;
  sheet: 'response' | 'completed';
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => deleteStudentEntry(row.MID, sheet, confirmText.trim()),
    onSuccess: onDeleted,
    onError: (err) => setError(describeApiError(err, 'Could not delete this entry. Please try again.'))
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  const canConfirm = confirmText.trim() === row.MID;

  return (
    <ModalShell onClose={onClose}>
      <h3 className="font-display text-xl mb-1 text-reject">Delete entry permanently</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {row['Student Name']} &middot; {row.MID} &middot; currently{' '}
        {STATUS_LABELS[row.Status] || row.Status}. This removes the entry completely — unlike
        Reject, it cannot be undone and does not notify SCM/HOF/Manager. Type the MID below to
        confirm.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          required
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={row.MID}
          className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-reject"
        />

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={!canConfirm || mutation.isPending}
            className="rounded-md bg-reject text-white px-4 py-2 text-sm hover:bg-reject/90 transition-colors disabled:opacity-40"
          >
            {mutation.isPending ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ModalShell({
  children,
  onClose,
  wide
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4 py-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full bg-white rounded-lg shadow-panel border border-ink-100 p-6 my-auto resize overflow-auto max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px]"
        style={{ width: wide ? 'min(42rem, 95vw)' : 'min(28rem, 95vw)' }}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-ink-700/40 hover:text-ink-700 transition-colors"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}