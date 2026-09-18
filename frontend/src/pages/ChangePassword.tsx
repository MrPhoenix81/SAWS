import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { changePassword } from '@/lib/apiClient';
import { ApiError } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';

export default function ChangePassword() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }

    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_INVALID_CREDENTIALS') {
        setError('Your current password is incorrect.');
      } else if (err instanceof ApiError && err.code === 'PASSWORD_TOO_SHORT') {
        setError('New password must be at least 6 characters.');
      } else {
        setError('Could not change your password. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="max-w-md bg-white rounded-lg shadow-panel border border-ink-100 p-8">
        <p className="font-mono text-xs tracking-widest text-ink-900/50 uppercase mb-2">
          {user?.email}
        </p>
        <h1 className="font-display text-2xl mb-1">Change password</h1>
        <p className="text-sm text-ink-700/70 mb-6">
          Know your current password? Set a new one below. If you don&rsquo;t know your current
          password, ask your Admin to reset it for you instead.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="currentPassword" className="block text-sm text-ink-700/80 mb-1">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </div>

          <div>
            <label htmlFor="newPassword" className="block text-sm text-ink-700/80 mb-1">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm text-ink-700/80 mb-1">
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
            />
          </div>

          {error && (
            <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>
          )}
          {success && (
            <div className="rounded-md bg-approve-light text-approve text-sm px-3 py-2">
              Password changed successfully.
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Change password'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
            >
              Back
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
