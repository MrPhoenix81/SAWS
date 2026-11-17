import React, { useRef, useState } from 'react';
import { Outlet, useNavigate, useLocation, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  KeyRound,
  LogOut,
  LayoutDashboard,
  Users as UsersIcon,
  PlusCircle,
  Ban,
  Clock,
  ArrowLeftRight,
  Building2,
  Database,
  Link2,
  ClipboardList,
  Moon,
  Sun,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import BulkTaskTray from '@/components/BulkTaskTray';
import { listInactive, listStudents, listTransfer } from '@/lib/apiClient';
import { DEFAULT_PAGE_SIZE } from '@/components/ListControls';

type NavItem = {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
};

type ActiveCounts = {
  discontinue: number;
  inactive: number;
  transfer: number;
};

type AwaitingActionRow = {
  'Awaiting My Action'?: boolean;
};

function countAwaitingAction(rows: AwaitingActionRow[] | undefined) {
  return rows?.filter((row) => row['Awaiting My Action']).length ?? 0;
}

type ThemeTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto min-w-[1.5rem] rounded-full bg-red-600 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white shadow-sm" aria-label={`${count} pending`}>
      {count}
    </span>
  );
}

function SidebarLink({ to, end, icon: Icon, label }: NavItem) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
          isActive
            ? 'bg-amber-light text-ink-900 font-medium'
            : 'text-ink-700/70 hover:bg-paper hover:text-ink'
        }`
      }
    >
      <Icon size={16} />
      {label}
    </NavLink>
  );
}

/** New Entry is the single place where SCM starts a new workflow request. */
function NewEntryNavItem() {
  const location = useLocation();
  return (
    <SidebarLink to="/new-entry" icon={PlusCircle} label="New Entry" />
  );
}

/**
 * "Students" sidebar entry. Its Active / Discontinued sub-links stay hidden
 * until the item is expanded - either by clicking it, or automatically
 * while already on the Students page so a deep link doesn't leave the
 * submenu collapsed.
 */
function StudentsNavItem({ count }: { count: number }) {
  const location = useLocation();
  const onStudents = location.pathname === '/students';
  const activeTab = new URLSearchParams(location.search).get('tab') === 'completed'
    ? 'completed'
    : 'active';

  const [open, setOpen] = useState(onStudents);

  React.useEffect(() => {
    if (onStudents) setOpen(true);
  }, [onStudents]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
          onStudents
            ? 'bg-amber-light text-ink-900 font-medium'
            : 'text-ink-700/70 hover:bg-paper hover:text-ink'
        }`}
      >
        <Ban size={16} />
        <span className="flex-1 text-left">Discontinue</span>
        <CountBadge count={count} />
        <ChevronDown
          size={14}
          className={`text-ink-700/40 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-1 ml-[1.15rem] space-y-0.5 border-l border-ink-100 pl-3.5">
          <NavLink
            to="/students?tab=active"
            className={`block rounded-md px-2.5 py-1 text-sm transition-colors ${
              onStudents && activeTab === 'active'
                ? 'text-ink-900 font-medium'
                : 'text-ink-700/60 hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <span>Active</span>
              <CountBadge count={count} />
            </span>
          </NavLink>
          <NavLink
            to="/students?tab=completed"
            className={`block rounded-md px-2.5 py-1 text-sm transition-colors ${
              onStudents && activeTab === 'completed'
                ? 'text-ink-900 font-medium'
                : 'text-ink-700/60 hover:text-ink'
            }`}
          >
            Approved
          </NavLink>
        </div>
      )}
    </div>
  );
}


