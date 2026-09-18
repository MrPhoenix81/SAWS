import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '@/lib/apiClient';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
    } finally {
      // Always show the same confirmation, whether or not the email
      // is registered - the backend deliberately doesn't reveal that.
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-paper text-ink px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-lg shadow-panel border border-ink-100 p-8">
          <h2 className="font-display text-xl mb-1">Forgot password</h2>

          {!submitted ? (
            <>
              <p className="text-sm text-ink-700/70 mb-6">
                Enter your account email and we&rsquo;ll send you a link to reset your password.
              </p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm text-ink-700/80 mb-1">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
                    placeholder="you@example.com"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-md bg-ink-900 text-paper text-sm font-medium py-2.5 disabled:opacity-60"
                >
                  {submitting ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          ) : (
            <div className="rounded-md bg-approve-light text-approve text-sm px-3 py-3 mt-2">
              If an account exists for that email, a reset link has been sent. It&rsquo;s valid
              for 30 minutes.
            </div>
          )}
        </div>

        <p className="text-xs text-ink-700/50 mt-6 text-center">
          <Link to="/login" className="underline hover:text-ink-900">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
