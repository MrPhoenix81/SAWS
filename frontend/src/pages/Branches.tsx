import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, RotateCcw, X, Search } from 'lucide-react';
import { listAllBranches, createBranch, deleteBranch, reactivateBranch, ApiError } from '@/lib/apiClient';
import type { Branch } from '@/types';

export default function Branches() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState<Branch | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const branchesQuery = useQuery({ queryKey: ['branches', 'all'], queryFn: listAllBranches });

  // 'branches' (no 'all') is the plain active-name list every dropdown
  // across the app reads from (Students filters, User creation, etc).
  // Invalidating both keys here is what keeps every one of those
  // dropdowns in sync the moment a branch is added or removed.
  function invalidateBranchQueries() {
    queryClient.invalidateQueries({ queryKey: ['branches'] });
  }

  const filteredBranches = useMemo(() => {
    const rows = branchesQuery.data || [];
    const term = search.trim().toLowerCase();
    return rows
      .filter((b) => showInactive || b.active)
      .filter((b) => !term || b.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [branchesQuery.data, search, showInactive]);

  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteBranch(name),
    onSuccess: () => {
      invalidateBranchQueries();
      setDeletingBranch(null);
    }
  });

  const reactivateMutation = useMutation({
    mutationFn: (name: string) => reactivateBranch(name),
    onSuccess: () => invalidateBranchQueries()
  });

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <div className="shrink-0 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Manage branches</h2>
          <p className="text-sm text-ink-700/60 mt-1">
            Add or remove branches. Removing a branch hides it from every dropdown across the
            app &mdash; existing users and student records tied to it are left untouched.
          </p>
        </div>
        <button
          onClick={() => {
            setFormError(null);
            setAddOpen(true);
          }}
          className="flex items-center gap-1.5 rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
        >
          <Plus size={16} />
          New branch
        </button>
      </div>

      <div className="shrink-0 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search branches"
            className="w-full rounded-md border border-ink-200 pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
          />
          Show removed branches
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <div className="bg-white rounded-lg border border-ink-100 shadow-panel overflow-hidden">
        {branchesQuery.isLoading && (
          <p className="text-sm text-ink-700/60 px-5 py-6">Loading branches&hellip;</p>
        )}
        {branchesQuery.isError && (
          <p className="text-sm text-reject px-5 py-6">Couldn&rsquo;t load branches. Please refresh.</p>
        )}

        {branchesQuery.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-700/50">
                <th className="px-5 py-3 font-medium">Branch</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBranches.map((b) => (
                <tr key={b.name} className="border-b border-ink-100 last:border-0 hover:bg-paper/60">
                  <td className="px-5 py-3">{b.name}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${
                        b.active ? 'bg-approve-light text-approve' : 'bg-ink-100 text-ink-700/60'
                      }`}
                    >
                      {b.active ? 'Active' : 'Removed'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {b.active ? (
                        <button
                          title="Remove branch"
                          onClick={() => setDeletingBranch(b)}
                          className="p-1.5 rounded-md hover:bg-reject-light text-ink-700/70 hover:text-reject transition-colors"
                        >
                          <Trash2 size={15} />
                        </button>
                      ) : (
                        <button
                          title="Restore branch"
                          disabled={reactivateMutation.isPending}
                          onClick={() => reactivateMutation.mutate(b.name)}
                          className="p-1.5 rounded-md hover:bg-ink-100 text-ink-700/70 transition-colors disabled:opacity-30"
                        >
                          <RotateCcw size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredBranches.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-ink-700/50 text-sm">
                    No branches match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      </div>

      {addOpen && (
        <AddBranchModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            invalidateBranchQueries();
            setAddOpen(false);
          }}
        />
      )}

      {deletingBranch && (
        <ModalShell onClose={() => setDeletingBranch(null)}>
          <h3 className="font-display text-xl mb-2">Remove branch</h3>
          <p className="text-sm text-ink-700/70 mb-6">
            Remove <span className="font-medium text-ink">{deletingBranch.name}</span> from every
            branch dropdown across the app? Existing users and student records already tied to
            this branch are kept exactly as they are, and you can restore it any time.
          </p>
          {formError && (
            <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2 mb-4">{formError}</div>
          )}
          <div className="flex gap-3">
            <button
              disabled={deleteMutation.isPending}
              onClick={() => {
                setFormError(null);
                deleteMutation.mutate(deletingBranch.name, {
                  onError: () => setFormError('Could not remove this branch. Please try again.')
                });
              }}
              className="rounded-md px-4 py-2 text-sm transition-colors disabled:opacity-60 bg-reject text-white hover:bg-reject/90"
            >
              {deleteMutation.isPending ? 'Removing…' : 'Remove'}
            </button>
            <button
              onClick={() => setDeletingBranch(null)}
              className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
            >
              Cancel
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function AddBranchModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createBranch(name.trim()),
    onSuccess: (result) => {
      if (result.reactivated) {
        // Branch existed but was removed - createBranch_ on the backend
        // reactivates it instead of erroring, so just confirm and close.
      }
      onSaved();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'BAD_REQUEST') {
        setError('That branch already exists, or the name is missing.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    }
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <ModalShell onClose={onClose}>
      <h3 className="font-display text-xl mb-1">New branch</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        This becomes available in every branch dropdown across the app immediately.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ink-700/80 mb-1">Branch name</label>
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. KOTTAKKAL"
            className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={mutation.isPending || !name.trim()}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Saving…' : 'Add branch'}
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

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4 py-8 overflow-y-auto">
      <div
        className="relative w-full bg-white rounded-lg shadow-panel border border-ink-100 p-6 my-auto resize overflow-auto max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px]"
        style={{ width: 'min(28rem, 95vw)' }}
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