import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Ban, Clock, ArrowLeftRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { submitStudentEntry, submitInactive, submitTransfer, listBranches, ApiError } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import { useDraftAutosave, loadDraft, clearDraft } from '@/hooks/useDraftAutosave';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

type Workflow = 'discontinue' | 'inactive' | 'transfer';

type CommonForm = {
  mid: string;
  studentName: string;
  batchName: string;
  facultyName: string;
  phone1: string;
  phone2: string;
  phone3: string;
  reason: string;
};

type DiscontinueForm = CommonForm & {
  totalBilled: string;
  totalPaid: string;
  lastPresentDay: string;
};

type InactiveForm = CommonForm & { inactiveFrom: string; };
type TransferForm = CommonForm & { transferToBranch: string; };

const EMPTY_COMMON: CommonForm = {
  mid: '', studentName: '', batchName: '', facultyName: '', phone1: '', phone2: '', phone3: '', reason: ''
};

const EMPTY_DISCONTINUE: DiscontinueForm = {
  ...EMPTY_COMMON, totalBilled: '', totalPaid: '', lastPresentDay: ''
};

const EMPTY_INACTIVE: InactiveForm = { ...EMPTY_COMMON, inactiveFrom: '' };
const EMPTY_TRANSFER: TransferForm = { ...EMPTY_COMMON, transferToBranch: '' };

/** Per-user, per-workflow localStorage key so drafts never leak between SCMs sharing a browser. */
function draftKey(userEmail: string | undefined, workflow: Workflow) {
  return `saws-draft-${userEmail || 'unknown'}-${workflow}`;
}

/** Skip autosaving (and skip showing a "draft restored" banner for) a form that's still fully blank. */
function hasDraftContent(form: Record<string, string>) {
  return Object.values(form).some((v) => v.trim().length > 0);
}


