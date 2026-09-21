import React, { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import {
  UploadCloud,
  Download,
  Trash2,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  X,
  CloudUpload,
  Loader2
} from 'lucide-react';
import {
  listAllBranches,
  getBulkTemplate,
  bulkExport,
  bulkImport,
  bulkDelete,
  runBackupNow,
  ApiError,
  type BulkWorkflow,
  type BulkSheet,
  type BulkImportResult
} from '@/lib/apiClient';
import { useBulkTasks } from '@/context/BulkTaskContext';

const WORKFLOWS: { value: BulkWorkflow; label: string }[] = [
  { value: 'discontinue', label: 'Discontinue' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'transfer', label: 'Transfer' }
];

const SHEETS: { value: BulkSheet; label: string }[] = [
  { value: 'active', label: 'Active (in progress)' },
  { value: 'completed', label: 'Completed (approved)' }
];

/** Small pill-style section wrapper so the 3 tools look like one page, not 3. */
function Section({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-ink-100 shadow-panel p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-paper p-2 border border-ink-100">
          <Icon size={18} className="text-ink-900" />
        </div>
        <div>
          <h3 className="font-display text-lg">{title}</h3>
          <p className="text-sm text-ink-700/60 mt-0.5">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Shared "which workflow" dropdown. */
function WorkflowSelect({ value, onChange }: { value: BulkWorkflow; onChange: (v: BulkWorkflow) => void }) {
  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">Workflow</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BulkWorkflow)}
        className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
      >
        {WORKFLOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Shared "which sheet" dropdown. */
function SheetSelect({ value, onChange }: { value: BulkSheet; onChange: (v: BulkSheet) => void }) {
  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">Sheet</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BulkSheet)}
        className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink-900"
      >
        {SHEETS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Checkbox-based workflow selector with "Select All" for bulk actions. */
function WorkflowCheckboxes({
  selected,
  onChange
}: {
  selected: BulkWorkflow[];
  onChange: (workflows: BulkWorkflow[]) => void;
}) {
  const allSelected = selected.length === WORKFLOWS.length;

  function toggleAll() {
    onChange(allSelected ? [] : WORKFLOWS.map((w) => w.value));
  }

  function toggleOne(workflow: BulkWorkflow) {
    if (selected.includes(workflow)) {
      onChange(selected.filter((w) => w !== workflow));
    } else {
      onChange([...selected, workflow]);
    }
  }

  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">Workflows</label>
      <div className="rounded-md border border-ink-200 bg-white p-3 space-y-1.5">
        <label className="flex items-center gap-2 text-sm font-medium text-ink pb-1.5 mb-1.5 border-b border-ink-100 select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
          />
          Select All
        </label>
        {WORKFLOWS.map((w) => (
          <label key={w.value} className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
            <input
              type="checkbox"
              checked={selected.includes(w.value)}
              onChange={() => toggleOne(w.value)}
              className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
            />
            {w.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Checkbox-based sheet selector with "Select All" for bulk actions. */
function SheetCheckboxes({
  selected,
  onChange
}: {
  selected: BulkSheet[];
  onChange: (sheets: BulkSheet[]) => void;
}) {
  const allSelected = selected.length === SHEETS.length;

  function toggleAll() {
    onChange(allSelected ? [] : SHEETS.map((s) => s.value));
  }

  function toggleOne(sheet: BulkSheet) {
    if (selected.includes(sheet)) {
      onChange(selected.filter((s) => s !== sheet));
    } else {
      onChange([...selected, sheet]);
    }
  }

  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">Sheets</label>
      <div className="rounded-md border border-ink-200 bg-white p-3 space-y-1.5">
        <label className="flex items-center gap-2 text-sm font-medium text-ink pb-1.5 mb-1.5 border-b border-ink-100 select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
          />
          Select All
        </label>
        {SHEETS.map((s) => (
          <label key={s.value} className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
            <input
              type="checkbox"
              checked={selected.includes(s.value)}
              onChange={() => toggleOne(s.value)}
              className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
            />
            {s.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Multi-select branch checkboxes with an "All branches" shortcut. */
function BranchPicker({
  branches,
  selected,
  onChange
}: {
  branches: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const allSelected = selected.includes('ALL');

  function toggleAll() {
    // Clicking "All branches" again un-checks it, leaving nothing selected
    // (instead of always staying "all" - see Data page required-selection
    // check before Download/Delete run).
    onChange(allSelected ? [] : ['ALL']);
  }

  function toggleOne(name: string) {
    if (allSelected) {
      onChange([name]);
      return;
    }
    if (selected.includes(name)) {
      onChange(selected.filter((b) => b !== name));
    } else {
      onChange([...selected, name]);
    }
  }

  return (
    <div>
      <label className="block text-sm text-ink-700/80 mb-1">Branches</label>
      <div className="rounded-md border border-ink-200 bg-white p-3 max-h-56 overflow-y-auto space-y-1.5">
        <label className="flex items-center gap-2 text-sm font-medium text-ink pb-1.5 mb-1.5 border-b border-ink-100 select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
          />
          All branches
        </label>
        {branches.map((name) => (
          <label key={name} className="flex items-center gap-2 text-sm text-ink-700/80 select-none">
            <input
              type="checkbox"
              checked={allSelected ? true : selected.includes(name)}
              onChange={() => toggleOne(name)}
              className="rounded border-ink-200 text-ink-900 focus:ring-ink-900"
            />
            {name}
          </label>
        ))}
        {branches.length === 0 && <p className="text-sm text-ink-700/50 px-1 py-2">No branches yet.</p>}
      </div>
    </div>
  );
}

export default function Data() {
  const branchesQuery = useQuery({ queryKey: ['branches', 'all'], queryFn: listAllBranches });
  const branchNames = useMemo(
    () => (branchesQuery.data || []).map((b) => b.name).sort((a, b) => a.localeCompare(b)),
    [branchesQuery.data]
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <div className="shrink-0">
        <h2 className="font-display text-2xl">Data</h2>
        <p className="text-sm text-ink-700/60 mt-1">
          Upload, download, or delete many records at once, across any workflow and branch -
          plus the Google Sheet backup. Admin only.
        </p>
      </div>

      <div className="shrink-0">
        <BackupSection />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
        <DownloadSection branchNames={branchNames} />
        <UploadSection branchNames={branchNames} />
        <DeleteSection branchNames={branchNames} />
      </div>
    </div>
  );
}

/* ============================== BACKUP ============================== */

/** Item 5: lets Admin manually trigger the daily Google Sheet backup right now, instead of waiting for the 1:00 AM schedule. */
function BackupSection() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const mutation = useMutation({
    mutationFn: runBackupNow,
    onSuccess: (data) => {
      setResult({ ok: true, message: `Backup complete - ${data.totalRows} row(s) appended to the Google Sheet.` });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Backup failed - see server logs for details.';
      setResult({ ok: false, message });
    }
  });

  return (
    <Section
      icon={CloudUpload}
      title="Google Sheet backup"
      description="Runs the same daily backup job that's scheduled for 1:00 AM (IST) - useful to confirm it's working, or right before doing something risky."
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            setResult(null);
            mutation.mutate();
          }}
          disabled={mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-ink-900 text-white px-4 py-2 text-sm font-medium hover:bg-ink-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <CloudUpload size={16} />}
          {mutation.isPending ? 'Backing up...' : 'Run backup now'}
        </button>
        {result && (
          <p className={`text-sm flex items-center gap-1.5 ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
            {result.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            {result.message}
          </p>
        )}
      </div>
    </Section>
  );
}

/* ============================== DOWNLOAD ============================== */

function DownloadSection({ branchNames }: { branchNames: string[] }) {
  const [workflows, setWorkflows] = useState<BulkWorkflow[]>(['discontinue']);
  const [sheets, setSheets] = useState<BulkSheet[]>(['active']);
  const [branches, setBranches] = useState<string[]>(['ALL']);
  const [error, setError] = useState<string | null>(null);
  const { runTask } = useBulkTasks();

  function startDownload() {
    setError(null);
    if (workflows.length === 0) {
      setError('Select at least one workflow.');
      return;
    }
    if (sheets.length === 0) {
      setError('Select at least one sheet.');
      return;
    }
    if (branches.length === 0) {
      setError('Select at least one branch, or check "All branches".');
      return;
    }

    const combos: { workflow: BulkWorkflow; sheet: BulkSheet }[] = [];
    for (const workflow of workflows) for (const sheet of sheets) combos.push({ workflow, sheet });
    const workflowLabels = workflows.map((w) => WORKFLOWS.find((x) => x.value === w)?.label).join(', ');

    // Runs in the background tray - the user can leave this page and the
    // file will still be built and downloaded once ready.
    runTask({
      type: 'download',
      label: `Download - ${workflowLabels}`,
      run: async (update) => {
        const allResults: { rows: Record<string, unknown>[]; columns: string[]; workflow: BulkWorkflow; sheet: BulkSheet }[] = [];

        for (let i = 0; i < combos.length; i++) {
          const { workflow, sheet } = combos[i];
          update({
            indeterminate: false,
            progress: Math.round((i / combos.length) * 90),
            message: `Fetching ${workflow} / ${sheet}\u2026`
          });
          const result = await bulkExport(workflow, sheet, branches);
          allResults.push({ rows: result.rows, columns: result.columns, workflow, sheet });
        }

        const totalRows = allResults.reduce((sum, r) => sum + r.rows.length, 0);
        if (totalRows === 0) {
          throw new Error('No rows match that selection - nothing to download.');
        }

        update({ progress: 95, message: 'Building the file\u2026' });

        const workbook = XLSX.utils.book_new();
        allResults.forEach(({ rows, columns, workflow, sheet }) => {
          if (rows.length > 0) {
            const sheetName = `${workflow}-${sheet}`.substring(0, 31); // Excel sheet name limit
            const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
            worksheet['!cols'] = columns.map((h) => ({
              wch: Math.min(Math.max(h.length + 2, 10), 40)
            }));
            XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
          }
        });

        const stamp = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(workbook, `bulk-export-${stamp}.xlsx`);

        return { message: `${totalRows} row(s) downloaded.` };
      }
    });
  }

  return (
    <Section
      icon={Download}
      title="Download"
      description="Pick one or more workflows and sheets, select branches, then download the matching records as an Excel file (with separate tabs for each combination)."
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <WorkflowCheckboxes selected={workflows} onChange={setWorkflows} />
        <SheetCheckboxes selected={sheets} onChange={setSheets} />
      </div>
      <BranchPicker branches={branchNames} selected={branches} onChange={setBranches} />

      {error && (
        <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <button
        onClick={startDownload}
        className="flex items-center gap-1.5 rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
      >
        <Download size={15} />
        Download .xlsx
      </button>
      <p className="text-xs text-ink-700/50">
        Runs in the background - progress shows in the bottom-right corner, and you're free to
        keep working on other pages while it finishes.
      </p>
    </Section>
  );
}

/* =============================== UPLOAD ================================ */

function UploadSection({ branchNames }: { branchNames: string[] }) {
  const [workflow, setWorkflow] = useState<BulkWorkflow>('discontinue');
  const [sheet, setSheet] = useState<BulkSheet>('active');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { runTask } = useBulkTasks();

  const templateMutation = useMutation({
    mutationFn: () => getBulkTemplate(workflow),
    onSuccess: (tpl) => {
      const worksheet = XLSX.utils.aoa_to_sheet([tpl.columns]);
      worksheet['!cols'] = tpl.columns.map((h) => ({ wch: Math.min(Math.max(h.length + 2, 12), 30) }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');
      XLSX.writeFile(workbook, `${workflow}-upload-template.xlsx`);
    }
  });

  function startImport(rows: Record<string, unknown>[], label: string) {
    runTask({
      type: 'upload',
      label,
      run: async () => {
        let res: BulkImportResult;
        try {
          res = await bulkImport(workflow, sheet, rows);
        } catch (err) {
          throw new Error(err instanceof ApiError ? err.message || 'Upload failed.' : 'Upload failed. Please try again.');
        }

        const message = `${res.inserted} of ${res.total} row(s) uploaded${res.skipped > 0 ? ` \u00b7 ${res.skipped} skipped` : ''}.`;
        const detail = <ImportResultDetail result={res} />;
        return { message, detail };
      }
    });
  }

  function handleFile(file: File) {
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const sheetData = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheetData, { defval: '' });
        if (rows.length === 0) {
          setError('That file has no data rows.');
          return;
        }
        startImport(rows, `Upload - ${file.name}`);
      } catch {
        setError('Could not read that file. Make sure it is a valid .xlsx or .csv file.');
      }
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsBinaryString(file);
  }

  return (
    <Section
      icon={UploadCloud}
      title="Upload"
      description="Add many records at once from an Excel/CSV file. Not sure of the format? Download a blank template first."
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <WorkflowSelect value={workflow} onChange={setWorkflow} />
        <SheetSelect value={sheet} onChange={setSheet} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => templateMutation.mutate()}
          disabled={templateMutation.isPending}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors disabled:opacity-60"
        >
          <FileSpreadsheet size={15} />
          {templateMutation.isPending ? 'Preparing…' : 'Download blank template'}
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 rounded-md bg-ink-900 text-paper px-4 py-2 text-sm hover:bg-ink-700 transition-colors"
        >
          <UploadCloud size={15} />
          Choose file to upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
        {fileName && <span className="text-sm text-ink-700/50">{fileName}</span>}
      </div>

      <p className="text-xs text-ink-700/50">
        The file's first row must be column headers matching the template exactly (MID, Branch,
        Student Name, phone numbers, etc). Rows with a duplicate MID or a missing required field
        are skipped and reported in the upload's progress card - the rest still get uploaded.
        Runs in the background, so you can keep working elsewhere while it finishes.
      </p>

      {error && (
        <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
    </Section>
  );
}

/** Rendered inside the bottom-right progress tray once an upload finishes. */
function ImportResultDetail({ result }: { result: BulkImportResult }) {
  const skippedRows = result.results.filter((r) => r.status === 'skipped');
  const warnedRows = result.results.filter((r) => r.status === 'inserted' && r.warning);

  if (skippedRows.length === 0 && warnedRows.length === 0) {
    return <p className="text-xs text-ink-700/50">No issues - every row uploaded cleanly.</p>;
  }

  return (
    <div className="space-y-2">
      {skippedRows.length > 0 && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-700/50 mb-1">Skipped rows</p>
          <ul className="text-xs space-y-1">
            {skippedRows.map((r) => (
              <li key={r.row} className="flex items-start gap-1.5 text-reject">
                <XCircle size={12} className="mt-0.5 shrink-0" />
                <span>
                  Row {r.row} ({r.mid}): {r.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnedRows.length > 0 && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-700/50 mb-1">Warnings</p>
          <ul className="text-xs space-y-1">
            {warnedRows.map((r) => (
              <li key={r.row} className="flex items-start gap-1.5 text-amber">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  Row {r.row} ({r.mid}): {r.warning}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* =============================== DELETE ================================ */

function DeleteSection({ branchNames }: { branchNames: string[] }) {
  const [workflows, setWorkflows] = useState<BulkWorkflow[]>(['discontinue']);
  const [sheets, setSheets] = useState<BulkSheet[]>(['active']);
  const [branches, setBranches] = useState<string[]>(['ALL']);
  const [confirmText, setConfirmText] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runTask } = useBulkTasks();

  function startDelete() {
    const combos: { workflow: BulkWorkflow; sheet: BulkSheet }[] = [];
    for (const workflow of workflows) for (const sheet of sheets) combos.push({ workflow, sheet });
    const workflowLabels = workflows.map((w) => WORKFLOWS.find((x) => x.value === w)?.label).join(', ');

    setConfirmOpen(false);
    setConfirmText('');

    // Deletion itself runs in the background tray once confirmed - closing
    // this dialog doesn't cancel it.
    runTask({
      type: 'delete',
      label: `Delete - ${workflowLabels}`,
      run: async (update) => {
        let deleted = 0;
        for (let i = 0; i < combos.length; i++) {
          const { workflow, sheet } = combos[i];
          update({
            indeterminate: false,
            progress: Math.round((i / combos.length) * 100),
            message: `Deleting ${workflow} / ${sheet}\u2026`
          });
          const result = await bulkDelete(workflow, sheet, branches, 'DELETE');
          deleted += result.deleted;
        }
        return { message: `Deleted ${deleted} row(s).` };
      }
    });
  }

  const workflowSummary = workflows.map((workflow) => WORKFLOWS.find((w) => w.value === workflow)?.label).join(', ');
  const sheetSummary = sheets.map((sheet) => SHEETS.find((s) => s.value === sheet)?.label).join(', ');
  const branchSummary = branches.includes('ALL') ? 'all branches' : branches.join(', ');

  return (
    <Section
      icon={Trash2}
      title="Delete"
      description="Permanently delete every record matching a workflow, sheet, and branch selection. This cannot be undone."
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <WorkflowCheckboxes selected={workflows} onChange={setWorkflows} />
        <SheetCheckboxes selected={sheets} onChange={setSheets} />
      </div>
      <BranchPicker branches={branchNames} selected={branches} onChange={setBranches} />

      {error && (
        <div className="rounded-md bg-reject-light text-reject text-sm px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      <p className="text-xs text-ink-700/50">
        Runs in the background once confirmed - progress shows in the bottom-right corner.
      </p>

      <button
        onClick={() => {
          setError(null);
          if (workflows.length === 0) {
            setError('Select at least one workflow.');
            return;
          }
          if (sheets.length === 0) {
            setError('Select at least one sheet.');
            return;
          }
          if (branches.length === 0) {
            setError('Select at least one branch, or check "All branches".');
            return;
          }
          setConfirmOpen(true);
        }}
        className="flex items-center gap-1.5 rounded-md bg-reject text-white px-4 py-2 text-sm hover:bg-reject/90 transition-colors"
      >
        <Trash2 size={15} />
        Delete matching records
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4 py-8 overflow-y-auto">
          <div className="relative w-full max-w-md bg-white rounded-lg shadow-panel border border-ink-100 p-6">
            <button
              onClick={() => setConfirmOpen(false)}
              className="absolute right-4 top-4 text-ink-700/40 hover:text-ink-700 transition-colors"
            >
              <X size={18} />
            </button>
            <h3 className="font-display text-xl mb-2">Confirm bulk delete</h3>
            <p className="text-sm text-ink-700/70 mb-4">
              This permanently deletes every <span className="font-medium text-ink">{workflowSummary}</span>{' '}
              record in the <span className="font-medium text-ink">{sheetSummary}</span> sheet(s) for{' '}
              <span className="font-medium text-ink">{branchSummary}</span>. This cannot be undone.
              Type <span className="font-mono font-medium text-ink">DELETE</span> to confirm.
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-reject"
            />
            <div className="flex gap-3">
              <button
                disabled={confirmText !== 'DELETE'}
                onClick={startDelete}
                className="rounded-md px-4 py-2 text-sm transition-colors disabled:opacity-40 bg-reject text-white hover:bg-reject/90"
              >
                Permanently delete
              </button>
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700/80 hover:bg-paper transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}