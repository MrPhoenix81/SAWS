import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { resetPassword, ApiError } from '@/lib/apiClient';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

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
      await resetPassword(token, newPassword);
      setSuccess(true);
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_INVALID_RESET_TOKEN') {
        setError('This reset link is invalid or has expired. Request a new one.');
      } else if (err instanceof ApiError && err.code === 'PASSWORD_TOO_SHORT') {
        setError('New password must be at least 6 characters.');
      } else {
        setError('Could not reset your password. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-paper text-ink px-6 py-12">
        <div className="w-full max-w-sm bg-white rounded-lg shadow-panel border border-ink-100 p-8 text-center">
          <p className="text-sm text-reject">
            This link is missing its reset token. Please use the link from your email, or request
            a new one.
          </p>
          <Link to="/forgot-password" className="text-sm underline mt-4 inline-block">
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-paper text-ink px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-lg shadow-panel border border-ink-100 p-8">
          <h2 className="font-display text-xl mb-1">Set a new password</h2>

          {success ? (
            <div className="rounded-md bg-approve-light text-approve text-sm px-3 py-3 mt-4">
              Password updated. Redirecting you to sign in&hellip;
            </div>
          ) : (
            <>
              <p className="text-sm text-ink-700/70 mb-6">Choose a new password below.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
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
                  <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-md bg-ink-900 text-paper text-sm font-medium py-2.5 disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Reset password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
