import { useQuery } from '@tanstack/react-query';
import { Activity, Cloud, Database, ExternalLink, Image as ImageIcon, Sheet, type LucideIcon } from 'lucide-react';
import { getSystemLinks } from '@/lib/apiClient';

const SYSTEM_LINK_ICONS: Record<string, LucideIcon> = {
  database: Database,
  imageStorage: ImageIcon,
  backupSheet: Sheet,
  hosting: Cloud,
  uptimeMonitor: Activity
};

export default function SystemLinks() {
  const systemLinksQuery = useQuery({
    queryKey: ['admin-system-links'],
    queryFn: getSystemLinks
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl">System links</h2>
        <p className="text-sm text-ink-700/60 mt-1">Quick access to important system services.</p>
      </div>

      {systemLinksQuery.isLoading && (
        <p className="text-sm text-ink-700/60">Loading system links...</p>
      )}
      {systemLinksQuery.isError && (
        <p className="text-sm text-reject">Could not load system links. Please refresh.</p>
      )}
      {systemLinksQuery.data?.links?.length === 0 && (
        <p className="text-sm text-ink-700/60">No system links have been configured.</p>
      )}
      {(systemLinksQuery.data?.links?.length ?? 0) > 0 && (
        <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {systemLinksQuery.data!.links.map((link) => {
              const Icon = SYSTEM_LINK_ICONS[link.key] || ExternalLink;
              return (
                <a
                  key={link.key}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-start gap-2 rounded-lg border border-ink-100 p-3 text-sm hover:border-ink-300 hover:bg-ink-50/40 transition-colors"
                >
                  <Icon size={18} className="text-ink-700/60" />
                  <span className="flex items-center gap-1 font-medium leading-tight">
                    {link.label}
                    <ExternalLink size={12} className="text-ink-700/40" />
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
