import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  LabelList,
  Cell
} from 'recharts';
import {
  Download,
  SlidersHorizontal,
  X,
  ChevronDown,
  FileText,
  FileSpreadsheet,
  FileDown,
  Clock,
  UserCheck,
  CheckCircle2,
  XCircle,
  CalendarDays,
  CalendarRange,
  type LucideIcon
} from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { callApi, listBranches } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import type { DashboardData } from '@/types';

const CARD_DEFS: {
  key: keyof DashboardData['cards'];
  label: string;
  accent: string;
  tint: string;
  icon: LucideIcon;
}[] = [
  { key: 'pending', label: 'Pending', accent: 'text-amber', tint: 'bg-amber-light/50', icon: Clock },
  { key: 'awaitingAdminApproval', label: 'Awaiting Admin', accent: 'text-amber', tint: 'bg-amber-light/50', icon: UserCheck },
  { key: 'approved', label: 'Approved', accent: 'text-approve', tint: 'bg-approve-light/50', icon: CheckCircle2 },
  { key: 'rejected', label: 'Rejected', accent: 'text-reject', tint: 'bg-reject-light/50', icon: XCircle },
  { key: 'todaysEntries', label: "Today's Entries", accent: 'text-ink', tint: 'bg-ink-50', icon: CalendarDays },
  { key: 'monthlyEntries', label: 'This Month', accent: 'text-ink', tint: 'bg-ink-50', icon: CalendarRange }
];

// Shared blue scale for any chart shaded by rank: darkest = highest value,
// lightest = lowest. Capped at a mid-light blue (not the palest tint) so the
// smallest bar/segment stays legible against a white card.
const BLUE_SHADES = ['#0B3B66', '#0E4E85', '#1568A6', '#2685C4', '#3E93C9', '#6EB3E0', '#8FC3E5'];
function shadeForRank(index: number) {
  return BLUE_SHADES[Math.min(index, BLUE_SHADES.length - 1)];
}
// Pick a legible label color for the count printed inside/at the end of a
// bar - dark bars need white text, the lightest one or two need dark text.
function labelColorForRank(index: number) {
  return index >= BLUE_SHADES.length - 2 ? '#0E1230' : '#fff';
}

/**
 * Builds a one-page PDF summary of the dashboard (KPI cards, status
 * distribution, and - when viewing every branch - the branch comparison
 * table) and triggers a browser download.
 */
