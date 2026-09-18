import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { listAuditLogs, listBranches } from '@/lib/apiClient';

const ACTIONS = ['LOGIN', 'LOGOUT', 'CREATE', 'UPDATE', 'DELETE'];

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const ACTION_STYLES: Record<string, string> = {
  LOGIN: 'bg-approve-light text-approve',
  LOGOUT: 'bg-ink-100 text-ink-700/70',
  CREATE: 'bg-approve-light text-approve',
  UPDATE: 'bg-amber-light text-amber',
  DELETE: 'bg-reject-light text-reject',
  PASSWORD_RESET_REQUESTED: 'bg-amber-light text-amber',
  PASSWORD_RESET: 'bg-amber-light text-amber'
};

export default function AuditLog() {
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

  // No branch passed -> backend returns every branch's logs for
  // Admin/Head Office (see auditlogs.list in Code.gs). Branch
  // filtering below happens client-side against that full set.
  const auditQuery = useQuery({ queryKey: ['auditlogs'], queryFn: () => listAuditLogs() });
  const branchesQuery = useQuery({ queryKey: ['branches'], queryFn: listBranches });

  const filteredRows = useMemo(() => {
    const rows = auditQuery.data || [];
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesTerm =
        !term ||
        r.userEmail.toLowerCase().includes(term) ||
        r.details.toLowerCase().includes(term);
      const matchesAction = !actionFilter || r.action === actionFilter;
      const matchesBranch = !branchFilter || r.branch === branchFilter;
      return matchesTerm && matchesAction && matchesBranch;
    });
  }, [auditQuery.data, search, actionFilter, branchFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl">Audit log</h2>
        <p className="text-sm text-ink-700/60 mt-1">
          Every login, create, update, and delete across every branch, most recent first.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by user or details"
            className="w-full rounded-md border border-ink-200 pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
        >
          <option value="">All branches</option>
          {(branchesQuery.data || []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-lg border border-ink-100 shadow-panel overflow-hidden overflow-x-auto">
        {auditQuery.isLoading && (
          <p className="text-sm text-ink-700/60 px-5 py-6">Loading audit log&hellip;</p>
        )}
        {auditQuery.isError && (
          <p className="text-sm text-reject px-5 py-6">Couldn&rsquo;t load the audit log. Please refresh.</p>
        )}

        {auditQuery.data && (
          <table className="w-full text-sm min-w-[800px]">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-700/50">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Details</th>
                <th className="px-4 py-3 font-medium">Branch</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => (
                <tr key={`${r.timestamp}-${i}`} className="border-b border-ink-100 last:border-0 hover:bg-paper/60">
                  <td className="px-4 py-3 text-ink-700/70 whitespace-nowrap">{formatTimestamp(r.timestamp)}</td>
                  <td className="px-4 py-3">{r.userEmail}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${
                        ACTION_STYLES[r.action] || 'bg-ink-100 text-ink-700/70'
                      }`}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-700/70">{r.details}</td>
                  <td className="px-4 py-3 text-ink-700/70">{r.branch || '—'}</td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-ink-700/50 text-sm">
                    No audit entries match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}