import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

/**
 * Placeholder landing page for Phase 4. This just proves the full
 * loop works: email/password sign-in -> backend verification ->
 * role/branch resolved and displayed. Phase 9 replaces this with
 * the real dashboard (cards + charts from Dashboard.gs).
 */
export default function Dashboard() {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-paper text-ink px-8 py-10">
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-panel border border-ink-100 p-8">
        <p className="font-mono text-xs tracking-widest text-ink-900/50 uppercase mb-2">
          Signed in
        </p>
        <h1 className="font-display text-2xl mb-6">Welcome, {user?.name}</h1>
        <dl className="grid grid-cols-2 gap-y-3 text-sm">
          <dt className="text-ink-700/60">Email</dt>
          <dd>{user?.email}</dd>
          <dt className="text-ink-700/60">Role</dt>
          <dd>{user?.role}</dd>
          <dt className="text-ink-700/60">Branch</dt>
          <dd>{user?.branch}</dd>
        </dl>
        <div className="mt-8 flex gap-3">
          <Link
            to="/change-password"
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
          >
            Change password
          </Link>
          <button
            onClick={() => signOut()}
            className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
