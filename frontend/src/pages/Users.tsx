import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, KeyRound, X, Copy, Check, Search } from 'lucide-react';
import {
  listUsers,
  listBranches,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  ApiError
} from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import type { ManagedUser, Role } from '@/types';

const ROLES: Role[] = ['Admin', 'Head Office', 'SCM', 'HOF', 'Manager'];

/** Shown once, right after a password is generated or regenerated. */
interface RevealedPassword {
  email: string;
  password: string;
}

export default function Users() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL');
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<ManagedUser | null>(null);
  const [revealed, setRevealed] = useState<RevealedPassword | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const branchesQuery = useQuery({ queryKey: ['branches'], queryFn: listBranches });

  const filteredUsers = useMemo(() => {
    const rows = usersQuery.data || [];
    const term = search.trim().toLowerCase();
    return rows.filter((u) => {
      const matchesTerm =
        !term || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term);
      const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;
      return matchesTerm && matchesRole;
    });
  }, [usersQuery.data, search, roleFilter]);

  const resetPasswordMutation = useMutation({
    mutationFn: (email: string) => resetUserPassword(email),
    onSuccess: (result, email) => {
      setResetError(null);
      setRevealed({ email, password: result.generatedPassword });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setResetError(
          err.code === 'AUTH_FORBIDDEN'
            ? "You don't have permission to reset this user's password. (" + err.code + ')'
            : 'Could not reset password: ' + err.code
        );
      } else {
        setResetError('Could not reset password. Please try again.');
      }
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => deleteUser(email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setDeletingUser(null);
    }
  });

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <div className="shrink-0 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Manage users</h2>
          <p className="text-sm text-ink-700/60 mt-1">
            Create accounts and assign roles &amp; branches. Passwords are generated automatically
            &mdash; there&rsquo;s nothing for a user to pick.
          </p>
        </div>
        <button
          onClick={() => {
            setEditingUser(null);
            setFormOpen(true);
          }}
          className="flex items-center gap-1.5 rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
        >
          <Plus size={16} />
          New user
        </button>
      </div>

      <div className="shrink-0 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            className="w-full rounded-md border border-ink-200 pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | 'ALL')}
          className="rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
        >
          <option value="ALL">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      {resetError && (
        <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">
          {resetError}
        </div>
      )}

      <div className="bg-white rounded-lg border border-ink-100 shadow-panel overflow-hidden">
        {usersQuery.isLoading && (
          <p className="text-sm text-ink-700/60 px-5 py-6">Loading users&hellip;</p>
        )}
        {usersQuery.isError && (
          <p className="text-sm text-reject px-5 py-6">Couldn&rsquo;t load users. Please refresh.</p>
        )}

        {usersQuery.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-700/50">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Branch</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const isSelf = me?.email.toLowerCase() === u.email.toLowerCase();
                const headOfficeBlockedFromAdmin = me?.role === 'Head Office' && u.role === 'Admin';
                const canDelete =
                  me?.role === 'Admin' ||
                  (me?.role === 'Head Office' && u.role !== 'Admin' && u.role !== 'Head Office');
                return (
                  <tr key={u.email} className="border-b border-ink-100 last:border-0 hover:bg-paper/60">
                    <td className="px-5 py-3">{u.name}</td>
                    <td className="px-5 py-3 text-ink-700/70">{u.email}</td>
                    <td className="px-5 py-3">
                      <span className="inline-block rounded-full bg-ink-100 px-2.5 py-0.5 text-xs">
                        {u.role}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-700/70">{u.branch}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          title="Edit"
                          onClick={() => {
                            setEditingUser(u);
                            setFormOpen(true);
                          }}
                          className="p-1.5 rounded-md hover:bg-ink-100 text-ink-700/70 transition-colors"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          title={
                            headOfficeBlockedFromAdmin
                              ? "Head Office can't reset an Admin's password"
                              : 'Reset password'
                          }
                          disabled={resetPasswordMutation.isPending || headOfficeBlockedFromAdmin}
                          onClick={() => resetPasswordMutation.mutate(u.email)}
                          className="p-1.5 rounded-md hover:bg-ink-100 text-ink-700/70 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <KeyRound size={15} />
                        </button>
                        <button
                          title={
                            !canDelete
                              ? "You don't have permission to delete this user"
                              : isSelf
                              ? "You can't delete your own account"
                              : 'Delete'
                          }
                          disabled={!canDelete || isSelf}
                          onClick={() => setDeletingUser(u)}
                          className="p-1.5 rounded-md hover:bg-reject-light text-ink-700/70 hover:text-reject transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-700/70"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-ink-700/50 text-sm">
                    No users match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      </div>

      {formOpen && (
        <UserFormModal
          editingUser={editingUser}
          creatorRole={me?.role}
          branches={branchesQuery.data || []}
          onClose={() => setFormOpen(false)}
          onSaved={(generatedPassword, email) => {
            queryClient.invalidateQueries({ queryKey: ['users'] });
            setFormOpen(false);
            if (generatedPassword) setRevealed({ email, password: generatedPassword });
          }}
        />
      )}

      {deletingUser && (
        <ConfirmModal
          title="Delete user"
          message={`Remove ${deletingUser.name} (${deletingUser.email})? They will lose access immediately. This can't be undone.`}
          confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          destructive
          disabled={deleteMutation.isPending}
          onCancel={() => setDeletingUser(null)}
          onConfirm={() => deleteMutation.mutate(deletingUser.email)}
        />
      )}

      {revealed && (
        <PasswordRevealModal revealed={revealed} onClose={() => setRevealed(null)} />
      )}
    </div>
  );
}

