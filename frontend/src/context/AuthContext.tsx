import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { setToken, whoAmI, login as apiLogin, callApi, ApiError } from '@/lib/apiClient';
import type { AuthUser } from '@/types';

const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes, mirrors SESSION_TIMEOUT_MINUTES in Config.gs
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

  const armSessionTimer = useCallback((savedAt: number) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const remaining = SESSION_TIMEOUT_MS - (Date.now() - savedAt);
    if (remaining <= 0) {
      signOutInternal();
      return;
    }
    timeoutRef.current = setTimeout(() => {
      signOutInternal();
    }, remaining);
  }, []);

  // Restore a session on first load, without re-authenticating.
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored || Date.now() - stored.savedAt > SESSION_TIMEOUT_MS) {
      clearStoredSession();
      setLoading(false);
      return;
    }
    setToken(stored.token);
    whoAmI(stored.token)
      .then((resolvedUser) => {
        setUser(resolvedUser as AuthUser);
        armSessionTimer(stored.savedAt);
      })
      .catch(() => {
        clearStoredSession();
        setToken(null);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const signIn = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    setError(null);
    try {
      const browser = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const { token, user: resolvedUser } = await apiLogin(email, password, browser);
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