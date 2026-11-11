import React, { useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, searchRecordsByMid, type GlobalMidSearchResult } from '@/lib/apiClient';
import {
  INACTIVE_STATUS_LABELS,
  STATUS_LABELS,
  TRANSFER_STATUS_LABELS
} from '@/types';

type SearchRecord = GlobalMidSearchResult['results'][number];

const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  ...STATUS_LABELS,
  ...INACTIVE_STATUS_LABELS,
  ...TRANSFER_STATUS_LABELS
};

const ACTION_FIELDS = new Set([
  'canEdit',
  'canDataEdit',
  'canScmCorrect',
  'canHeadOfficeApprove',
  'canHeadOfficeReject',
  'canAdminApprove',
  'canAdminReject',
  'canDelete',
  'canAdminEdit',
  'Awaiting My Action'
]);

const STUDENT_FIELDS = [
  'MID',
  'Student Name',
  'Branch',
  'Batch Name',
  'Faculty Name',
  'Status',
  'Current Stage',
  'Transfer To Branch'
];
const PHONE_FIELDS = ['Phone Number 1', 'Phone Number 2', 'Phone Number 3'];

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'string') {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (key === 'Status') return WORKFLOW_STATUS_LABELS[value] || value;

  const dateMatch = value.match(/^(\d{4}-\d{2}-\d{2})(T.*)?$/);
  if (!dateMatch) return value;
  const date = new Date(dateMatch[2] ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return dateMatch[2]
    ? date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function DetailSection({
  title,
  fields,
  record
}: {
  title: string;
  fields: Array<[string, unknown]>;
  record: Record<string, unknown>;
}) {
  if (fields.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-700/50">{title}</h3>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {fields.map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs text-ink-700/50">{key}</dt>
            <dd className="break-words text-sm text-ink-900">
              {formatDetailValue(key, key === 'Status' ? record.Status : value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RecordDetails({ result }: { result: SearchRecord }) {
  const record = result.record;
  const entries = Object.entries(record).filter(([key]) => !ACTION_FIELDS.has(key));
  const studentFields = STUDENT_FIELDS
    .filter((key) => key in record)
    .map((key) => [key, record[key]] as [string, unknown]);
  const phoneFields = PHONE_FIELDS
    .filter((key) => key in record)
    .map((key) => [key, record[key]] as [string, unknown]);
  const usedFields = new Set([...STUDENT_FIELDS, ...PHONE_FIELDS]);
  const otherFields = entries.filter(([key]) => !usedFields.has(key));

  return (
    <div className="max-h-[65vh] space-y-5 overflow-y-auto p-5">
      <DetailSection title="Student details" fields={studentFields} record={record} />
      <DetailSection title="Phone numbers" fields={phoneFields} record={record} />
      <DetailSection title="Other workflow information" fields={otherFields} record={record} />
    </div>
  );
}

export default function GlobalMidSearch() {
  const [mid, setMid] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchRecord | null>(null);
  const search = useMutation({ mutationFn: searchRecordsByMid });

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = mid.trim();
    if (!query) return;
    setSelectedResult(null);
    setIsOpen(true);
    search.mutate(query, {
      onSuccess: (result) => {
        if (result.results.length === 1) setSelectedResult(result.results[0]);
      }
    });
  }

  function close() {
    setIsOpen(false);
    setSelectedResult(null);
    search.reset();
  }

  const errorMessage = search.error instanceof ApiError
    ? `Search failed (${search.error.code}).`
    : search.error
      ? 'Could not search records. Please try again.'
      : null;

  return (
    <>
      <form onSubmit={submitSearch} className="flex min-w-0 items-center">
        <label htmlFor="global-mid-search" className="sr-only">Search workflows by MID</label>
        <div className="flex h-8 w-40 items-center gap-2 rounded-md border border-ink-100 bg-white px-2.5 focus-within:border-ink-700/40 sm:w-56 md:w-64">
          <Search size={15} className="shrink-0 text-ink-700/50" />
          <input
            id="global-mid-search"
            value={mid}
            onChange={(event) => setMid(event.target.value)}
            placeholder="Search MID across workflows"
            maxLength={100}
            className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-ink-700/40"
          />
        </div>
        <button
          type="submit"
          disabled={!mid.trim() || search.isPending}
          aria-label="Search MID"
          className="ml-1.5 rounded-md bg-ink-900 px-2.5 py-2 text-xs font-medium text-white hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Search
        </button>
      </form>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-mid-search-title"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-ink-100 bg-paper shadow-panel"
          >
            <header className="flex items-start justify-between border-b border-ink-100 bg-white px-5 py-4">
              <div className="min-w-0">
                <h2 id="global-mid-search-title" className="font-display text-xl">
                  {selectedResult
                    ? String(selectedResult.record['Student Name'] || 'Student details')
                    : `Search results for ${mid.trim()}`}
                </h2>
                <p className="mt-1 text-sm text-ink-700/60">
                  {selectedResult
                    ? `${selectedResult.workflow} · ${selectedResult.tab === 'completed' ? 'Approved' : 'Active'}`
                    : 'Search across Discontinue, Inactive, and Transfer workflows'}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close search"
                className="ml-3 rounded-md p-1.5 text-ink-700/60 hover:bg-paper hover:text-ink-900"
              >
                <X size={18} />
              </button>
            </header>

            {selectedResult ? (
              <>
                <div className="flex items-center gap-2 border-b border-ink-100 bg-white px-5 py-2">
                  <button
                    type="button"
                    onClick={() => setSelectedResult(null)}
                    className="inline-flex items-center gap-1 text-sm text-ink-700/70 hover:text-ink-900"
                  >
                    <ArrowLeft size={15} /> Back to results
                  </button>
                  <span className="ml-auto font-mono text-xs text-ink-700/60">
                    MID: {String(selectedResult.record.MID || mid.trim())}
                  </span>
                </div>
                <RecordDetails result={selectedResult} />
              </>
            ) : (
              <div className="min-h-32 overflow-y-auto p-5">
                {search.isPending && (
                  <p className="py-8 text-center text-sm text-ink-700/60">Searching workflows…</p>
                )}
                {errorMessage && (
                  <p role="alert" className="py-8 text-center text-sm text-reject">{errorMessage}</p>
                )}
                {search.data && search.data.results.length === 0 && (
                  <p className="py-8 text-center text-sm text-ink-700/60">
                    No records found for MID {search.data.MID}.
                  </p>
                )}
                {search.data && search.data.results.length > 1 && (
                  <div className="space-y-2">
                    {search.data.results.map((result, index) => (
                      <button
                        key={`${result.workflow}-${result.tab}-${index}`}
                        type="button"
                        onClick={() => setSelectedResult(result)}
                        className="flex w-full items-center justify-between gap-4 rounded-lg border border-ink-100 bg-white p-4 text-left hover:border-ink-700/30 hover:bg-paper"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {String(result.record['Student Name'] || 'Unnamed student')}
                          </span>
                          <span className="mt-1 block text-xs text-ink-700/60">
                            {String(result.record.Branch || '—')} · MID {String(result.record.MID || mid.trim())}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-xs font-medium text-ink-900">
                            {result.workflow} · {result.tab === 'completed' ? 'Approved' : 'Active'}
                          </span>
                          <span className="mt-1 block text-xs text-ink-700/60">
                            {formatDetailValue('Status', result.record.Status)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {search.data && search.data.results.length === 1 && !selectedResult && (
                  <button
                    type="button"
                    onClick={() => setSelectedResult(search.data!.results[0])}
                    className="w-full rounded-lg border border-ink-100 bg-white p-4 text-left hover:bg-paper"
                  >
                    Open {String(search.data.results[0].record['Student Name'] || 'student details')}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
