import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  X,
  Check,
  XCircle,
  Clock,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ChevronDown,
  Download,
  FileText,
  FileSpreadsheet,
  FileDown,
  Copy,
  CheckCheck,
  ImageIcon
} from 'lucide-react';
import {
  listInactive,
  listBranches,
  submitInactive,
  scmCorrectInactive,
  headOfficeApproveInactive,
  headOfficeUpdateInactive,
  headOfficeRejectInactive,
  approveInactive,
  rejectInactive,
  deleteInactive,
  getInactiveScreenshotUrl,
  markPageSeen,
  ApiError
} from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import type { InactiveEntry, InactiveStatus } from '@/types';
import { INACTIVE_STATUS_LABELS } from '@/types';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const PAGE_SIZE_OPTIONS = [15, 25, 50, 100] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

const STATUS_STYLES: Record<InactiveStatus, string> = {
  INACTIVE_PENDING_HEAD_OFFICE: 'bg-amber-light text-amber',
  INACTIVE_PENDING_ADMIN: 'bg-amber-light text-amber',
  INACTIVE_APPROVED: 'bg-approve-light text-approve',
  INACTIVE_PENDING_SCM: 'bg-reject-light text-reject'
};

function browser() {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      AUTH_FORBIDDEN: "You don't have permission to do this, or this request has already moved to another stage.",
      STUDENT_NOT_FOUND: 'This inactive request could not be found.',
      MID_ALREADY_EXISTS: 'An inactive request already exists for this MID.',
      BAD_REQUEST: 'Please check the entered information.',
      AUTH_INVALID_TOKEN: 'Your session has expired. Please sign in again.'
    };
    return messages[error.code] || `${fallback} (${error.code})`;
  }
  return fallback;
}

type FormValues = {
  mid: string;
  studentName: string;
  phone1: string;
  phone2: string;
  phone3: string;
  inactiveFrom: string;
  reason: string;
};

const EMPTY_FORM: FormValues = {
  mid: '',
  studentName: '',
  phone1: '',
  phone2: '',
  phone3: '',
  inactiveFrom: '',
  reason: ''
};

function toForm(row: InactiveEntry): FormValues {
  return {
    mid: row.MID || '',
    studentName: row['Student Name'] || '',
    phone1: row['Phone Number 1'] || '',
    phone2: row['Phone Number 2'] || '',
    phone3: row['Phone Number 3'] || '',
    inactiveFrom: row['Last Present Day'] || '',
    reason: row.Reason || ''
  };
}

