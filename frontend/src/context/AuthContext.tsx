import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { setToken, setTokenRefreshHandler, whoAmI, login as apiLogin, callApi, ApiError } from '@/lib/apiClient';
import type { AuthUser } from '@/types';

// 120 minutes, mirrors SESSION_TIMEOUT_MINUTES in config.py.
//
// This is a SLIDING session, not a flat one: every authenticated API
// call re-issues a fresh token (see api.py), and callApi/whoAmI in
// apiClient.ts hand that fresh token to onTokenRefreshed below, which
// resets "savedAt" and re-arms the timer. So a session only expires
// after SESSION_TIMEOUT_MS of genuine inactivity (no successful API
// calls at all) - not a fixed clock from login, which is what used to
// cause "random" logouts in the middle of active use.
const SESSION_TIMEOUT_MS = 120 * 60 * 1000;
const STORAGE_KEY = 'sdms_session';

interface StoredSession {
  token: string;
  savedAt: number;
  rememberMe: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string, rememberMe: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readStoredSession(): StoredSession | null {
  const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession) {
  const store = session.rememberMe ? localStorage : sessionStorage;
  store.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether the current session lives in localStorage (Remember
  // me) or sessionStorage, so a mid-session token refresh writes back
  // to the same place instead of guessing.
  const rememberMeRef = useRef(false);
  const signOutInternalRef = useRef<() => Promise<void>>(async () => {});

  const armSessionTimer = useCallback((savedAt: number) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const remaining = SESSION_TIMEOUT_MS - (Date.now() - savedAt);
    if (remaining <= 0) {
      signOutInternalRef.current();
      return;
    }
    timeoutRef.current = setTimeout(() => {
      signOutInternalRef.current();
    }, remaining);
  }, []);

  async function signOutInternal() {
    try {
      await callApi('auth.logout');
    } catch {
      // best-effort: still clear local state even if the network call fails
    }
    setToken(null);
    clearStoredSession();
    setUser(null);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }
  signOutInternalRef.current = signOutInternal;

  // Registered once: whenever any API call (or whoAmI on page load)
  // comes back with a freshly re-issued token, treat that as activity -
  // bump the stored session's timestamp, persist the new token, and
  // push the auto-logout deadline back out by the full timeout.
  useEffect(() => {
    setTokenRefreshHandler((newToken) => {
      const savedAt = Date.now();
      writeStoredSession({ token: newToken, savedAt, rememberMe: rememberMeRef.current });
      armSessionTimer(savedAt);
    });
    return () => setTokenRefreshHandler(null);
  }, [armSessionTimer]);

  // Restore a session on first load, without re-authenticating.
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored || Date.now() - stored.savedAt > SESSION_TIMEOUT_MS) {
      clearStoredSession();
      setLoading(false);
      return;
    }
    rememberMeRef.current = stored.rememberMe;
    setToken(stored.token);
    whoAmI(stored.token)
      .then((resolvedUser) => {
        setUser(resolvedUser as AuthUser);
        // whoAmI refreshes the token itself (see apiClient.ts), which
        // fires the handler above and re-arms the timer with a fresh
        // savedAt - so this is just a safety net in case that token
        // refresh didn't happen for any reason.
        armSessionTimer(Date.now());
      })
      .catch(() => {
        clearStoredSession();
        setToken(null);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser/OS timers are throttled or fully paused while a tab is
  // backgrounded or the device sleeps, so the setTimeout above can
  // fire late - or not until you switch back. Re-validate against the
  // real elapsed wall-clock time whenever the tab regains focus, so a
  // truly-expired session is caught immediately rather than silently
  // outstaying its welcome, and a still-valid one keeps working
  // without surprising you.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const stored = readStoredSession();
      if (!stored) return;
      if (Date.now() - stored.savedAt > SESSION_TIMEOUT_MS) {
        signOutInternalRef.current();
      } else {
        armSessionTimer(stored.savedAt);
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [armSessionTimer]);

  const signIn = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    setError(null);
    try {
      const browser = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const { token, user: resolvedUser } = await apiLogin(email, password, browser);
      rememberMeRef.current = rememberMe;
      setToken(token);
      setUser(resolvedUser);
      const savedAt = Date.now();
      writeStoredSession({ token, savedAt, rememberMe });
      armSessionTimer(savedAt);
    } catch (err) {
      setToken(null);
      if (err instanceof ApiError && err.code === 'AUTH_INVALID_CREDENTIALS') {
        setError('Incorrect email or password.');
      } else if (err instanceof ApiError && (err.code === 'AUTH_TIMEOUT' || err.code === 'AUTH_NETWORK_ERROR')) {
        // Distinct from a wrong password, so retrying with the same
        // (correct) credentials isn't mistaken for them being rejected.
        setError(err.message || 'Could not reach the server. Please try again.');
      } else {
        setError('Sign-in failed. Please try again.');
      }
      throw err;
    }
  }, [armSessionTimer]);

  const signOut = useCallback(async () => {
    await signOutInternal();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}