function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    return error.message ? `${fallback} (${error.code}: ${error.message})` : `${fallback} (${error.code})`;
  }
  return fallback;
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-ink-900">
        {label}
        {required && <span className="text-red-600">&nbsp;*</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass = 'w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900';
const textareaClass = 'w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y min-h-[120px]';

/** Thumbnail grid for the multi-image picker, with a small remove (x) button per image. */
function ScreenshotPreviewGrid({ previews, onRemove }: { previews: string[]; onRemove: (index: number) => void }) {
  if (!previews.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {previews.map((src, i) => (
        <div key={src} className="relative">
          <img src={src} alt={`Attachment ${i + 1}`} className="h-20 w-20 object-cover rounded-md border border-ink-200" />
          <button
            type="button"
            onClick={() => onRemove(i)}
            aria-label="Remove image"
            className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-ink-900 text-white text-xs leading-5 text-center hover:bg-reject"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function NewEntry() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<Workflow>('discontinue');
  const [discontinue, setDiscontinue] = useState<DiscontinueForm>(EMPTY_DISCONTINUE);
  const [inactive, setInactive] = useState<InactiveForm>(EMPTY_INACTIVE);
  const [transfer, setTransfer] = useState<TransferForm>(EMPTY_TRANSFER);
  const [error, setError] = useState<string | null>(null);
  // SCM may attach multiple images on every workflow this page creates
  // (Discontinue, Inactive, Transfer are all SCM-only submissions).
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [screenshotPreviews, setScreenshotPreviews] = useState<string[]>([]);
  const MAX_SCREENSHOTS = 6;
  const branchesQuery = useQuery({ queryKey: ['branches'], queryFn: listBranches, enabled: user?.role === 'SCM' });

  // ---- Draft autosave (Discontinue / Inactive / Transfer, independently) ----
  // Protects a half-typed request against a minimized tab, an SCM getting
  // pulled away, or the browser closing - see hooks/useDraftAutosave.ts.
  const draftsLoadedRef = useRef(false);
  const [restoredDraftAt, setRestoredDraftAt] = useState<Record<Workflow, number | null>>({
    discontinue: null,
    inactive: null,
    transfer: null
  });

  useEffect(() => {
    if (!user || draftsLoadedRef.current) return;
    draftsLoadedRef.current = true;

    const d = loadDraft<DiscontinueForm>(draftKey(user.email, 'discontinue'));
    if (d && hasDraftContent(d.value)) {
      setDiscontinue(d.value);
      setRestoredDraftAt((prev) => ({ ...prev, discontinue: d.savedAt }));
    }
    const i = loadDraft<InactiveForm>(draftKey(user.email, 'inactive'));
    if (i && hasDraftContent(i.value)) {
      setInactive(i.value);
      setRestoredDraftAt((prev) => ({ ...prev, inactive: i.savedAt }));
    }
    const t = loadDraft<TransferForm>(draftKey(user.email, 'transfer'));
    if (t && hasDraftContent(t.value)) {
      setTransfer(t.value);
      setRestoredDraftAt((prev) => ({ ...prev, transfer: t.savedAt }));
    }
  }, [user]);

  const discontinueAutosave = useDraftAutosave({
    key: draftKey(user?.email, 'discontinue'),
    value: discontinue,
    enabled: !!user && hasDraftContent(discontinue)
  });
  const inactiveAutosave = useDraftAutosave({
    key: draftKey(user?.email, 'inactive'),
    value: inactive,
    enabled: !!user && hasDraftContent(inactive)
  });
  const transferAutosave = useDraftAutosave({
    key: draftKey(user?.email, 'transfer'),
    value: transfer,
    enabled: !!user && hasDraftContent(transfer)
  });

  const autosaveByWorkflow: Record<Workflow, { lastSavedAt: number | null }> = {
    discontinue: discontinueAutosave,
    inactive: inactiveAutosave,
    transfer: transferAutosave
  };

  function discardDraft(target: Workflow) {
    clearDraft(draftKey(user?.email, target));
    setRestoredDraftAt((prev) => ({ ...prev, [target]: null }));
    if (target === 'discontinue') setDiscontinue(EMPTY_DISCONTINUE);
    if (target === 'inactive') setInactive(EMPTY_INACTIVE);
    if (target === 'transfer') setTransfer(EMPTY_TRANSFER);
  }


  function clearScreenshots() {
    setScreenshotFiles([]);
    setScreenshotPreviews([]);
  }

  function handleScreenshotChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file(s) later
    setError(null);
    if (!files.length) return;
    if (screenshotFiles.length + files.length > MAX_SCREENSHOTS) {
      setError(`You can attach up to ${MAX_SCREENSHOTS} images.`);
      return;
    }
    for (const file of files) {
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        setError('Please upload JPG or PNG images only.');
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setError('Each image must be under 8MB.');
        return;
      }
    }
    setScreenshotFiles((prev) => [...prev, ...files]);
    setScreenshotPreviews((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))]);
  }

  function removeScreenshotAt(index: number) {
    setScreenshotFiles((prev) => prev.filter((_, i) => i !== index));
    setScreenshotPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function buildScreenshots() {
    return Promise.all(
      screenshotFiles.map(async (f) => ({ base64: await fileToBase64(f), mimeType: f.type }))
    );
  }

  const discontinueMutation = useMutation({
    mutationFn: async () => {
      const screenshots = await buildScreenshots();
      return submitStudentEntry({
        mid: discontinue.mid.trim(),
        studentName: discontinue.studentName.trim(),
        batchName: discontinue.batchName.trim() || undefined,
        facultyName: discontinue.facultyName.trim() || undefined,
        phone1: discontinue.phone1.trim(),
        phone2: discontinue.phone2.trim() || undefined,
        phone3: discontinue.phone3.trim() || undefined,
        totalBilled: discontinue.totalBilled ? Number(discontinue.totalBilled) : undefined,
        totalPaid: discontinue.totalPaid ? Number(discontinue.totalPaid) : undefined,
        lastPresentDay: discontinue.lastPresentDay || undefined,
        reason: discontinue.reason.trim(),
        screenshots
      });
    },
    onSuccess: () => {
      setDiscontinue(EMPTY_DISCONTINUE);
      clearDraft(draftKey(user?.email, 'discontinue'));
      setRestoredDraftAt((prev) => ({ ...prev, discontinue: null }));
      clearScreenshots();
      navigate('/students?tab=active');
    },
    onError: (e) => setError(errorText(e, 'Could not submit the discontinuation request.'))
  });

  const inactiveMutation = useMutation({
    mutationFn: async () => {
      const screenshots = await buildScreenshots();
      return submitInactive({
        mid: inactive.mid.trim(),
        studentName: inactive.studentName.trim(),
        batchName: inactive.batchName.trim() || undefined,
        facultyName: inactive.facultyName.trim() || undefined,
        phone1: inactive.phone1.trim(),
        phone2: inactive.phone2.trim() || undefined,
        phone3: inactive.phone3.trim() || undefined,
        inactiveFrom: inactive.inactiveFrom,
        reason: inactive.reason.trim(),
        screenshots
      });
    },
    onSuccess: () => {
      setInactive(EMPTY_INACTIVE);
      clearDraft(draftKey(user?.email, 'inactive'));
      setRestoredDraftAt((prev) => ({ ...prev, inactive: null }));
      clearScreenshots();
      navigate('/inactive?tab=active');
    },
    onError: (e) => setError(errorText(e, 'Could not submit the inactive request.'))
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      const screenshots = await buildScreenshots();
      return submitTransfer({
        mid: transfer.mid.trim(), studentName: transfer.studentName.trim(),
        batchName: transfer.batchName.trim() || undefined, facultyName: transfer.facultyName.trim() || undefined,
        phone1: transfer.phone1.trim(),
        phone2: transfer.phone2.trim() || undefined, phone3: transfer.phone3.trim() || undefined,
        transferToBranch: transfer.transferToBranch, reason: transfer.reason.trim(), screenshots
      });
    },
    onSuccess: () => {
      setTransfer(EMPTY_TRANSFER);
      clearDraft(draftKey(user?.email, 'transfer'));
      setRestoredDraftAt((prev) => ({ ...prev, transfer: null }));
      clearScreenshots();
      navigate('/transfer?tab=active');
    },
    onError: (e) => setError(errorText(e, 'Could not submit the transfer request.'))
  });

  if (user?.role !== 'SCM') {
    return <div className="rounded-md bg-reject-light text-reject px-4 py-3 text-sm">Only SCM can create new workflow entries.</div>;
  }

  function validateCommon(form: CommonForm) {
    if (!form.mid.trim() || !form.studentName.trim() || !form.phone1.trim() || !form.phone2.trim() || !form.reason.trim()) {
      return 'MID, Student Name, Phone 1 (student), Phone 2 (parent 1) and Reason are required.';
    }
    const phones = [form.phone1.trim(), form.phone2.trim(), form.phone3.trim()].filter(Boolean);
    if (phones.some((p) => !/^\d{10}$/.test(p))) {
      return 'Each phone number must contain exactly 10 digits.';
    }
    return null;
  }

  function phoneProps(value: string, required = false) {
    return {
      required,
      value,
      maxLength: 10,
      inputMode: 'numeric' as const,
      pattern: '[0-9]{10}',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => e.target.value.replace(/\D/g, '').slice(0, 10)
    };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (workflow === 'transfer') {
      const message = validateCommon(transfer);
      if (message) return setError(message);
      if (!transfer.transferToBranch) return setError('Transfer To Branch is required.');
      transferMutation.mutate();
      return;
    }

    if (workflow === 'discontinue') {
      const message = validateCommon(discontinue);
      if (message) return setError(message);
      discontinueMutation.mutate();
      return;
    }

    const message = validateCommon(inactive);
    if (message) return setError(message);
    if (!inactive.inactiveFrom) return setError('Last Present Day is required.');
    inactiveMutation.mutate();
  }

  const submitting = discontinueMutation.isPending || inactiveMutation.isPending || transferMutation.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="font-display text-2xl">New Entry</h2>
        <p className="text-sm text-ink-700/60 mt-1">Start a new student workflow from one place.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <WorkflowCard selected={workflow === 'discontinue'} onClick={() => { setWorkflow('discontinue'); setError(null); clearScreenshots(); }} title="Discontinue" description="Start a discontinuation request." icon={<Ban size={18} />} />
        <WorkflowCard selected={workflow === 'inactive'} onClick={() => { setWorkflow('inactive'); setError(null); clearScreenshots(); }} title="Inactive" description="Start an inactive-period request." icon={<Clock size={18} />} />
        <WorkflowCard selected={workflow === 'transfer'} onClick={() => { setWorkflow('transfer'); setError(null); clearScreenshots(); }} title="Transfer" description="Transfer a student to another branch." icon={<ArrowLeftRight size={18} />} />
      </div>

      {restoredDraftAt[workflow] && (
        <div className="rounded-md bg-amber-light text-ink-900 text-sm px-3 py-2 flex items-center justify-between gap-3">
          <span>
            Restored a draft you were typing at{' '}
            {new Date(restoredDraftAt[workflow]!).toLocaleString()} - nothing was lost.
            {' '}(Attached images aren't part of the draft; re-attach them if needed.)
          </span>
          <button
            type="button"
            onClick={() => discardDraft(workflow)}
            className="shrink-0 text-xs underline text-ink-700/70 hover:text-ink"
          >
            Discard draft
          </button>
        </div>
      )}

      {workflow === 'transfer' ? (
        <form onSubmit={submit} className="rounded-lg border border-ink-100 bg-white p-6 shadow-panel space-y-5">
          <div><h3 className="font-display text-lg">New Transfer Entry</h3><p className="text-sm text-ink-700/60 mt-1">This request will be sent to Head Office and then Admin for approval.</p></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="MID" required><input required value={transfer.mid} onChange={e => setTransfer(v => ({ ...v, mid: e.target.value }))} className={inputClass} /></Field>
            <Field label="Student name" required><input required value={transfer.studentName} onChange={e => setTransfer(v => ({ ...v, studentName: e.target.value }))} className={inputClass} /></Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Batch Name"><input value={transfer.batchName} onChange={e => setTransfer(v => ({ ...v, batchName: e.target.value }))} className={inputClass} /></Field>
            <Field label="Faculty Name"><input value={transfer.facultyName} onChange={e => setTransfer(v => ({ ...v, facultyName: e.target.value }))} className={inputClass} /></Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Phone 1 (Student)" required><input {...phoneProps(transfer.phone1, true)} onChange={e => setTransfer(v => ({ ...v, phone1: e.target.value.replace(/\D/g, '').slice(0, 10) }))} className={inputClass} /></Field>
            <Field label="Phone 2 (Parent 1)" required><input {...phoneProps(transfer.phone2, true)} onChange={e => setTransfer(v => ({ ...v, phone2: e.target.value.replace(/\D/g, '').slice(0, 10) }))} className={inputClass} /></Field>
            <Field label="Phone 3 (Parent 2)"><input {...phoneProps(transfer.phone3)} onChange={e => setTransfer(v => ({ ...v, phone3: e.target.value.replace(/\D/g, '').slice(0, 10) }))} className={inputClass} /></Field>
          </div>
          <Field label="Transfer To Branch" required><select required value={transfer.transferToBranch} onChange={e => setTransfer(v => ({ ...v, transferToBranch: e.target.value }))} className={inputClass}>
            <option value="">Select branch</option>
            {(branchesQuery.data || []).filter(b => b !== user?.branch).map(b => <option key={b} value={b}>{b}</option>)}
          </select></Field>
          <Field label="Reason" required><textarea required rows={5} value={transfer.reason} onChange={e => setTransfer(v => ({ ...v, reason: e.target.value }))} className={textareaClass} /></Field>

          <div>
            <label className="block text-sm font-medium text-ink-900 mb-1.5">Supporting images (optional)</label>
            <p className="text-xs text-ink-700/50 mb-2">
              Attach one or more photos to support this transfer request, if you have any. Only Head Office and Admin can view them.
            </p>
            <input
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              multiple
              onChange={handleScreenshotChange}
              className="block w-full text-sm text-ink-700/80 file:mr-3 file:rounded-md file:border-0 file:bg-ink-900 file:text-paper file:px-3 file:py-2 file:text-sm"
            />
            <ScreenshotPreviewGrid previews={screenshotPreviews} onRemove={removeScreenshotAt} />
          </div>

          {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}
          <div className="flex items-center justify-between gap-3 pt-2">
            <DraftSavedIndicator lastSavedAt={transferAutosave.lastSavedAt} />
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => { setError(null); navigate(-1); }} className="rounded-md border border-ink-200 px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded-md bg-ink-900 text-white px-4 py-2 text-sm hover:bg-ink-700 disabled:opacity-50"><CheckCircle2 size={16} /> {submitting ? 'Submitting…' : 'Submit transfer'}</button>
            </div>
          </div>
        </form>
      ) : (
        <form onSubmit={submit} className="rounded-lg border border-ink-100 bg-white p-6 shadow-panel space-y-5">
          <div>
            <h3 className="font-display text-lg">New {workflow === 'discontinue' ? 'Discontinuation' : 'Inactive'} Entry</h3>
            <p className="text-sm text-ink-700/60 mt-1">
              {workflow === 'discontinue'
                ? 'This request will enter the existing Discontinue approval workflow.'
                : 'This request will be sent to Head Office for approval.'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="MID" required><input required value={workflow === 'discontinue' ? discontinue.mid : inactive.mid} onChange={e => workflow === 'discontinue' ? setDiscontinue(v => ({ ...v, mid: e.target.value })) : setInactive(v => ({ ...v, mid: e.target.value }))} className={inputClass} /></Field>
            <Field label="Student name" required><input required value={workflow === 'discontinue' ? discontinue.studentName : inactive.studentName} onChange={e => workflow === 'discontinue' ? setDiscontinue(v => ({ ...v, studentName: e.target.value })) : setInactive(v => ({ ...v, studentName: e.target.value }))} className={inputClass} /></Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Batch Name"><input value={workflow === 'discontinue' ? discontinue.batchName : inactive.batchName} onChange={e => workflow === 'discontinue' ? setDiscontinue(v => ({ ...v, batchName: e.target.value })) : setInactive(v => ({ ...v, batchName: e.target.value }))} className={inputClass} /></Field>
            <Field label="Faculty Name"><input value={workflow === 'discontinue' ? discontinue.facultyName : inactive.facultyName} onChange={e => workflow === 'discontinue' ? setDiscontinue(v => ({ ...v, facultyName: e.target.value })) : setInactive(v => ({ ...v, facultyName: e.target.value }))} className={inputClass} /></Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Phone 1 (Student)" required><input required maxLength={10} inputMode="numeric" pattern="[0-9]{10}" value={workflow === 'discontinue' ? discontinue.phone1 : inactive.phone1} onChange={e => { const v=e.target.value.replace(/\D/g, '').slice(0,10); workflow === 'discontinue' ? setDiscontinue(x => ({ ...x, phone1:v })) : setInactive(x => ({ ...x, phone1:v })); }} className={inputClass} /></Field>
            <Field label="Phone 2 (Parent 1)" required><input required maxLength={10} inputMode="numeric" pattern="[0-9]{10}" value={workflow === 'discontinue' ? discontinue.phone2 : inactive.phone2} onChange={e => { const v=e.target.value.replace(/\D/g, '').slice(0,10); workflow === 'discontinue' ? setDiscontinue(x => ({ ...x, phone2:v })) : setInactive(x => ({ ...x, phone2:v })); }} className={inputClass} /></Field>
            <Field label="Phone 3 (Parent 2)"><input maxLength={10} inputMode="numeric" pattern="[0-9]{10}" value={workflow === 'discontinue' ? discontinue.phone3 : inactive.phone3} onChange={e => { const v=e.target.value.replace(/\D/g, '').slice(0,10); workflow === 'discontinue' ? setDiscontinue(x => ({ ...x, phone3:v })) : setInactive(x => ({ ...x, phone3:v })); }} className={inputClass} /></Field>
          </div>

          {workflow === 'discontinue' ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Total billed"><input type="number" min="0" value={discontinue.totalBilled} onChange={e => setDiscontinue(v => ({ ...v, totalBilled: e.target.value }))} className={inputClass} /></Field>
              <Field label="Total paid"><input type="number" min="0" value={discontinue.totalPaid} onChange={e => setDiscontinue(v => ({ ...v, totalPaid: e.target.value }))} className={inputClass} /></Field>
              <Field label="Last present day"><input type="date" value={discontinue.lastPresentDay} onChange={e => setDiscontinue(v => ({ ...v, lastPresentDay: e.target.value }))} className={inputClass} /></Field>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Last Present Day" required><input type="date" required value={inactive.inactiveFrom} onChange={e => setInactive(v => ({ ...v, inactiveFrom: e.target.value }))} className={inputClass} /></Field>
            </div>
          )}

          <Field label="Reason" required><textarea required rows={5} value={workflow === 'discontinue' ? discontinue.reason : inactive.reason} onChange={e => workflow === 'discontinue' ? setDiscontinue(v => ({ ...v, reason: e.target.value })) : setInactive(v => ({ ...v, reason: e.target.value }))} className={textareaClass} /></Field>

          {workflow === 'discontinue' && (
            <div>
              <label className="block text-sm font-medium text-ink-900 mb-1.5">
                Call log screenshots (optional)
              </label>
              <p className="text-xs text-ink-700/50 mb-2">
                Upload proof you called the student to verify this reason, if you have any — you can attach
                more than one. Only Head Office and Admin can view them, and they're deleted automatically
                after final approval.
              </p>
              <input
                type="file"
                accept="image/jpeg,image/png"
                capture="environment"
                multiple
                onChange={handleScreenshotChange}
                className="block w-full text-sm text-ink-700/80 file:mr-3 file:rounded-md file:border-0 file:bg-ink-900 file:text-paper file:px-3 file:py-2 file:text-sm"
              />
              <ScreenshotPreviewGrid previews={screenshotPreviews} onRemove={removeScreenshotAt} />
            </div>
          )}

          {workflow === 'inactive' && (
            <div>
              <label className="block text-sm font-medium text-ink-900 mb-1.5">Supporting images (optional)</label>
              <p className="text-xs text-ink-700/50 mb-2">
                Attach one or more photos to support this inactive request, if you have any. Only Head Office and Admin can view them.
              </p>
              <input
                type="file"
                accept="image/jpeg,image/png"
                capture="environment"
                multiple
                onChange={handleScreenshotChange}
                className="block w-full text-sm text-ink-700/80 file:mr-3 file:rounded-md file:border-0 file:bg-ink-900 file:text-paper file:px-3 file:py-2 file:text-sm"
              />
              <ScreenshotPreviewGrid previews={screenshotPreviews} onRemove={removeScreenshotAt} />
            </div>
          )}

          {error && <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}

          <div className="flex items-center justify-between gap-3 pt-2">
            <DraftSavedIndicator lastSavedAt={autosaveByWorkflow[workflow].lastSavedAt} />
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => { setError(null); navigate(-1); }} className="rounded-md border border-ink-200 px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded-md bg-ink-900 text-white px-4 py-2 text-sm hover:bg-ink-700 disabled:opacity-50">
                <CheckCircle2 size={16} />
                {submitting ? 'Submitting…' : 'Submit entry'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function WorkflowCard({ selected, onClick, title, description, icon, disabled = false }: { selected: boolean; onClick: () => void; title: string; description: string; icon: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`text-left rounded-lg border p-4 transition-colors ${selected ? 'border-ink-900 bg-amber-light' : 'border-ink-100 bg-white hover:bg-paper'} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
      <div className="flex items-center gap-2 font-medium text-sm">{icon}{title}</div>
      <p className="text-xs text-ink-700/60 mt-1.5">{description}</p>
      {disabled && <p className="text-[11px] text-ink-700/50 mt-2">Available in Phase 3</p>}
    </button>
  );
}

/** Small "Draft autosaved HH:MM:SS" text shown next to the submit buttons, once anything has been saved. */
function DraftSavedIndicator({ lastSavedAt }: { lastSavedAt: number | null }) {
  if (!lastSavedAt) return <span />;
  return (
    <span className="text-xs text-ink-700/50">
      Draft autosaved at {new Date(lastSavedAt).toLocaleTimeString()}
    </span>
  );
}