function Modal({
  title,
  children,
  onClose,
  width = '36rem'
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div
        className="w-full max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px] overflow-auto resize rounded-lg bg-white border border-ink-100 shadow-panel"
        style={{ width }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-100">
          <h2 className="font-display text-lg">{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-paper">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  disabled = false,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-700/70 mb-1">{label}{required ? ' *' : ''}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-ink-100 bg-white px-3 py-2 text-sm outline-none focus:border-ink-400 disabled:bg-paper disabled:text-ink-700/40"
      />
    </label>
  );
}

function Form({
  value,
  setValue,
  onSubmit,
  submitting,
  submitLabel
}: {
  value: FormValues;
  setValue: React.Dispatch<React.SetStateAction<FormValues>>;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const set = (key: keyof FormValues) => (v: string) =>
    setValue((old) => ({ ...old, [key]: v }));

  return (
    <div className="p-5 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="MID" value={value.mid} onChange={set('mid')} required />
        <Field label="Student Name" value={value.studentName} onChange={set('studentName')} required />
        <Field label="Phone Number 1" value={value.phone1} onChange={set('phone1')} required />
        <Field label="Phone Number 2" value={value.phone2} onChange={set('phone2')} />
        <Field label="Phone Number 3" value={value.phone3} onChange={set('phone3')} />
        <div />
        <Field label="Last Present Day" value={value.inactiveFrom} onChange={set('inactiveFrom')} type="date" required />
      </div>

      <label className="block">
        <span className="block text-xs font-medium text-ink-700/70 mb-1">Reason *</span>
        <textarea
          value={value.reason}
          onChange={(e) => set('reason')(e.target.value)}
          rows={5}
          className="w-full rounded-md border border-ink-100 bg-white px-3 py-2 text-sm outline-none focus:border-ink-400 resize-y min-h-[120px]"
        />
      </label>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-md bg-ink-900 text-white px-4 py-2 text-sm hover:bg-ink-800 disabled:opacity-50"
        >
          {submitting && <Loader2 size={15} className="animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}


function ModalShell({children,onClose}:{children:React.ReactNode;onClose:()=>void}) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4 py-8 overflow-y-auto" onClick={onClose}>
      <div
        className="relative w-full bg-white rounded-lg shadow-panel border border-ink-100 p-6 my-auto resize overflow-auto max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px]"
        style={{ width: 'min(42rem, 95vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-4 top-4 text-ink-700/40 hover:text-ink-700 transition-colors">
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}

function ImagePreviewModal({ urls, initialIndex = 0, onClose }: { urls: string[]; initialIndex?: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function resetZoom() { setScale(1); setPos({ x: 0, y: 0 }); }
  function goTo(next: number) {
    setIndex((next + urls.length) % urls.length);
    resetZoom();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && urls.length > 1) goTo(index - 1);
      if (e.key === 'ArrowRight' && urls.length > 1) goTo(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, index, urls.length]);

  function clampScale(next: number) { return Math.min(6, Math.max(1, next)); }
  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setScale((s) => { const next = clampScale(s - e.deltaY * 0.0018); if (next === 1) setPos({ x: 0, y: 0 }); return next; });
  }
  function handleMouseDown(e: React.MouseEvent) {
    if (scale <= 1) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    setDragging(true);
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!dragState.current) return;
    setPos({ x: dragState.current.origX + (e.clientX - dragState.current.startX), y: dragState.current.origY + (e.clientY - dragState.current.startY) });
  }
  function stopDrag() { dragState.current = null; setDragging(false); }

  return (
    <div className="fixed inset-0 z-[100] bg-black/85 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-end gap-2 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        {urls.length > 1 && <span className="text-white/70 text-xs mr-2">{index + 1} / {urls.length}</span>}
        <button type="button" onClick={() => setScale((s) => clampScale(s - 0.25))} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">−</button>
        <input type="range" min={1} max={6} step={0.1} value={scale} onChange={(e) => setScale(clampScale(Number(e.target.value)))} className="w-32 accent-ink-900" aria-label="Zoom level" />
        <button type="button" onClick={() => setScale((s) => clampScale(s + 0.25))} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">+</button>
        <span className="text-white/70 text-xs w-10 text-center">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={resetZoom} className="rounded-md bg-white/90 hover:bg-white px-2.5 py-1.5 text-sm font-medium">Reset</button>
        <button type="button" onClick={onClose} className="rounded-md bg-white/90 hover:bg-white p-1.5" aria-label="Close"><X size={18} /></button>
      </div>
      <div
        className="relative flex-1 overflow-hidden flex items-center justify-center select-none"
        onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={stopDrag} onMouseLeave={stopDrag}
        onClick={(e) => e.stopPropagation()}
      >
        {urls.length > 1 && (
          <button type="button" onClick={() => goTo(index - 1)} aria-label="Previous image" className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 hover:bg-white p-2 z-10">
            <ChevronLeft size={20} />
          </button>
        )}
        <img
          src={urls[index]}
          alt="Attachment"
          draggable={false}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
          className="max-w-[95vw] max-h-[80vh] object-contain"
        />
        {urls.length > 1 && (
          <button type="button" onClick={() => goTo(index + 1)} aria-label="Next image" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 hover:bg-white p-2 z-10">
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

function ViewAttachmentButton({ mid, sheet }: { mid: string; sheet: 'response' | 'completed' }) {
  const [loading, setLoading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[] | null>(null);

  async function handleClick() {
    setLoading(true);
    try {
      const { urls } = await getInactiveScreenshotUrl(mid, sheet);
      setPreviewUrls(urls);
    } catch {
      alert('Could not load the image. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        title="View attached image(s)"
        className="inline-flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink-900 disabled:opacity-50"
      >
        <ImageIcon size={14} /> {loading ? 'Loading…' : 'View image'}
      </button>
      {previewUrls && previewUrls.length > 0 && <ImagePreviewModal urls={previewUrls} onClose={() => setPreviewUrls(null)} />}
    </>
  );
}

function ViewAttachmentButtonIcon({ mid, sheet }: { mid: string; sheet: 'response' | 'completed' }) {
  const [loading, setLoading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[] | null>(null);

  async function handleClick() {
    setLoading(true);
    try {
      const { urls } = await getInactiveScreenshotUrl(mid, sheet);
      setPreviewUrls(urls);
    } catch {
      alert('Could not load the image. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={handleClick} disabled={loading} title="View attached image(s)" className="shrink-0 text-ink-700/50 hover:text-ink-900 disabled:opacity-50">
        {loading ? <Loader2 size={14} className="animate-spin"/> : <ImageIcon size={14} />}
      </button>
      {previewUrls && previewUrls.length > 0 && <ImagePreviewModal urls={previewUrls} onClose={() => setPreviewUrls(null)} />}
    </>
  );
}

function InactiveDetailsModal({
  row, userRole, sheet, onEdit, onApproveHeadOffice, onReject, onApproveAdmin, onDelete, onClose
}: {
  row: InactiveEntry;
  userRole?: string;
  sheet: 'response' | 'completed';
  onEdit: () => void;
  onApproveHeadOffice: () => void;
  onReject: () => void;
  onApproveAdmin: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(phone?: string) {
    if (!phone) return;
    try { await navigator.clipboard.writeText(phone); setCopied(phone); setTimeout(() => setCopied(null), 1200); } catch {}
  }
  const isHO = userRole === 'Head Office';
  const isAdmin = userRole === 'Admin';
  return (
    <ModalShell onClose={onClose}>
      <div className="space-y-5">
        <div>
          <h2 className="font-display text-xl mb-1">{row['Student Name']}</h2>
          <p className="text-sm text-ink-700/60">{row.MID}</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Student details</p>
            <div className="space-y-1.5 text-sm">
              <p><span className="text-ink-700/50">MID:</span> <span className="font-mono">{row.MID}</span></p>
              <p><span className="text-ink-700/50">Name:</span> {row['Student Name']}</p>
              <p><span className="text-ink-700/50">Branch:</span> {row.Branch}</p>
              <p><span className="text-ink-700/50">Status:</span> {INACTIVE_STATUS_LABELS[row.Status] || row.Status}</p>
            </div>
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Phone numbers</p>
            {[['Phone 1 — Student', row['Phone Number 1']], ['Phone 2 — Parent 1', row['Phone Number 2']], ['Phone 3 — Parent 2', row['Phone Number 3']]].map(([label, phone]) => phone ? (
              <div key={String(label)} className="flex items-center justify-between py-1.5">
                <div><span className="block text-xs text-ink-700/50">{label}</span><span className="font-mono text-sm">{phone}</span></div>
                <button onClick={(e) => { e.stopPropagation(); copy(String(phone)); }} className="inline-flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink-900">
                  {copied === phone ? <CheckCheck size={14} className="text-approve" /> : <Copy size={14} />}
                  {copied === phone ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : null)}
          </div>
          <div className="rounded-lg border border-ink-100 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Inactive period</p>
            <p className="text-sm">Last Present Day: {row['Last Present Day'] || '—'}</p>
            <p className="text-sm">Days Since Last Present: {row['Days Since Last Present'] ?? '—'}</p>
            <p className="text-sm">Entry date: {row['Entry Date'] || '—'}</p>
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-ink-700/50">Reasons</p>
            {(isAdmin||isHO) && row['Screenshot Uploaded'] && <ViewAttachmentButton mid={row.MID} sheet={sheet}/>}
          </div>
          <ReasonBoxInactive label="Reason" value={row.Reason} defaultOpen={isAdmin||isHO} />
          {row['Last Rejection Reason'] && <ReasonBoxInactive label={`Last rejection — ${row['Last Rejected By'] || 'Unknown'}`} value={row['Last Rejection Reason']} defaultOpen={isAdmin||isHO} />}
        </div>
        <div className="flex flex-wrap gap-2 pt-4 border-t border-ink-100">
          {isHO && row.canHeadOfficeApprove && <button onClick={() => onApproveHeadOffice()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm"><Check size={14}/>Approve</button>}
          {isHO && row.canHeadOfficeReject && <button onClick={() => onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14}/>Reject</button>}
          {isHO && row.canHeadOfficeApprove && <button onClick={() => onEdit()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm"><Pencil size={14}/>Edit full record</button>}
          {isAdmin && row.canAdminApprove && <button onClick={() => onApproveAdmin()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm"><Check size={14}/>Approve</button>}
          {isAdmin && row.canAdminReject && <button onClick={() => onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14}/>Reject</button>}
          {row.canEdit && userRole === 'SCM' && <button onClick={() => onEdit()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm"><Pencil size={14}/>Correct & resubmit</button>}
          {(isAdmin || isHO) && row.canDelete && <button onClick={() => onDelete()} className="inline-flex items-center gap-1.5 rounded-md border border-reject/30 text-reject px-3 py-1.5 text-sm"><Trash2 size={14}/>Delete</button>}
        </div>
      </div>
    </ModalShell>
  );
}

function ReasonBoxInactive({label,value,defaultOpen}:{label:string;value?:string;defaultOpen?:boolean}) {
  return <details open={defaultOpen} className="rounded-lg border border-ink-100 bg-white overflow-hidden">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium flex items-center justify-between hover:bg-paper"><span>{label}</span><ChevronDown size={16} className="text-ink-700/40"/></summary>
    <div className="border-t border-ink-100 p-3"><div className="max-h-48 min-h-[80px] overflow-y-auto resize-y whitespace-pre-wrap break-words text-sm leading-6 text-ink-700/80">{value?.trim() || <span className="italic text-ink-700/30">Not yet provided</span>}</div></div>
  </details>;
}

export default function Inactive() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Item 7: opening Inactive clears its sidebar "unseen" badge.
  useEffect(() => {
    markPageSeen('inactive')
      .then(() => queryClient.invalidateQueries({ queryKey: ['activeCounts'] }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [tab, setTab] = useState<'active' | 'completed'>(
    searchParams.get('tab') === 'completed' ? 'completed' : 'active'
  );
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [branchFilter, setBranchFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(15);

  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [editTarget, setEditTarget] = useState<InactiveEntry | null>(null);
  const [rejectTarget, setRejectTarget] = useState<InactiveEntry | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<InactiveEntry | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [selectedInactive, setSelectedInactive] = useState<InactiveEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    if (exportMenuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen]);

  useEffect(() => {
    const urlTab = searchParams.get('tab') === 'completed' ? 'completed' : 'active';
    if (urlTab !== tab) {
      setTab(urlTab);
      setPage(1);
    }
    const urlSearch = searchParams.get('search') || '';
    if (urlSearch !== search) {
      setSearch(urlSearch);
      setPage(1);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectTab(next: 'active' | 'completed') {
    setTab(next);
    setPage(1);
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'completed') nextParams.set('tab', 'completed');
    else nextParams.delete('tab');
    setSearchParams(nextParams, { replace: true });
  }

  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: listBranches,
    enabled: user?.role === 'Admin' || user?.role === 'Head Office'
  });

  const params = useMemo(
    () => ({
      search: search.trim() || undefined,
      branch: branchFilter || undefined,
      page,
      pageSize
    }),
    [search, branchFilter, page, pageSize]
  );

  const listQuery = useQuery({
    queryKey: ['inactive', tab, params],
    queryFn: () => listInactive(tab === 'completed' ? 'completed' : 'response', params),
    enabled: !!user
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['inactive'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['activeCounts'] });
  };

  const submitMutation = useMutation({
    mutationFn: () => submitInactive({
      ...form,
      phone2: form.phone2 || undefined,
      phone3: form.phone3 || undefined
    }),
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setPage(1);
      refresh();
    },
    onError: (e) => setError(errorText(e, 'Could not submit the inactive request.'))
  });

  const correctionMutation = useMutation({
    mutationFn: () => scmCorrectInactive(editTarget!.MID, {
      MID: form.mid,
      'Student Name': form.studentName,
      'Phone Number 1': form.phone1,
      'Phone Number 2': form.phone2,
      'Phone Number 3': form.phone3,
      'Last Present Day': form.inactiveFrom,
      Reason: form.reason
    }),
    onSuccess: () => {
      setEditTarget(null);
      setForm(EMPTY_FORM);
      refresh();
    },
    onError: (e) => setError(errorText(e, 'Could not resubmit the correction.'))
  });
  const headOfficeEditMutation = useMutation({
    mutationFn: () => headOfficeUpdateInactive(editTarget!.MID, {
      MID: form.mid,
      'Student Name': form.studentName,
      'Phone Number 1': form.phone1,
      'Phone Number 2': form.phone2 || undefined,
      'Phone Number 3': form.phone3 || undefined,
      'Last Present Day': form.inactiveFrom,
      Reason: form.reason
    }),
    onSuccess: () => {
      setEditTarget(null);
      setForm(EMPTY_FORM);
      refresh();
    },
    onError: (e) => setError(errorText(e, 'Could not save the Head Office edit.'))
  });

  const approveHoMutation = useMutation({
    mutationFn: (mid: string) => headOfficeApproveInactive(mid),
    onSuccess: refresh,
    onError: (e) => setError(errorText(e, 'Could not approve the request.'))
  });

  const approveAdminMutation = useMutation({
    mutationFn: (mid: string) => approveInactive(mid),
    onSuccess: () => {
      refresh();
      if (tab === 'active') setPage(1);
    },
    onError: (e) => setError(errorText(e, 'Could not approve the request.'))
  });

  const rejectMutation = useMutation({
    mutationFn: () => tab === 'active' && rejectTarget
      ? (user?.role === 'Head Office'
          ? headOfficeRejectInactive(rejectTarget.MID, rejectReason)
          : rejectInactive(rejectTarget.MID, rejectReason))
      : Promise.reject(new Error('Invalid rejection target')),
    onSuccess: () => {
      setRejectTarget(null);
      setRejectReason('');
      refresh();
    },
    onError: (e) => setError(errorText(e, 'Could not reject the request.'))
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteInactive(deleteTarget!.MID, tab === 'completed' ? 'completed' : 'response', deleteConfirmText.trim()),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteConfirmText('');
      refresh();
    },
    onError: (e) => setError(errorText(e, 'Could not delete the request.'))
  });

  function openEdit(row: InactiveEntry) {
    setEditTarget(row);
    setForm(toForm(row));
  }

  const rows = listQuery.data?.rows || [];
  const total = listQuery.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Inactive downloads are available only to Head Office and Admin,
  // on both Active and Approved tabs.
  const canExport = user?.role === 'Admin' || user?.role === 'Head Office';

  async function handleExport(format: 'csv' | 'xlsx' | 'pdf') {
    if (!canExport) return;
    setExporting(true);
    setExportMenuOpen(false);
    setError(null);
    try {
      const source = tab === 'completed' ? 'completed' : 'response';
      const allRows: InactiveEntry[] = [];
      let exportPage = 1;
      let totalRows = 0;

      do {
        const result = await listInactive(source, {
          search: search.trim() || undefined,
          branch: branchFilter || undefined,
          page: exportPage,
          pageSize: 200
        });
        allRows.push(...result.rows);
        totalRows = result.total;
        exportPage += 1;
        if (result.rows.length === 0) break;
      } while (allRows.length < totalRows);

      const exportRows = allRows.map((row) => ({
        'Sl No': row['Sl No'],
        Branch: row.Branch,
        MID: row.MID,
        'Student Name': row['Student Name'],
        'Phone Number 1': row['Phone Number 1'],
        'Phone Number 2': row['Phone Number 2'] || '',
        'Phone Number 3': row['Phone Number 3'] || '',
        'Last Present Day': row['Last Present Day'],
        Reason: row.Reason,
        Status: INACTIVE_STATUS_LABELS[row.Status] || row.Status,
        'Entry Date': row['Entry Date'] || '',
        'Head Office Decision': row['Head Office Decision'] || '',
        'Head Office Name': row['Head Office Name'] || '',
        'Head Office Date': row['Head Office Date'] || '',
        'Admin Approval': row['Admin Approval'] || '',
        'Admin Name': row['Admin Name'] || '',
        'Approval Date': row['Approval Date'] || '',
        'Last Rejection Reason': row['Last Rejection Reason'] || '',
        'Last Rejected By': row['Last Rejected By'] || '',
        'Last Rejected Stage': row['Last Rejected Stage'] || '',
        'Last Rejected Date': row['Last Rejected Date'] || ''
      }));

      if (exportRows.length === 0) {
        setError('There are no records to download for the current filters.');
        return;
      }

      const baseName = `inactive_${tab === 'completed' ? 'approved' : 'active'}_${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        const headers = Object.keys(exportRows[0]);
        const escape = (v: unknown) => {
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [
          headers.join(','),
          ...exportRows.map((r) => headers.map((h) => escape(r[h as keyof typeof r])).join(','))
        ].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${baseName}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      } else if (format === 'xlsx') {
        const worksheet = XLSX.utils.json_to_sheet(exportRows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, tab === 'completed' ? 'Approved' : 'Active');
        XLSX.writeFile(workbook, `${baseName}.xlsx`);
      } else {
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        autoTable(doc, {
          head: [Object.keys(exportRows[0])],
          body: exportRows.map((r) => Object.values(r)),
          styles: { fontSize: 6 },
          headStyles: { fontSize: 6 },
          margin: { top: 12, right: 5, bottom: 10, left: 5 }
        });
        doc.save(`${baseName}.pdf`);
      }
    } catch (e) {
      setError(errorText(e, 'Could not export. Please try again.'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-5">
      <div className="shrink-0 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Inactive Students</h2>
          <p className="text-sm text-ink-700/60 mt-1">
            SCM submits inactive requests for Head Office and Admin approval.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canExport && (
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={exporting}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors disabled:opacity-60"
              >
                <Download size={16} />
                {exporting ? 'Exporting…' : 'Download'}
                <ChevronDown size={14} className={`transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {exportMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 rounded-md border border-ink-100 bg-white shadow-panel py-1.5 z-20">
                  <button
                    onClick={() => handleExport('csv')}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper"
                  >
                    <FileText size={15} className="text-ink-700/60" />
                    CSV <span className="text-ink-700/40">(.csv)</span>
                  </button>
                  <button
                    onClick={() => handleExport('xlsx')}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper"
                  >
                    <FileSpreadsheet size={15} className="text-ink-700/60" />
                    Excel <span className="text-ink-700/40">(.xlsx)</span>
                  </button>
                  <button
                    onClick={() => handleExport('pdf')}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-paper"
                  >
                    <FileDown size={15} className="text-ink-700/60" />
                    PDF <span className="text-ink-700/40">(.pdf)</span>
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      <div className="shrink-0 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
              const next = new URLSearchParams(searchParams);
              if (e.target.value) next.set('search', e.target.value);
              else next.delete('search');
              setSearchParams(next, { replace: true });
            }}
            placeholder="Search MID, name or phone"
            className="w-full rounded-md border border-ink-100 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-ink-400"
          />
        </div>

        {(user?.role === 'Admin' || user?.role === 'Head Office') && (
          <select
            value={branchFilter}
            onChange={(e) => {
              setBranchFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-ink-100 bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="">All branches</option>
            {(branchesQuery.data || []).map((branch) => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-reject/20 bg-reject-light px-4 py-3 text-sm text-reject flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}

      {(() => {
        // Split into a "Needs Your Attention" table (entries actually
        // awaiting THIS user's action) and the regular table with
        // everything else. Only relevant on the active tab - once
        // nothing is left awaiting this user, only the single full
        // table remains.
        const attentionRows = tab === 'active' ? rows.filter((r) => r['Awaiting My Action']) : [];
        const hasAttention = attentionRows.length > 0;
        const mainRows = hasAttention ? rows.filter((r) => !r['Awaiting My Action']) : rows;

        const renderInactiveRows = (list: InactiveEntry[], emptyMessage: string) => (
          <tbody>
            {listQuery.isLoading && <tr><td colSpan={user?.role === 'Head Office' ? 7 : 6} className="px-4 py-10 text-center text-ink-700/50">Loading...</td></tr>}
            {!listQuery.isLoading && list.length === 0 && <tr><td colSpan={user?.role === 'Head Office' ? 7 : 6} className="px-4 py-10 text-center text-ink-700/50">{emptyMessage}</td></tr>}
            {list.map((row, i) => (
              <tr
                key={`${row.MID}-${row['Sl No']}`}
                onClick={() => setSelectedInactive(row)}
                className="border-b border-ink-100 last:border-b-0 hover:bg-paper/60 cursor-pointer"
              >
                <td className="px-4 py-3 text-ink-700/50">{i + 1}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.MID}</td>
                <td className="px-4 py-3 font-medium">{row['Student Name']}</td>
                {user?.role === 'Head Office' && <td className="px-4 py-3 text-ink-700/70">{row.Branch || '—'}</td>}
                <td className="px-4 py-3 text-ink-700/70">{[row['Phone Number 1'], row['Phone Number 2'], row['Phone Number 3']].filter(Boolean).map((p, j) => <div key={j} className="font-mono text-xs">{p}</div>)}</td>
                <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs ${STATUS_STYLES[row.Status] || 'bg-paper text-ink-700'}`}>{INACTIVE_STATUS_LABELS[row.Status] || row.Status}</span></td>
                <td className="px-4 py-3 max-w-sm">
                  <div className="flex items-center gap-1.5">
                    <div className="truncate text-xs">{row.Reason || 'Not yet provided'}</div>
                    {(user?.role==='Admin'||user?.role==='Head Office') && row['Screenshot Uploaded'] &&
                      <span onClick={(e)=>e.stopPropagation()}><ViewAttachmentButtonIcon mid={row.MID} sheet={tab==='completed'?'completed':'response'}/></span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        );

        const tableHead = (
          <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:bg-paper [&_th]:[box-shadow:inset_0_-1px_0_theme(colors.ink.100)]">
            <tr>
              <th className="text-left px-4 py-3 font-medium">#</th>
              <th className="text-left px-4 py-3 font-medium">MID</th>
              <th className="text-left px-4 py-3 font-medium">Student</th>
              {user?.role === 'Head Office' && <th className="text-left px-4 py-3 font-medium">Branch</th>}
              <th className="text-left px-4 py-3 font-medium">Phone numbers</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Reason</th>
            </tr>
          </thead>
        );

        return (
          <>
            <div className="flex-1 min-h-0 overflow-auto space-y-5">
            {hasAttention && (
              <div className="rounded-lg border-2 border-amber bg-white overflow-clip min-w-fit">
                <div className="px-4 py-2.5 bg-amber-light border-b border-amber/30">
                  <h3 className="text-sm font-semibold text-amber">Needs Your Attention ({attentionRows.length})</h3>
                </div>
                <div>
                  <table className="w-full text-sm">
                    {tableHead}
                    {renderInactiveRows(attentionRows, 'Nothing here.')}
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-ink-100 bg-white overflow-clip min-w-fit">
              <div>
                <table className="w-full text-sm">
                  {tableHead}
                  {renderInactiveRows(mainRows, 'No inactive requests found.')}
                </table>
              </div>
            </div>
            </div>
              <div className="shrink-0 flex items-center justify-between px-4 py-3 rounded-lg border border-ink-100 bg-white">
          <span className="text-xs text-ink-700/60">{total} request(s)</span>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value) as PageSize);
                setPage(1);
              }}
              className="rounded-md border border-ink-100 bg-white px-2 py-1.5 text-xs"
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}/page</option>)}
            </select>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-1.5 rounded-md border border-ink-100 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs">Page {page} of {totalPages}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 rounded-md border border-ink-100 disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
          </>
        );
      })()}

      {selectedInactive && (
        <InactiveDetailsModal
          row={selectedInactive}
          userRole={user?.role}
          sheet={tab==='completed'?'completed':'response'}
          onEdit={() => { openEdit(selectedInactive); setSelectedInactive(null); }}
          onApproveHeadOffice={() => { approveHoMutation.mutate(selectedInactive.MID); setSelectedInactive(null); }}
          onReject={() => { setRejectTarget(selectedInactive); setRejectReason(''); setError(null); setSelectedInactive(null); }}
          onApproveAdmin={() => { approveAdminMutation.mutate(selectedInactive.MID); setSelectedInactive(null); }}
          onDelete={() => { setDeleteTarget(selectedInactive); setSelectedInactive(null); }}
          onClose={() => setSelectedInactive(null)}
        />
      )}

      {editTarget && (user?.role === 'SCM' || user?.role === 'Head Office') && (
        <Modal
          title={user?.role === 'Head Office' ? "Edit Inactive Request" : "Correct Inactive Request"}
          onClose={() => {
            setEditTarget(null);
            setForm(EMPTY_FORM);
          }}
        >
          <Form
            value={form}
            setValue={setForm}
            submitting={correctionMutation.isPending}
            submitLabel={user?.role === 'Head Office' ? 'Save changes' : 'Correct & Resubmit'}
            onSubmit={() => {
              setError(null);
              if (!form.mid.trim() || !form.studentName.trim() || !form.phone1.trim() ||
                  !form.phone2.trim() || !form.inactiveFrom || !form.reason.trim()) {
                setError('MID, name, Phone 1, Phone 2, Last Present Day and Reason are required.');
                return;
              }
              if (user?.role === 'Head Office') headOfficeEditMutation.mutate();
              else correctionMutation.mutate();
            }}
          />
        </Modal>
      )}

      {rejectTarget && (
        <Modal title="Reject Inactive Request" onClose={() => setRejectTarget(null)} width="32rem">
          <div className="p-5 space-y-4">
            <p className="text-sm text-ink-700/70">
              Reject <strong>{rejectTarget.MID}</strong> and return it to SCM?
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={5}
              placeholder="Enter rejection reason"
              className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm resize-y min-h-[120px] outline-none focus:border-ink-400"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRejectTarget(null)} className="rounded-md border border-ink-100 px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!rejectReason.trim()) {
                    setError('Rejection reason is required.');
                    return;
                  }
                  rejectMutation.mutate();
                }}
                disabled={rejectMutation.isPending}
                className="rounded-md bg-reject text-white px-4 py-2 text-sm disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal title="Delete Inactive Request" onClose={() => { setDeleteTarget(null); setDeleteConfirmText(''); }} width="32rem">
          <div className="p-5 space-y-4">
            <p className="text-sm">
              Permanently delete inactive request <strong>{deleteTarget.MID}</strong>?
              This cannot be undone. Type the MID below to confirm.
            </p>
            <input
              required
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={deleteTarget.MID}
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-reject"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDeleteTarget(null); setDeleteConfirmText(''); }} className="rounded-md border border-ink-100 px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteConfirmText.trim() !== deleteTarget.MID || deleteMutation.isPending}
                className="rounded-md bg-reject text-white px-4 py-2 text-sm disabled:opacity-40"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}