function downloadOverviewPdf(
  data: DashboardData,
  branchLabel: string,
  dateRangeLabel: string | null
) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.text('Student Discontinuation - Overview', 40, 44);
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Branch: ${branchLabel}`, 40, 62);
  doc.text(
    dateRangeLabel ? `Period: ${dateRangeLabel}` : `Generated ${new Date().toLocaleString()}`,
    40,
    76
  );

  autoTable(doc, {
    startY: 92,
    head: [['Metric', 'Value']],
    body: CARD_DEFS.map(({ key, label }) => [label, String(data.cards[key])]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [18, 22, 63], textColor: 255 },
    margin: { left: 40, right: 40 },
    theme: 'striped'
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nextY = (doc as any).lastAutoTable.finalY + 24;

  const statusRows = (['Discontinue', 'Inactive', 'Transfer'] as const).flatMap((wf) =>
    data.charts.statusDistribution[wf].map((s) => [`${wf}: ${s.status}`, String(s.count)])
  );
  if (statusRows.length > 0) {
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text('Status distribution', 40, nextY);
    autoTable(doc, {
      startY: nextY + 8,
      head: [['Status', 'Count']],
      body: statusRows,
      styles: { fontSize: 9, cellPadding: 6 },
      headStyles: { fillColor: [18, 22, 63], textColor: 255 },
      margin: { left: 40, right: 40 },
      theme: 'striped'
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nextY = (doc as any).lastAutoTable.finalY + 24;
  }

  if (data.charts.branchComparison.length > 0) {
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text('Entries by branch', 40, nextY);
    autoTable(doc, {
      startY: nextY + 8,
      head: [['Branch', 'Count']],
      body: data.charts.branchComparison.map((b) => [b.branch, String(b.total)]),
      styles: { fontSize: 9, cellPadding: 6 },
      headStyles: { fillColor: [18, 22, 63], textColor: 255 },
      margin: { left: 40, right: 40 },
      theme: 'striped'
    });
  }

  const safeBranch = branchLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  doc.save(`overview-${safeBranch}-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export default function Overview() {
  const { user } = useAuth();
  // Admin and Head Office see every branch by default and can narrow down
  // to one via the dropdown below. Every other role only ever sees their
  // own branch, so there's nothing for them to filter - just a download
  // button for their own branch's overview.
  const hasFullVisibility = user?.role === 'Admin' || user?.role === 'Head Office';

  const [branchFilter, setBranchFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  // The Filters panel edits these "draft" copies and only commits them to
  // the real filter state (which actually re-queries) when "Apply filters"
  // is clicked - same pattern as the Students page.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftBranch, setDraftBranch] = useState('');
  const [draftDateFrom, setDraftDateFrom] = useState('');
  const [draftDateTo, setDraftDateTo] = useState('');

  function openFilters() {
    setDraftBranch(branchFilter);
    setDraftDateFrom(dateFrom);
    setDraftDateTo(dateTo);
    setFiltersOpen(true);
  }

  function applyFilters() {
    setBranchFilter(draftBranch);
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setFiltersOpen(false);
  }

  function clearDraftFilters() {
    setDraftBranch('');
    setDraftDateFrom('');
    setDraftDateTo('');
  }

  function clearAllFilters() {
    setBranchFilter('');
    setDateFrom('');
    setDateTo('');
  }

  const activeFilterCount = [hasFullVisibility ? branchFilter : '', dateFrom, dateTo].filter(
    Boolean
  ).length;

  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: listBranches,
    enabled: hasFullVisibility
  });

  // Item 9: Admin dashboard "System / Important Links" now lives at
  // its own page (/admin/links, Admin-only) - see SystemLinks.tsx.

  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard', hasFullVisibility ? branchFilter : user?.branch, dateFrom, dateTo],
    queryFn: () =>
      callApi<DashboardData>('dashboard.get', {
        ...(hasFullVisibility && branchFilter ? { branch: branchFilter } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {})
      })
  });

  const branchLabel = hasFullVisibility ? branchFilter || 'All branches' : user?.branch || 'My branch';
  const dateRangeLabel =
    dateFrom || dateTo ? `${dateFrom || 'Start'} to ${dateTo || 'Today'}` : null;

  function handleDownload(format: 'csv' | 'xlsx' | 'pdf') {
    if (!data) return;
    setDownloading(true);
    setDownloadOpen(false);
    try {
      const base = `sdms_dashboard_${new Date().toISOString().slice(0, 10)}`;
      const rows = [
        ...CARD_DEFS.map(({ key, label }) => ({ Section: 'KPI', Item: label, Pending: '', Approved: '', Total: String(data.cards[key]) })),
        ...data.charts.workflowComparison.map((w) => ({ Section: 'Workflow', Item: w.workflow, Pending: String(w.pending), Approved: String(w.approved), Total: String(w.total) })),
        ...data.charts.branchComparison.map((b) => ({ Section: 'Branch', Item: b.branch, Pending: String(b.pending), Approved: String(b.approved), Total: String(b.total) }))
      ];
      if (format === 'csv') {
        const headers = Object.keys(rows[0]);
        const esc = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
        const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h as keyof typeof r])).join(','))].join('\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); a.download = `${base}.csv`; a.click();
      } else if (format === 'xlsx') {
        const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Dashboard'); XLSX.writeFile(wb, `${base}.xlsx`);
      } else {
        downloadOverviewPdf(data, branchLabel, dateRangeLabel);
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Welcome, {user?.name}</h2>
          <p className="text-sm text-ink-700/60 mt-1">
            {hasFullVisibility
              ? branchFilter
                ? `Overview for ${branchFilter}.`
                : 'Overview across every branch.'
              : `Overview for ${user?.branch}.`}
            {dateRangeLabel ? ` Filtered ${dateRangeLabel}.` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={openFilters}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            <SlidersHorizontal size={15} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-amber text-white text-xs font-medium">
                {activeFilterCount}
              </span>
            )}
          </button>

          {activeFilterCount > 0 && (
            <button
              onClick={clearAllFilters}
              className="flex items-center gap-1 text-sm text-ink-700/50 hover:text-ink-700 transition-colors px-1"
            >
              <X size={13} />
              Clear filters
            </button>
          )}

          <div className="relative">
            <button onClick={() => setDownloadOpen(v => !v)} disabled={!data || downloading} className="flex items-center gap-1.5 rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60">
              <Download size={15} />{downloading ? 'Preparing…' : 'Download'}<ChevronDown size={14} className={downloadOpen ? 'rotate-180' : ''} />
            </button>
            {downloadOpen && <div className="absolute right-0 mt-2 w-52 rounded-md border border-ink-100 bg-white shadow-panel py-1.5 z-30">
              <button onClick={() => handleDownload('csv')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-paper"><FileText size={15}/>CSV (.csv)</button>
              <button onClick={() => handleDownload('xlsx')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-paper"><FileSpreadsheet size={15}/>Excel (.xlsx)</button>
              <button onClick={() => handleDownload('pdf')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-paper"><FileDown size={15}/>PDF (.pdf)</button>
            </div>}
          </div>
        </div>
      </div>

      {/* Filters slide-over panel */}
      <div className={`fixed inset-0 z-40 ${filtersOpen ? '' : 'pointer-events-none'}`} aria-hidden={!filtersOpen}>
        <div
          onClick={() => setFiltersOpen(false)}
          className={`absolute inset-0 bg-ink-950/40 transition-opacity duration-200 ${
            filtersOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-white shadow-panel flex flex-col transition-transform duration-300 ${
            filtersOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          <div className="flex items-start justify-between px-5 py-4 border-b border-ink-100">
            <div>
              <h3 className="font-display text-lg">Filters</h3>
              <p className="text-xs text-ink-700/60 mt-0.5">
                Narrow the report by branch and date range.
              </p>
            </div>
            <button
              onClick={() => setFiltersOpen(false)}
              className="text-ink-700/50 hover:text-ink-900 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {hasFullVisibility && (
              <div>
                <label className="block text-xs font-medium text-ink-700/70 mb-1.5">Branch</label>
                <select
                  value={draftBranch}
                  onChange={(e) => setDraftBranch(e.target.value)}
                  className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
                >
                  <option value="">All branches</option>
                  {(branchesQuery.data || []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-ink-700/70 mb-1.5">Date range</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={draftDateFrom}
                  max={draftDateTo || undefined}
                  onChange={(e) => setDraftDateFrom(e.target.value)}
                  className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
                />
                <span className="text-xs text-ink-700/40 shrink-0">to</span>
                <input
                  type="date"
                  value={draftDateTo}
                  min={draftDateFrom || undefined}
                  onChange={(e) => setDraftDateTo(e.target.value)}
                  className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 px-5 py-4 border-t border-ink-100">
            <button
              onClick={clearDraftFilters}
              className="flex-1 rounded-md border border-ink-200 py-2.5 text-sm text-ink-700/80 hover:bg-paper transition-colors"
            >
              Clear all
            </button>
            <button
              onClick={applyFilters}
              className="flex-1 rounded-md bg-ink-900 text-paper py-2.5 text-sm hover:bg-ink-700 transition-colors"
            >
              Apply filters
            </button>
          </div>
        </div>
      </div>

      {isLoading && <p className="text-sm text-ink-700/60">Loading dashboard…</p>}
      {isError && (
        <p className="text-sm text-reject">Couldn&rsquo;t load dashboard data. Please refresh.</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {CARD_DEFS.map(({ key, label, accent, tint, icon: Icon }) => (
              <div
                key={key}
                className="bg-white rounded-lg border border-ink-100 shadow-panel px-4 py-4 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs text-ink-700/60">{label}</p>
                  <span className={`flex items-center justify-center h-7 w-7 rounded-md ${tint} ${accent}`}>
                    <Icon size={14} />
                  </span>
                </div>
                <p className={`font-display text-3xl ${accent}`}>{data.cards[key]}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {data.charts.workflowComparison.map((w) => (
              <div key={w.workflow} className="bg-white rounded-lg border border-ink-100 shadow-panel p-4">
                <p className="text-sm font-medium">{w.workflow}</p>
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  <div><p className="text-xs text-ink-700/50">Pending</p><p className="font-display text-xl text-amber">{w.pending}</p></div>
                  <div><p className="text-xs text-ink-700/50">Approved</p><p className="font-display text-xl text-approve">{w.approved}</p></div>
                  <div><p className="text-xs text-ink-700/50">Total</p><p className="font-display text-xl">{w.total}</p></div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-5 flex flex-col">
              <h3 className="text-sm font-medium mb-3 shrink-0">Monthly chart</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.charts.monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#12163F" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {(['Discontinue', 'Inactive', 'Transfer'] as const).map((workflow) => {
              const rows = data.charts.statusDistribution[workflow];
              return (
                <div key={workflow} className="bg-white rounded-lg border border-ink-100 shadow-panel p-5 flex flex-col">
                  <h3 className="text-sm font-medium mb-3 shrink-0">Status distribution — {workflow}</h3>
                  <div className="flex-1 min-h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={rows}
                        layout="vertical"
                        margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#eee" horizontal={false} />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                        <YAxis
                          type="category"
                          dataKey="status"
                          tick={{ fontSize: 10 }}
                          width={140}
                        />
                        <Tooltip />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={18}>
                          <LabelList
                            dataKey="count"
                            content={(props: {
                              x?: number | string; y?: number | string;
                              width?: number | string; height?: number | string;
                              value?: number | string; index?: number;
                            }) => {
                              const x = Number(props.x ?? 0);
                              const y = Number(props.y ?? 0);
                              const width = Number(props.width ?? 0);
                              const height = Number(props.height ?? 0);
                              const index = props.index ?? 0;
                              return (
                                <text
                                  x={x + width - 6}
                                  y={y + height / 2}
                                  dy={4}
                                  textAnchor="end"
                                  fontSize={11}
                                  fill={labelColorForRank(index)}
                                >
                                  {props.value}
                                </text>
                              );
                            }}
                          />
                          {rows.map((entry, index) => (
                            <Cell key={entry.status} fill={shadeForRank(index)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}

            <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-5 flex flex-col">
              <h3 className="text-sm font-medium mb-3 shrink-0">Daily entries (last 14 days)</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.charts.dailyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#1596C9" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-5 flex flex-col">
              <h3 className="text-sm font-medium mb-3 shrink-0">Approval trend (last 14 days)</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.charts.approvalTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#3F7D58" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {hasFullVisibility && !branchFilter && data.charts.branchComparison.length > 0 && (() => {
              // Sort highest -> lowest so the shade scale and the bar order agree.
              const sortedBranches = [...data.charts.branchComparison].sort((a, b) => b.total - a.total);
              return (
                <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-5 lg:col-span-2">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium">Entries by branch</h3>
                    <p className="text-xs text-ink-700/50">Click a bar or row to drill into that branch</p>
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={sortedBranches}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="branch" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={60} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar
                        dataKey="total"
                        radius={[4, 4, 0, 0]}
                        cursor="pointer"
                        onClick={(bar: { branch?: string }) => bar?.branch && setBranchFilter(bar.branch)}
                      >
                        {sortedBranches.map((entry, index) => (
                          <Cell key={entry.branch} fill={shadeForRank(index)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}

            {/* Once a branch is selected (via the table/chart above, or the
                Filters panel), show a way back to every branch without
                having to reopen Filters - keeps the drill-down a single
                click each way. */}
            {hasFullVisibility && branchFilter && (
              <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-4 lg:col-span-2 flex items-center justify-between">
                <p className="text-sm">
                  Viewing <span className="font-medium">{branchFilter}</span> only.
                </p>
                <button
                  onClick={() => setBranchFilter('')}
                  className="flex items-center gap-1 text-sm text-ink-700/60 hover:text-ink-900 transition-colors"
                >
                  <X size={13} />
                  Back to all branches
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}