import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '@/lib/apiClient';
import type { AppNotification } from '@/types';

/**
 * Polls notifications.list every 60s so pending-approval badges stay
 * roughly current without needing a websocket - Apps Script web apps
 * don't support push, so polling is the practical option here. Kept
 * slower than a true-realtime feel to leave headroom under the Sheets
 * API's per-minute read quota alongside AppLayout's own polling.
 */
const POLL_INTERVAL_MS = 90_000;

function timeAgo(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // IDs the user just dismissed but whose read-state hasn't been confirmed
  // by a fresh server fetch yet. The bell polls every 30s in the
  // background - if that poll lands mid-dismissal, it can overwrite the
  // optimistic removal with stale "still unread" data, making a just-read
  // notification flash back until the next poll catches up. Filtering
  // these out client-side, on top of the optimistic cache update, closes
  // that window instead of just narrowing it.
  const pendingDismissIds = useRef<Set<string>>(new Set());
  const [, forceRender] = useState(0);
  const allDismissedRef = useRef(false);

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: listNotifications,
    refetchInterval: POLL_INTERVAL_MS
  });

  const notifications = (notificationsQuery.data || []).filter(
    (n) => !n.read && !pendingDismissIds.current.has(n.id) && !allDismissedRef.current
  );
  const unreadCount = notifications.length;

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    // Optimistically drop the notification from the cached list so it
    // disappears immediately on click, instead of waiting for the
    // server round-trip (or the next 30s poll) to hide it.
    onMutate: async (id: string) => {
      pendingDismissIds.current.add(id);
      forceRender((v) => v + 1);
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData<AppNotification[]>(['notifications']);
      queryClient.setQueryData<AppNotification[]>(['notifications'], (old) =>
        (old || []).filter((n) => n.id !== id)
      );
      return { previous };
    },
    // Roll back if the server call fails, so we don't silently lose a
    // notification the user never actually dismissed.
    onError: (_err, id, context) => {
      pendingDismissIds.current.delete(id);
      if (context?.previous) {
        queryClient.setQueryData(['notifications'], context.previous);
      }
    },
    onSettled: async (_data, _err, id) => {
      // Wait for the confirmed refetch before releasing the guard, so a
      // background poll that was already in flight can't sneak stale data
      // back in during the gap.
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      pendingDismissIds.current.delete(id);
      forceRender((v) => v + 1);
    }
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      allDismissedRef.current = true;
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previous = queryClient.getQueryData<AppNotification[]>(['notifications']);
      queryClient.setQueryData<AppNotification[]>(['notifications'], []);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      allDismissedRef.current = false;
      if (context?.previous) {
        queryClient.setQueryData(['notifications'], context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      allDismissedRef.current = false;
      forceRender((v) => v + 1);
    }
  });

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-9 h-9 rounded-md border border-ink-100 hover:bg-paper transition-colors"
        title="Notifications"
      >
        <Bell size={16} className="text-ink-700/70" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-reject text-white text-[10px] px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 rounded-md border border-ink-100 bg-white shadow-panel py-1 z-20 max-h-[70vh] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-ink-100">
            <span className="text-sm font-medium">Notifications</span>
            {notifications.length > 0 && (
              <button
                disabled={markAllReadMutation.isPending}
                onClick={() => markAllReadMutation.mutate()}
                className="flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink transition-colors disabled:opacity-50"
              >
                <Check size={12} />
                Clear all
              </button>
            )}
          </div>

          {notificationsQuery.isLoading && (
            <p className="text-sm text-ink-700/60 px-3 py-6 text-center">Loading&hellip;</p>
          )}

          {!notificationsQuery.isLoading && notifications.length === 0 && (
            <p className="text-sm text-ink-700/50 px-3 py-6 text-center">You&rsquo;re all caught up.</p>
          )}

          {notifications.map((n) => (
            <div
              key={n.id}
              className="group relative w-full flex items-stretch border-b border-ink-100 last:border-0 hover:bg-paper transition-colors"
            >
              <button
                onClick={() => {
                  markReadMutation.mutate(n.id);
                  setOpen(false);
                  // Students page reads ?search= to pre-fill the search box,
                  // which matches on MID - the fastest way to land the user
                  // on the exact entry this notification is about.
                  if (n.relatedMid) navigate(`/students?search=${encodeURIComponent(n.relatedMid)}`);
                }}
                className="flex-1 min-w-0 text-left px-3 py-2.5"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber shrink-0" />
                  <div>
                    <p className="text-sm leading-snug">{n.message}</p>
                    <p className="text-xs text-ink-700/50 mt-0.5">{timeAgo(n.createdDate)}</p>
                  </div>
                </div>
              </button>

              <button
                onClick={(e) => {
                  // Dismiss only - stop the row's own click handler from
                  // also firing (which would navigate away).
                  e.stopPropagation();
                  markReadMutation.mutate(n.id);
                }}
                title="Remove notification"
                className="flex items-center justify-center w-8 shrink-0 text-ink-700/30 hover:text-ink-700/70 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}