/** Transfer navigation. Active / Approved are available from the sidebar only. */
function TransferNavItem({ count }: { count: number }) {
  const location = useLocation();
  const onTransfer = location.pathname === '/transfer';
  const activeTab = new URLSearchParams(location.search).get('tab') === 'completed' ? 'completed' : 'active';
  const [open, setOpen] = useState(onTransfer);
  React.useEffect(() => { if (onTransfer) setOpen(true); }, [onTransfer]);
  return (
    <div>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className={`w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${onTransfer ? 'bg-amber-light text-ink-900 font-medium' : 'text-ink-700/70 hover:bg-paper hover:text-ink'}`}>
        <ArrowLeftRight size={16} /><span className="flex-1 text-left">Transfer</span><CountBadge count={count} />
        <ChevronDown size={14} className={`text-ink-700/40 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-1 ml-[1.15rem] space-y-0.5 border-l border-ink-100 pl-3.5">
        <NavLink to="/transfer?tab=active" className={`block rounded-md px-2.5 py-1 text-sm ${onTransfer && activeTab === 'active' ? 'text-ink-900 font-medium' : 'text-ink-700/60 hover:text-ink'}`}><span className="flex items-center gap-2"><span>Active</span><CountBadge count={count} /></span></NavLink>
        <NavLink to="/transfer?tab=completed" className={`block rounded-md px-2.5 py-1 text-sm ${onTransfer && activeTab === 'completed' ? 'text-ink-900 font-medium' : 'text-ink-700/60 hover:text-ink'}`}>Approved</NavLink>
      </div>}
    </div>
  );
}

/** Temporary Phase 2 navigation for the Inactive workflow. */
function InactiveNavItem({ count }: { count: number }) {
  const location = useLocation();
  const onInactive = location.pathname === '/inactive';
  const activeTab = new URLSearchParams(location.search).get('tab') === 'completed'
    ? 'completed'
    : 'active';
  const [open, setOpen] = useState(onInactive);

  React.useEffect(() => {
    if (onInactive) setOpen(true);
  }, [onInactive]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
          onInactive
            ? 'bg-amber-light text-ink-900 font-medium'
            : 'text-ink-700/70 hover:bg-paper hover:text-ink'
        }`}
      >
        <Clock size={16} />
        <span className="flex-1 text-left">Inactive</span>
        <CountBadge count={count} />
        <ChevronDown
          size={14}
          className={`text-ink-700/40 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-1 ml-[1.15rem] space-y-0.5 border-l border-ink-100 pl-3.5">
          <NavLink
            to="/inactive?tab=active"
            className={`block rounded-md px-2.5 py-1 text-sm transition-colors ${
              onInactive && activeTab === 'active'
                ? 'text-ink-900 font-medium'
                : 'text-ink-700/60 hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <span>Active</span>
              <CountBadge count={count} />
            </span>
          </NavLink>
          <NavLink
            to="/inactive?tab=completed"
            className={`block rounded-md px-2.5 py-1 text-sm transition-colors ${
              onInactive && activeTab === 'completed'
                ? 'text-ink-900 font-medium'
                : 'text-ink-700/60 hover:text-ink'
            }`}
          >
            Approved
          </NavLink>
        </div>
      )}
    </div>
  );
}

