import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X, Check, XCircle, Pencil, Trash2, ChevronLeft, ChevronRight, Loader2, Download, FileText, FileSpreadsheet, FileDown, Copy, CheckCheck, ChevronDown, ImageIcon } from 'lucide-react';
import { listTransfer, scmCorrectTransfer, headOfficeUpdateTransfer, headOfficeApproveTransfer, headOfficeRejectTransfer, approveTransfer, rejectTransfer, deleteTransfer, getTransferScreenshotUrl, markPageSeen, listBranches, ApiError } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import type { TransferEntry, TransferStatus } from '@/types';
import { TRANSFER_STATUS_LABELS } from '@/types';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const PAGE_SIZE_OPTIONS = [15,25,50,100] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];
const STATUS_STYLES: Record<TransferStatus,string> = {
  TRANSFER_PENDING_HEAD_OFFICE:'bg-amber-light text-amber',
  TRANSFER_PENDING_ADMIN:'bg-amber-light text-amber',
  TRANSFER_PENDING_SCM:'bg-reject-light text-reject',
  TRANSFER_APPROVED:'bg-approve-light text-approve'
};
function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiError) {
    const m: Record<string,string> = {
      AUTH_FORBIDDEN:"You don't have permission to do this, or this request has already moved to another stage.",
      STUDENT_NOT_FOUND:'This transfer request could not be found.',
      MID_ALREADY_EXISTS:'A transfer request already exists for this MID.',
      BAD_REQUEST:'Please check the entered information.',
      AUTH_INVALID_TOKEN:'Your session has expired. Please sign in again.'
    };
    return m[e.code] || `${fallback} (${e.code})`;
  }
  return fallback;
}
function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}) {
  return <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
    <div className="w-full max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px] overflow-auto resize rounded-lg bg-white border border-ink-100 shadow-panel" style={{width:'36rem'}} onClick={(e)=>e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink-100"><h2 className="font-display text-lg">{title}</h2><button onClick={onClose} className="p-1.5 rounded-md hover:bg-paper"><X size={18}/></button></div>
      {children}
    </div>
  </div>;
}
type Form = {mid:string;studentName:string;phone1:string;phone2:string;phone3:string;transferToBranch:string;reason:string};
const emptyForm:Form={mid:'',studentName:'',phone1:'',phone2:'',phone3:'',transferToBranch:'',reason:''};
function toForm(r:TransferEntry):Form { return {mid:r.MID||'',studentName:r['Student Name']||'',phone1:r['Phone Number 1']||'',phone2:r['Phone Number 2']||'',phone3:r['Phone Number 3']||'',transferToBranch:r['Transfer To Branch']||'',reason:r.Reason||''}; }


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
      const { urls } = await getTransferScreenshotUrl(mid, sheet);
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
      const { urls } = await getTransferScreenshotUrl(mid, sheet);
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

function TransferReasonBox({ value, defaultOpen }: { value?: string; defaultOpen?: boolean }) {
  return <details open={defaultOpen} className="rounded-lg border border-ink-100 bg-white overflow-hidden">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium flex items-center justify-between hover:bg-paper">
      <span>Reason</span><ChevronDown size={16} className="text-ink-700/40"/>
    </summary>
    <div className="border-t border-ink-100 p-3">
      <div className="max-h-48 min-h-[80px] overflow-y-auto resize-y whitespace-pre-wrap break-words text-sm leading-6 text-ink-700/80">{value?.trim() || <span className="italic text-ink-700/30">Not yet provided</span>}</div>
    </div>
  </details>;
}

function ModalShell({children,onClose}:{children:React.ReactNode;onClose:()=>void}) {
  return <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4 py-8 overflow-y-auto" onClick={onClose}>
    <div
      className="relative w-full bg-white rounded-lg shadow-panel border border-ink-100 p-6 my-auto resize overflow-auto max-w-[95vw] max-h-[90vh] min-w-[300px] min-h-[160px]"
      style={{ width: 'min(42rem, 95vw)' }}
      onClick={(e)=>e.stopPropagation()}
    >
      <button onClick={onClose} className="absolute right-4 top-4 text-ink-700/40 hover:text-ink-700 transition-colors"><X size={18}/></button>
      {children}
    </div>
  </div>;
}

function TransferDetailsModal({
  row, userRole, sheet, onEdit, onApproveHeadOffice, onReject, onApproveAdmin, onDelete, onClose
}: {
  row: TransferEntry; userRole?: string; sheet: 'response' | 'completed'; onEdit:()=>void; onApproveHeadOffice:()=>void; onReject:()=>void;
  onApproveAdmin:()=>void; onDelete:()=>void; onClose:()=>void;
}) {
  const [copied,setCopied]=useState<string|null>(null);
  async function copy(phone?:string){if(!phone)return;try{await navigator.clipboard.writeText(phone);setCopied(phone);setTimeout(()=>setCopied(null),1200)}catch{}}
  const isHO=userRole==='Head Office'; const isAdmin=userRole==='Admin';
  return <ModalShell onClose={onClose}>
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
            <p><span className="text-ink-700/50">From branch:</span> {row.Branch}</p>
            <p><span className="text-ink-700/50">Transfer to:</span> {row['Transfer To Branch']}</p>
            <p><span className="text-ink-700/50">Status:</span> {TRANSFER_STATUS_LABELS[row.Status]||row.Status}</p>
          </div>
        </div>
        <div className="rounded-lg border border-ink-100 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Phone numbers</p>
          {[['Phone 1 — Student',row['Phone Number 1']],['Phone 2 — Parent 1',row['Phone Number 2']],['Phone 3 — Parent 2',row['Phone Number 3']]].map(([label,phone])=>phone?<div key={String(label)} className="flex items-center justify-between py-1.5"><div><span className="block text-xs text-ink-700/50">{label}</span><span className="font-mono text-sm">{phone}</span></div><button onClick={e=>{e.stopPropagation();copy(String(phone))}} className="inline-flex items-center gap-1 text-xs text-ink-700/60 hover:text-ink-900">{copied===phone?<CheckCheck size={14} className="text-approve"/>:<Copy size={14}/>} {copied===phone?'Copied':'Copy'}</button></div>:null)}
        </div>
        <div className="rounded-lg border border-ink-100 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-700/50 mb-2">Request information</p>
          <div className="space-y-1.5 text-sm">
            <p><span className="text-ink-700/50">Transfer Request Date:</span> {row['Entry Date']||'—'}</p>
            {/* Head Office is a workflow stage BEFORE Admin, not the final approver -
                shown only when Head Office has actually recorded an action. */}
            {row['Head Office Decision'] ? (
              <>
                <p><span className="text-ink-700/50">Head Office Action:</span> {row['Head Office Decision']}</p>
                <p><span className="text-ink-700/50">Head Office By:</span> {row['Head Office Name']||'—'}</p>
                <p><span className="text-ink-700/50">Head Office Date:</span> {row['Head Office Date']||'—'}</p>
              </>
            ) : (
              <p><span className="text-ink-700/50">Head Office Action:</span> Pending</p>
            )}
            {/* Admin is always the FINAL approver. */}
            <p className="pt-1 border-t border-ink-100"><span className="text-ink-700/50">Admin Final Approval Name:</span> {row['Admin Approval']==='APPROVED' ? (row['Admin Name']||'—') : '—'}</p>
            <p><span className="text-ink-700/50">Admin Final Approval Date:</span> {row['Admin Approval']==='APPROVED' ? (row['Approval Date']||'—') : '—'}</p>
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-ink-700/50">Reasons</p>
          {(isAdmin||isHO) && row['Screenshot Uploaded'] && <ViewAttachmentButton mid={row.MID} sheet={sheet}/>}
        </div>
        <TransferReasonBox value={row.Reason} defaultOpen={isAdmin||isHO}/>
        {row['Last Rejection Reason']&&<TransferReasonBox value={row['Last Rejection Reason']} defaultOpen={isAdmin||isHO}/>}
      </div>
      <div className="flex flex-wrap gap-2 pt-4 border-t border-ink-100">
        {isHO && row.canHeadOfficeApprove && <button onClick={()=>onApproveHeadOffice()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm"><Check size={14}/>Approve</button>}
        {isHO && row.canHeadOfficeReject && <button onClick={()=>onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14}/>Reject</button>}
        {isHO && row.canHeadOfficeApprove && <button onClick={()=>onEdit()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm"><Pencil size={14}/>Edit full record</button>}
        {isAdmin && row.canAdminApprove && <button onClick={()=>onApproveAdmin()} className="inline-flex items-center gap-1.5 rounded-md bg-approve text-white px-3 py-1.5 text-sm"><Check size={14}/>Approve</button>}
        {isAdmin && row.canAdminReject && <button onClick={()=>onReject()} className="inline-flex items-center gap-1.5 rounded-md bg-reject text-white px-3 py-1.5 text-sm"><XCircle size={14}/>Reject</button>}
        {userRole==='SCM' && row.canEdit && <button onClick={()=>onEdit()} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm"><Pencil size={14}/>Correct & resubmit</button>}
        {(isAdmin||isHO) && row.canDelete && <button onClick={()=>onDelete()} className="inline-flex items-center gap-1.5 rounded-md border border-reject/30 text-reject px-3 py-1.5 text-sm"><Trash2 size={14}/>Delete</button>}
      </div>
    </div>
  </ModalShell>;
}

export default function Transfer() {
  const {user}=useAuth(); const qc=useQueryClient(); const [sp,setSp]=useSearchParams();
  const [tab,setTab]=useState<'active'|'completed'>(sp.get('tab')==='completed'?'completed':'active');
  const [search,setSearch]=useState(sp.get('search')||''); const [branchFilter,setBranchFilter]=useState('');
  const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState<PageSize>(15);
  const [editTarget,setEditTarget]=useState<TransferEntry|null>(null); const [form,setForm]=useState<Form>(emptyForm);
  const [rejectTarget,setRejectTarget]=useState<TransferEntry|null>(null); const [rejectReason,setRejectReason]=useState('');
  const [deleteTarget,setDeleteTarget]=useState<TransferEntry|null>(null); const [deleteConfirmText,setDeleteConfirmText]=useState(''); const [selectedTransfer,setSelectedTransfer]=useState<TransferEntry|null>(null); const [error,setError]=useState<string|null>(null); const [exporting,setExporting]=useState(false);

  React.useEffect(()=>{const t=sp.get('tab')==='completed'?'completed':'active';if(t!==tab){setTab(t);setPage(1)} const q=sp.get('search')||'';if(q!==search){setSearch(q);setPage(1)}},[sp]); // eslint-disable-line react-hooks/exhaustive-deps
  // Item 7: opening Transfer clears its sidebar "unseen" badge.
  React.useEffect(()=>{markPageSeen('transfer').then(()=>qc.invalidateQueries({queryKey:['activeCounts']})).catch(()=>{})},[]); // eslint-disable-line react-hooks/exhaustive-deps
  const params=useMemo(()=>({search:search.trim()||undefined,branch:branchFilter||undefined,page,pageSize}),[search,branchFilter,page,pageSize]);
  const showBranch=user?.role==='Head Office'; // Head Office sees every branch, so show which one each row belongs to
  const branchesQuery=useQuery({queryKey:['branches'],queryFn:listBranches,enabled:user?.role==='Admin'||user?.role==='Head Office'});
  const query=useQuery({queryKey:['transfer',tab,params],queryFn:()=>listTransfer(tab==='completed'?'completed':'response',params),enabled:!!user});
  const refresh=()=>{qc.invalidateQueries({queryKey:['transfer']});qc.invalidateQueries({queryKey:['notifications']});qc.invalidateQueries({queryKey:['activeCounts']});};
  const hoEdit=useMutation({
    mutationFn:()=>headOfficeUpdateTransfer(editTarget!.MID,{'MID':form.mid,'Student Name':form.studentName,'Phone Number 1':form.phone1,'Phone Number 2':form.phone2||undefined,'Phone Number 3':form.phone3||undefined,'Transfer To Branch':form.transferToBranch,Reason:form.reason}),
    onSuccess:()=>{setEditTarget(null);setForm(emptyForm);refresh()},
    onError:e=>setError(errorText(e,'Could not save the Head Office edit.'))
  });
  const hoApprove=useMutation({mutationFn:(mid:string)=>headOfficeApproveTransfer(mid),onSuccess:refresh,onError:e=>setError(errorText(e,'Could not approve the transfer.'))});
  const adminApprove=useMutation({mutationFn:(mid:string)=>approveTransfer(mid),onSuccess:refresh,onError:e=>setError(errorText(e,'Could not approve the transfer.'))});
  const reject=useMutation({mutationFn:()=>rejectTarget ? (user?.role==='Head Office' ? headOfficeRejectTransfer(rejectTarget.MID,rejectReason) : rejectTransfer(rejectTarget.MID,rejectReason)) : Promise.reject(new Error('Invalid rejection target')),onSuccess:()=>{setRejectTarget(null);setRejectReason('');refresh()},onError:e=>setError(errorText(e,'Could not reject the transfer.'))});
  const correction=useMutation({mutationFn:()=>scmCorrectTransfer(editTarget!.MID,{'MID':form.mid,'Student Name':form.studentName,'Phone Number 1':form.phone1,'Phone Number 2':form.phone2,'Phone Number 3':form.phone3,'Transfer To Branch':form.transferToBranch,Reason:form.reason}),onSuccess:()=>{setEditTarget(null);setForm(emptyForm);refresh()},onError:e=>setError(errorText(e,'Could not resubmit the correction.'))});
  const del=useMutation({mutationFn:()=>deleteTransfer(deleteTarget!.MID,tab==='completed'?'completed':'response',deleteConfirmText.trim()),onSuccess:()=>{setDeleteTarget(null);setDeleteConfirmText('');refresh()},onError:e=>setError(errorText(e,'Could not delete the transfer.'))});

  const rows=query.data?.rows||[]; const total=query.data?.total||0; const pages=Math.max(1,Math.ceil(total/pageSize));
  const canExport=user?.role==='Admin'||user?.role==='Head Office';

  async function exportData(format:'csv'|'xlsx'|'pdf') {
    if(!canExport) return; setExporting(true); setError(null);
    try {
      const all:TransferEntry[]=[]; let pg=1; let totalRows=0;
      do { const r=await listTransfer(tab==='completed'?'completed':'response',{search:search.trim()||undefined,branch:branchFilter||undefined,page:pg,pageSize:200}); all.push(...r.rows); totalRows=r.total; pg++; if(!r.rows.length)break; } while(all.length<totalRows);
      if(!all.length){setError('There are no records to download for the current filters.');return;}
      const out=all.map(r=>({'Sl No':r['Sl No'],Branch:r.Branch,MID:r.MID,'Student Name':r['Student Name'],'Phone Number 1':r['Phone Number 1'],'Phone Number 2':r['Phone Number 2']||'','Phone Number 3':r['Phone Number 3']||'','Transfer To Branch':r['Transfer To Branch'],Reason:r.Reason,Status:TRANSFER_STATUS_LABELS[r.Status]||r.Status,'Entry Date':r['Entry Date']||'','Head Office Decision':r['Head Office Decision']||'','Head Office Name':r['Head Office Name']||'','Head Office Date':r['Head Office Date']||'','Admin Approval':r['Admin Approval']||'','Admin Name':r['Admin Name']||'','Approval Date':r['Approval Date']||'','Last Rejection Reason':r['Last Rejection Reason']||'','Last Rejected By':r['Last Rejected By']||'','Last Rejected Stage':r['Last Rejected Stage']||'','Last Rejected Date':r['Last Rejected Date']||''}));
      const base=`transfer_${tab==='completed'?'approved':'active'}_${new Date().toISOString().slice(0,10)}`;
      if(format==='csv'){const h=Object.keys(out[0]);const esc=(v:unknown)=>{const x=v==null?'':String(v);return /[",\n]/.test(x)?`"${x.replace(/"/g,'""')}"`:x};const csv=[h.join(','),...out.map(r=>h.map(k=>esc(r[k as keyof typeof r])).join(','))].join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));a.download=`${base}.csv`;a.click();}
      else if(format==='xlsx'){const ws=XLSX.utils.json_to_sheet(out);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,tab==='completed'?'Approved':'Active');XLSX.writeFile(wb,`${base}.xlsx`);}
      else {const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});autoTable(doc,{head:[Object.keys(out[0])],body:out.map(r=>Object.values(r)),styles:{fontSize:6},headStyles:{fontSize:6},margin:{top:12,right:5,bottom:10,left:5}});doc.save(`${base}.pdf`);}
    } catch(e){setError(errorText(e,'Could not export. Please try again.'));} finally{setExporting(false);}
  }

  function openEdit(r:TransferEntry){setEditTarget(r);setForm(toForm(r));}
  function updateUrl(next:'active'|'completed'){setTab(next);setPage(1);const n=new URLSearchParams(sp);if(next==='completed')n.set('tab','completed');else n.delete('tab');setSp(n,{replace:true});}

  return <div className="space-y-5">
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
      <div><h2 className="font-display text-2xl">Transfer Students</h2><p className="text-sm text-ink-700/60 mt-1">SCM submits transfer requests for Head Office and Admin approval.</p></div>
      {canExport && <div className="flex gap-2">
        <button disabled={exporting} onClick={()=>exportData('csv')} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm hover:bg-paper disabled:opacity-50"><FileText size={15}/>CSV</button>
        <button disabled={exporting} onClick={()=>exportData('xlsx')} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm hover:bg-paper disabled:opacity-50"><FileSpreadsheet size={15}/>Excel</button>
        <button disabled={exporting} onClick={()=>exportData('pdf')} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm hover:bg-paper disabled:opacity-50"><FileDown size={15}/>PDF</button>
      </div>}
    </div>
    <div className="rounded-lg border border-ink-100 bg-white shadow-panel overflow-hidden">
      <div className="p-4 border-b border-ink-100 flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700/40"/><input value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}} placeholder="Search MID, name or phone..." className="w-full pl-9 pr-3 py-2 rounded-md border border-ink-100 text-sm"/></div>
        {(user?.role==='Admin'||user?.role==='Head Office') && <select value={branchFilter} onChange={e=>{setBranchFilter(e.target.value);setPage(1)}} className="rounded-md border border-ink-100 px-3 py-2 text-sm"><option value="">All branches</option>{(branchesQuery.data||[]).map(b=><option key={b} value={b}>{b}</option>)}</select>}
      </div>
      {error && <div className="m-4 rounded-md bg-reject-light text-reject text-sm px-3 py-2">{error}</div>}
      {query.isLoading ? <div className="p-10 text-center text-sm text-ink-700/60"><Loader2 className="animate-spin inline mr-2" size={16}/>Loading...</div> :
      rows.length===0 ? <div className="p-10 text-center text-sm text-ink-700/60">No transfer records found.</div> :
      (() => {
        // Split into a "Needs Your Attention" table (rows actually
        // awaiting THIS user's action) plus the regular table with
        // everything else. Only relevant on the active tab - once
        // nothing is left awaiting this user, only the single full
        // table remains.
        const attentionRows = tab==='active' ? rows.filter(r=>r['Awaiting My Action']) : [];
        const hasAttention = attentionRows.length>0;
        const mainRows = hasAttention ? rows.filter(r=>!r['Awaiting My Action']) : rows;

        const renderTransferRows = (list: TransferEntry[], emptyMessage: string) => (
          <tbody className="divide-y divide-ink-100">
            {list.length===0 && <tr><td colSpan={showBranch?7:6} className="px-4 py-8 text-center text-ink-700/50 text-sm">{emptyMessage}</td></tr>}
            {list.map((r,i)=>
              <tr key={`${r.MID}-${r['Sl No']}`} onClick={()=>setSelectedTransfer(r)} className="hover:bg-paper/50 cursor-pointer">
                <td className="px-4 py-3 text-ink-700/50">{(page-1)*pageSize+i+1}</td>
                <td className="px-4 py-3 font-medium">{r.MID}</td>
                <td className="px-4 py-3 font-medium">{r['Student Name']}</td>
                {showBranch && <td className="px-4 py-3 text-ink-700/70">{r.Branch||'—'}</td>}
                <td className="px-4 py-3 text-ink-700/70">{[r['Phone Number 1'],r['Phone Number 2'],r['Phone Number 3']].filter(Boolean).map((p,j)=><div key={j} className="font-mono text-xs">{p}</div>)}</td>
                <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs ${STATUS_STYLES[r.Status]}`}>{TRANSFER_STATUS_LABELS[r.Status]||r.Status}</span></td>
                <td className="px-4 py-3 max-w-sm">
                  <div className="flex items-center gap-1.5">
                    <div className="truncate text-xs">{r.Reason||'Not yet provided'}</div>
                    {(user?.role==='Admin'||user?.role==='Head Office') && r['Screenshot Uploaded'] &&
                      <span onClick={(e)=>e.stopPropagation()}><ViewAttachmentButtonIcon mid={r.MID} sheet={tab==='completed'?'completed':'response'}/></span>}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        );

        const tableHead = (
          <thead className="bg-paper text-xs text-ink-700/60"><tr>
            <th className="text-left px-4 py-3">#</th><th className="text-left px-4 py-3">MID</th><th className="text-left px-4 py-3">Student</th>{showBranch && <th className="text-left px-4 py-3">Branch</th>}<th className="text-left px-4 py-3">Phone numbers</th><th className="text-left px-4 py-3">Status</th><th className="text-left px-4 py-3">Reason</th>
          </tr></thead>
        );

        return <>
          {hasAttention && <div className="m-4 rounded-lg border-2 border-amber overflow-hidden">
            <div className="px-4 py-2.5 bg-amber-light border-b border-amber/30"><h3 className="text-sm font-semibold text-amber">Needs Your Attention ({attentionRows.length})</h3></div>
            <div className="overflow-x-auto"><table className="w-full text-sm">{tableHead}{renderTransferRows(attentionRows,'Nothing here.')}</table></div>
          </div>}
          <div className="overflow-x-auto"><table className="w-full text-sm">{tableHead}{renderTransferRows(mainRows,'No transfer records found.')}</table></div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-ink-100 text-xs text-ink-700/60"><span>{total} record(s)</span><div className="flex items-center gap-2"><select value={pageSize} onChange={e=>{setPageSize(Number(e.target.value) as PageSize);setPage(1)}} className="border border-ink-100 rounded px-2 py-1"><option value={15}>15</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select><button disabled={page<=1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/></button><span>{page}/{pages}</span><button disabled={page>=pages} onClick={()=>setPage(p=>p+1)}><ChevronRight size={16}/></button></div></div>
        </>;
      })()}
    </div>

    {selectedTransfer && <TransferDetailsModal
      row={selectedTransfer}
      userRole={user?.role}
      sheet={tab==='completed'?'completed':'response'}
      onEdit={()=>{openEdit(selectedTransfer);setSelectedTransfer(null)}}
      onApproveHeadOffice={()=>{hoApprove.mutate(selectedTransfer.MID);setSelectedTransfer(null)}}
      onReject={()=>{setRejectTarget(selectedTransfer);setRejectReason('');setError(null);setSelectedTransfer(null)}}
      onApproveAdmin={()=>{adminApprove.mutate(selectedTransfer.MID);setSelectedTransfer(null)}}
      onDelete={()=>{setDeleteTarget(selectedTransfer);setSelectedTransfer(null)}}
      onClose={()=>setSelectedTransfer(null)}
    />}

    {editTarget && <Modal title={user?.role==='Head Office'?'Edit Transfer Request':'Correct Transfer Request'} onClose={()=>setEditTarget(null)}>
      <div className="p-5 space-y-4">
        {(['mid','studentName','phone1','phone2','phone3','transferToBranch'] as const).map(k=><label key={k} className="block"><span className="block text-xs font-medium text-ink-700/70 mb-1">{k==='transferToBranch'?'Transfer To Branch':k}</span><input value={form[k]} onChange={e=>setForm(v=>({...v,[k]:e.target.value}))} className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm"/></label>)}
        <label className="block"><span className="block text-xs font-medium text-ink-700/70 mb-1">Reason</span><textarea rows={5} value={form.reason} onChange={e=>setForm(v=>({...v,reason:e.target.value}))} className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm resize-y min-h-[120px]"/></label>
        <button disabled={user?.role==='Head Office'?hoEdit.isPending:correction.isPending} onClick={()=>{if(user?.role==='Head Office')hoEdit.mutate();else correction.mutate()}} className="w-full rounded-md bg-ink-900 text-white px-4 py-2 text-sm disabled:opacity-50">{user?.role==='Head Office'?(hoEdit.isPending?'Saving…':'Save changes'):(correction.isPending?'Submitting…':'Correct & Resubmit')}</button>
      </div>
    </Modal>}
    {rejectTarget && <Modal title="Reject Transfer Request" onClose={()=>setRejectTarget(null)}>
      <div className="p-5 space-y-4"><textarea autoFocus rows={5} value={rejectReason} onChange={e=>setRejectReason(e.target.value)} placeholder="Enter rejection reason..." className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm resize-y min-h-[120px]"/><button disabled={!rejectReason.trim()||reject.isPending} onClick={()=>reject.mutate()} className="w-full rounded-md bg-reject text-white px-4 py-2 text-sm disabled:opacity-50">{reject.isPending?'Rejecting…':'Reject & Return to SCM'}</button></div>
    </Modal>}
    {deleteTarget && <Modal title="Delete Transfer Request" onClose={()=>{setDeleteTarget(null);setDeleteConfirmText('')}}>
      <div className="p-5 space-y-4">
        <p className="text-sm text-ink-700/70">This will permanently delete <b>{deleteTarget.MID}</b>. This cannot be undone. Type the MID below to confirm.</p>
        <input
          required
          autoFocus
          value={deleteConfirmText}
          onChange={e=>setDeleteConfirmText(e.target.value)}
          placeholder={deleteTarget.MID}
          className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-reject"
        />
        <div className="flex justify-end gap-2">
          <button onClick={()=>{setDeleteTarget(null);setDeleteConfirmText('')}} className="rounded-md border border-ink-200 px-4 py-2 text-sm">Cancel</button>
          <button disabled={deleteConfirmText.trim()!==deleteTarget.MID||del.isPending} onClick={()=>del.mutate()} className="rounded-md bg-reject text-white px-4 py-2 text-sm disabled:opacity-40">{del.isPending?'Deleting…':'Delete'}</button>
        </div>
      </div>
    </Modal>}
  </div>;
}