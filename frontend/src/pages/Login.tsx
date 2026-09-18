import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const { signIn, error } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    try {
      await signIn(email.trim(), password, rememberMe);
      navigate('/', { replace: true });
    } catch {
      // error is already surfaced via useAuth().error
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex bg-paper text-ink">
      {/* Brand rail */}
      <aside className="hidden lg:flex flex-col justify-between w-72 bg-ink-900 text-paper px-8 py-10">
        <div>
          <p className="font-mono text-xs tracking-widest text-ink-200 uppercase">Magnus</p>
          <h1 className="font-display text-2xl mt-2 leading-snug">
            Student Approval Workflow System
          </h1>
        </div>
        <p className="font-mono text-xs text-ink-200/70 leading-relaxed">
          A single system of approval across every branch.
        </p>
      </aside>

      {/* Sign-in panel */}
      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8">
            <p className="font-mono text-xs tracking-widest text-ink-900/60 uppercase">Magnus</p>
            <h1 className="font-display text-2xl mt-1">Student Approval Workflow System</h1>
          </div>

          <div className="bg-white rounded-lg shadow-panel border border-ink-100 p-8">
            <h2 className="font-display text-xl mb-1">Sign in</h2>
            <p className="text-sm text-ink-700/70 mb-6">
              Use the email and password your Admin gave you.
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

              <div>
                <label htmlFor="password" className="block text-sm text-ink-700/80 mb-1">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
                  placeholder="********"
                />
              </div>

              {error && (
                <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">
                  {error}
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
                />
                Keep me signed in on this device
              </label>

              <button
                type="submit"
                disabled={signingIn}
                className="w-full rounded-md bg-ink-900 text-paper text-sm font-medium py-2.5 disabled:opacity-60"
              >
                {signingIn ? 'Signing you in…' : 'Sign in'}
              </button>
            </form>
          </div>

          <p className="text-xs text-ink-700/50 mt-6 text-center">
            Not sure of your login? Your Admin can look up or reset it under User Management.
          </p>
        </div>
      </main>
    </div>
  );
}