export default function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const routerLocation = useLocation();
  // Discontinue / Inactive / Transfer pages keep the page itself fixed and
  // scroll only their table rows, so <main> must not scroll on these routes.
  // Overview and the admin pages do the same: their header stays put while
  // only the content below it scrolls.
  const fixedHeightPage = [
    '/',
    '/students',
    '/inactive',
    '/transfer',
    '/admin/users',
    '/admin/audit-log',
    '/admin/branches',
    '/admin/data'
  ].includes(routerLocation.pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  const themeTransitionRef = useRef<number | null>(null);
  const themeTransitionGenerationRef = useRef(0);

  const canManageUsers = user?.role === 'Admin' || user?.role === 'Head Office';
  const canManageBranches = user?.role === 'Admin' || user?.role === 'Head Office';
  const canAccessData = user?.role === 'Admin' || user?.role === 'Head Office';
  const canManageSystemLinks = user?.role === 'Admin';
  const hasAdminSection = canManageUsers || canManageBranches || canAccessData;

  // Sidebar badges count the row-level flags in these already-fetched pages.
  const pendingRowsParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE };
  const discontinueRowsQuery = useQuery({
    queryKey: ['students', 'response', pendingRowsParams],
    queryFn: () => listStudents('response', pendingRowsParams),
    enabled: !!user
  });
  const inactiveRowsQuery = useQuery({
    queryKey: ['inactive', 'active', pendingRowsParams],
    queryFn: () => listInactive('response', pendingRowsParams),
    enabled: !!user
  });
  const transferRowsQuery = useQuery({
    queryKey: ['transfer', 'active', pendingRowsParams],
    queryFn: () => listTransfer('response', pendingRowsParams),
    enabled: !!user
  });
  const activeCounts: ActiveCounts = {
    discontinue: countAwaitingAction(discontinueRowsQuery.data?.rows),
    inactive: countAwaitingAction(inactiveRowsQuery.data?.rows),
    transfer: countAwaitingAction(transferRowsQuery.data?.rows)
  };

  const pageTitle =
    user?.role === 'Admin'
      ? 'Student Approval Workflow System'
      : user?.role === 'Head Office'
      ? 'Student Approval Workflow System'
      : 'Student Approval Workflow System';

  function toggleTheme(event: React.MouseEvent<HTMLButtonElement>) {
    const nextIsDark = !isDarkTheme;
    const root = document.documentElement;
    const updateTheme = () => {
      root.classList.toggle('dark', nextIsDark);
      window.localStorage.setItem('saws-theme', nextIsDark ? 'dark' : 'light');
      setIsDarkTheme(nextIsDark);
    };
    const transitionDocument = document as ThemeTransitionDocument;

    if (
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      typeof transitionDocument.startViewTransition === 'function'
    ) {
      root.style.setProperty('--theme-transition-x', `${event.clientX}px`);
      root.style.setProperty('--theme-transition-y', `${event.clientY}px`);
      const generation = ++themeTransitionGenerationRef.current;
      const transition = transitionDocument.startViewTransition.call(document, updateTheme);
      const clearTransitionOrigin = () => {
        if (themeTransitionGenerationRef.current === generation) {
          root.style.removeProperty('--theme-transition-x');
          root.style.removeProperty('--theme-transition-y');
        }
      };
      void transition.finished.then(clearTransitionOrigin, clearTransitionOrigin);
      return;
    }

    root.classList.add('theme-transition');
    updateTheme();

    if (themeTransitionRef.current !== null) {
      window.clearTimeout(themeTransitionRef.current);
    }
    themeTransitionRef.current = window.setTimeout(() => {
      root.classList.remove('theme-transition');
      themeTransitionRef.current = null;
    }, 1500);
  }

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    // h-screen + overflow-hidden pins this container to exactly the viewport
    // height, so the sidebar and header never scroll away with the page -
    // only <main> below gets its own internal scrollbar.
    <div className="h-screen flex bg-paper text-ink overflow-hidden">
      {/* Sidebar - stays fixed in place while page content scrolls */}
      <aside className="w-64 shrink-0 bg-white border-r border-ink-100 flex flex-col h-full">
        <div className="h-12 flex items-center gap-3 px-4 border-b border-ink-100 shrink-0">
          {/* Company logo. This is a wide, white/light-blue wordmark, so it
              sits on a dark chip to stay visible against the white sidebar. */}
          <img
            src="/logo.svg"
            alt="Magnus"
            className="h-7 w-auto max-w-[100px] rounded-md bg-ink-900 object-contain px-2 py-1 shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <p className="font-display text-[20px] tracking-widest text-ink-700/50 uppercase leading-tight">
            SAWS
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          <div className="space-y-1">
            <p className="px-3 mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-700/40">
              General
            </p>
            <SidebarLink to="/" end icon={LayoutDashboard} label="Overview" />
            {user?.role === 'SCM' && <NewEntryNavItem />}
            <StudentsNavItem count={activeCounts.discontinue} />
            <InactiveNavItem count={activeCounts.inactive} />
            <TransferNavItem count={activeCounts.transfer} />
          </div>

          {hasAdminSection && (
            <div className="space-y-1">
              <p className="px-3 mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-700/40">
                Administration
              </p>
              {canManageUsers && (
                <SidebarLink to="/admin/users" icon={UsersIcon} label="Manage users" />
              )}
              {canManageUsers && (
                <SidebarLink to="/admin/audit-log" icon={ClipboardList} label="Audit log" />
              )}
              {canManageBranches && (
                <SidebarLink to="/admin/branches" icon={Building2} label="Manage branches" />
              )}
              {canAccessData && (
                <SidebarLink to="/admin/data" icon={Database} label="Data" />
              )}
              {canManageSystemLinks && (
                <SidebarLink to="/admin/links" icon={Link2} label="Important Links" />
              )}
            </div>
          )}
        </nav>
      </aside>

      {/* Right column: top bar + page content. h-full keeps this column
          pinned to the viewport height too, so only <main>'s own
          overflow-y-auto scrolls - the header above it stays put. */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <header className="relative z-50 h-12 shrink-0 border-b border-ink-100 bg-white flex items-center justify-between px-5">
          <h1 className="font-display text-base leading-tight">{pageTitle}</h1>

          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDarkTheme ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-pressed={isDarkTheme}
              title={isDarkTheme ? 'Switch to light theme' : 'Switch to dark theme'}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-ink-100 bg-white/70 text-ink-700/70 shadow-sm transition-transform duration-300 hover:scale-105 hover:bg-paper"
            >
              {isDarkTheme
                ? <Sun size={17} className="text-amber transition-transform duration-300" />
                : <Moon size={17} className="transition-transform duration-300" />}
            </button>
            <div className="relative z-50" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-md border border-ink-100 pl-3 pr-2 py-1.5 hover:bg-paper transition-colors"
              >
                <span className="text-right leading-tight">
                  <span className="block text-sm font-medium">{user?.name}</span>
                  <span className="block text-xs text-ink-700/60">
                    {user?.role} · {user?.branch}
                  </span>
                </span>
                <ChevronDown size={16} className="text-ink-700/50" />
              </button>

              {menuOpen && (
                <div className="account-menu-panel absolute right-0 mt-2 w-52 rounded-md border border-ink-100 bg-white shadow-panel py-1 z-50">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/change-password');
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
                  >
                    <KeyRound size={15} className="text-ink-700/60" />
                    Change password
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      signOut();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-paper transition-colors"
                  >
                    <LogOut size={15} className="text-ink-700/60" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main
          className={
            fixedHeightPage
              ? 'relative z-0 flex-1 min-h-0 flex flex-col overflow-hidden px-5 py-4'
              : 'relative z-0 flex-1 overflow-y-auto px-5 py-4'
          }
        >
          <div
            className={
              fixedHeightPage
                ? 'flex-1 min-h-0 w-full max-w-6xl mx-auto flex flex-col'
                : 'max-w-6xl mx-auto'
            }
          >
            <Outlet />
          </div>
        </main>
      </div>

      {/* Bulk Upload/Download/Delete progress - Admin only. Lives here (not
          on the Data page itself) so a job keeps tracking and finishes
          normally even after the user navigates elsewhere. */}
      {user?.role === 'Admin' && <BulkTaskTray />}
    </div>
  );
}