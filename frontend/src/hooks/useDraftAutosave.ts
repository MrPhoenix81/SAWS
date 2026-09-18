import { useEffect, useRef, useState } from 'react';

/**
 * Draft autosave for long-lived, unsubmitted forms (SCM's Discontinue /
 * Inactive / Transfer entry forms).
 *
 * Why localStorage instead of "wait for the server": SCM sometimes types
 * a request, gets pulled away, and comes back to a minimized or backgrounded
 * tab an hour later. Nothing about that should lose their typing - and it
 * shouldn't require a server round-trip (still Admin/HO-approval-free) to
 * protect against it either. localStorage writes happen synchronously and
 * survive the tab being minimized, the browser being closed, or a crash -
 * unlike in-memory React state, which is gone the moment the tab unloads.
 *
 * This does NOT save attached screenshots (File objects can't be
 * reasonably stored this way at scale) - only the text/number/date fields.
 * The caller re-attaches images after a draft restore.
 */

interface DraftEnvelope<T> {
  value: T;
  savedAt: number;
}

interface UseDraftAutosaveOptions<T> {
  /** Storage key, already scoped to the user and form (e.g. `saws-draft-scm@x.com-discontinue`). */
  key: string;
  value: T;
  /** Skip writing when false - e.g. while the form is still completely empty. */
  enabled?: boolean;
  /** Debounce between keystrokes and the actual write. Default 800ms. */
  debounceMs?: number;
}

export function useDraftAutosave<T>({ key, value, enabled = true, debounceMs = 800 }: UseDraftAutosaveOptions<T>) {
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  function flush() {
    if (!enabled) return;
    try {
      const envelope: DraftEnvelope<T> = { value: valueRef.current, savedAt: Date.now() };
      localStorage.setItem(key, JSON.stringify(envelope));
      setLastSavedAt(envelope.savedAt);
    } catch {
      // Storage full/unavailable (private browsing, quota, etc.) - the
      // draft just won't persist; not worth surfacing as a hard error.
    }
  }

  // Debounced save on every change.
  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, JSON.stringify(value), enabled, debounceMs]);

  // Force an immediate (non-debounced) save the moment the tab is hidden,
  // minimized, or about to unload, and as a periodic fallback every 20s
  // while the form has content - this is the part that protects a request
  // the SCM leaves half-typed for a long stretch.
  useEffect(() => {
    if (!enabled) return;
    function handleVisibility() {
      if (document.visibilityState === 'hidden') flush();
    }
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', handleVisibility);
    const fallback = setInterval(flush, 20_000);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { lastSavedAt };
}

export function loadDraft<T>(key: string): DraftEnvelope<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('value' in parsed) || !('savedAt' in parsed)) return null;
    return parsed as DraftEnvelope<T>;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}