function UserFormModal({
  editingUser,
  creatorRole,
  branches,
  onClose,
  onSaved
}: {
  editingUser: ManagedUser | null;
  creatorRole: Role | undefined;
  branches: string[];
  onClose: () => void;
  onSaved: (generatedPassword: string | undefined, email: string) => void;
}) {
  const isEdit = !!editingUser;
  const [email, setEmail] = useState(editingUser?.email || '');
  const [name, setName] = useState(editingUser?.name || '');
  const [role, setRole] = useState<Role>(editingUser?.role || 'SCM');
  const assignableRoles: Role[] =
    creatorRole === 'Admin'
      ? ['Admin', 'Head Office', 'SCM', 'HOF', 'Manager']
      : ['SCM', 'HOF', 'Manager'];
  const [branch, setBranch] = useState(editingUser?.branch || branches[0] || '');
  const [password, setPassword] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        return updateUser({
          email,
          name: name !== editingUser!.name ? name : undefined,
          role: role !== editingUser!.role ? role : undefined,
          branch: role !== 'Admin' && branch !== editingUser!.branch ? branch : undefined
        });
      }
      // Checkbox ticked -> backend generates a Magnus-scheme password
      // and ignores whatever's in the password box. Unticked -> the
      // typed password is required (enforced both here and server-side).
      return createUser({
        email,
        name,
        role,
        branch,
        autoGenerate,
        password: autoGenerate ? undefined : password.trim()
      });
    },
    onSuccess: (result) => {
      onSaved('generatedPassword' in result ? result.generatedPassword : undefined, email);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'BAD_REQUEST') {
        setError(
          isEdit
            ? 'Could not update this user. Check the details and try again.'
            : 'That email is already registered, or a required field is missing.'
        );
      } else if (err instanceof ApiError && err.code === 'PASSWORD_TOO_SHORT') {
        setError('Password must be at least 6 characters.');
      } else if (err instanceof ApiError && err.code === 'PASSWORD_REQUIRED') {
        setError('Please set a password, or tick "Auto-generate password".');
      } else {
        setError('Something went wrong. Please try again.');
      }
    }
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !autoGenerate && password.trim().length < 6) {
      setError('Password must be at least 6 characters, or tick "Auto-generate password".');
      return;
    }
    mutation.mutate();
  }

  const Required = () => <span className="text-red-600">&nbsp;*</span>;

  return (
    <ModalShell onClose={onClose}>
      <h3 className="font-display text-xl mb-1">{isEdit ? 'Edit user' : 'New user'}</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        {isEdit
          ? 'Changing role or branch will regenerate this user\u2019s password.'
          : 'Tick "Auto-generate password" for a unique system-generated password, or set your own below.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ink-700/80 mb-1">Full name<Required /></label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
          />
        </div>

        <div>
          <label className="block text-sm text-ink-700/80 mb-1">Email<Required /></label>
          <input
            required
            type="email"
            disabled={isEdit}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 disabled:bg-paper disabled:text-ink-700/50"
          />
        </div>

        {!isEdit && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
              <input
                type="checkbox"
                checked={autoGenerate}
                onChange={(e) => setAutoGenerate(e.target.checked)}
                className="rounded border-ink-300 focus:ring-ink-900"
              />
              Auto-generate password
            </label>
            {autoGenerate ? (
              <p className="text-xs text-ink-700/50">
                A unique password will be generated: first name + M + the 2-digit year + 4 random letters/numbers (case-sensitive), e.g. <span className="font-mono">JohnM26aB3x</span>.
              </p>
            ) : (
              <div>
                <label className="block text-sm text-ink-700/80 mb-1">Password<Required /></label>
                <input
                  required
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ink-900"
                />
                <p className="text-xs text-ink-700/50 mt-1">At least 6 characters. Case-sensitive.</p>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm text-ink-700/80 mb-1">Role<Required /></label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
          >
            {assignableRoles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {role !== 'Admin' && role !== 'Head Office' && (
          <div>
            <label className="block text-sm text-ink-700/80 mb-1">Branch<Required /></label>
            <select
              required
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
            >
              <option value="" disabled>
                Select a branch
              </option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        )}
        {(role === 'Admin' || role === 'Head Office') && (
          <p className="text-xs text-ink-700/50">
            Admin and Head Office users can see every branch, so no branch needs to be selected.
          </p>
        )}

        {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
          >
            {mutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
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

function PasswordRevealModal({
  revealed,
  onClose
}: {
  revealed: RevealedPassword;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(revealed.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable - user can still select the text manually
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <h3 className="font-display text-xl mb-1">Password generated</h3>
      <p className="text-sm text-ink-700/60 mb-5">
        Share this with <span className="font-medium text-ink">{revealed.email}</span> now &mdash;
        it won&rsquo;t be shown again. They can change it any time from Change Password.
      </p>

      <div className="flex items-center justify-between rounded-md border border-ink-200 bg-paper px-4 py-3">
        <code className="font-mono text-base tracking-wide">{revealed.password}</code>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-ink-700/70 hover:text-ink transition-colors"
        >
          {copied ? <Check size={14} className="text-approve" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="pt-5">
        <button
          onClick={onClose}
          className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  destructive,
  disabled,
  onCancel,
  onConfirm
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell onClose={onCancel}>
      <h3 className="font-display text-xl mb-2">{title}</h3>
      <p className="text-sm text-ink-700/70 mb-6">{message}</p>
      <div className="flex gap-3">
        <button
          disabled={disabled}
          onClick={onConfirm}
          className={`rounded-md px-4 py-2 text-sm transition-colors disabled:opacity-60 ${
            destructive
              ? 'bg-reject text-white hover:bg-reject/90'
              : 'bg-ink-900 text-paper hover:bg-ink-700'
          }`}
        >
          {confirmLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
        >
          Cancel
        </button>
      </div>
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