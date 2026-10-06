const AUTH_SESSION_KEY = 'sdms_session';
const OVERVIEW_FILTERS_KEY = 'sdms_overview_filters';

export interface OverviewFilters {
  branch: string;
  workflow: string;
  dateFrom: string;
  dateTo: string;
}

function storageForCurrentSession(): Storage {
  const sessionValue = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
  if (sessionValue) {
    try {
      const session = JSON.parse(sessionValue) as { rememberMe?: boolean };
      return session.rememberMe ? localStorage : sessionStorage;
    } catch {
      return sessionStorage;
    }
  }
  return sessionStorage;
}

export function readOverviewFilters(): OverviewFilters {
  const raw = storageForCurrentSession().getItem(OVERVIEW_FILTERS_KEY);
  if (!raw) return { branch: '', workflow: '', dateFrom: '', dateTo: '' };
  try {
    const filters = JSON.parse(raw) as Partial<OverviewFilters>;
    return {
      branch: typeof filters.branch === 'string' ? filters.branch : '',
      workflow: typeof filters.workflow === 'string' ? filters.workflow : '',
      dateFrom: typeof filters.dateFrom === 'string' ? filters.dateFrom : '',
      dateTo: typeof filters.dateTo === 'string' ? filters.dateTo : ''
    };
  } catch {
    return { branch: '', workflow: '', dateFrom: '', dateTo: '' };
  }
}

export function writeOverviewFilters(filters: OverviewFilters) {
  storageForCurrentSession().setItem(OVERVIEW_FILTERS_KEY, JSON.stringify(filters));
}

export function clearOverviewFilters() {
  localStorage.removeItem(OVERVIEW_FILTERS_KEY);
  sessionStorage.removeItem(OVERVIEW_FILTERS_KEY);
}
