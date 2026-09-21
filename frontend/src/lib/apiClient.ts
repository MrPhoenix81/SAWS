import axios from 'axios';
import type {
  ApiEnvelope,
  AuthUser,
  ManagedUser,
  CreateUserPayload,
  UpdateUserPayload,
  StudentListResult,
  StudentListParams,
  SubmitStudentPayload,
  ReasonScreenshot,
  AdminStudentEditFields,
  Branch,
  AppNotification,
  AuditLogEntry,
  TransferListResult,
  TransferSubmitPayload,
  TransferEditFields,
  InactiveListResult
} from '@/types';

const API_URL = import.meta.env.VITE_API_URL as string;

if (!API_URL) {
  // Fails loud in dev rather than silently posting to "undefined"
  console.error('VITE_API_URL is not set. Copy .env.example to .env and fill it in.');
}

/**
 * Apps Script web apps don't answer CORS preflight (OPTIONS) requests
 * correctly, so a browser will silently block any POST whose
 * Content-Type triggers a preflight - which axios's default
 * 'application/json' does. Sending as 'text/plain' instead keeps this
 * a CORS "simple request" (no preflight), while doPost on the backend
 * still reads it fine since it just does JSON.parse(e.postData.contents)
 * regardless of the declared content type. Every call below uses this.
 */
const REQUEST_CONFIG = { headers: { 'Content-Type': 'text/plain;charset=utf-8' } };

/**
 * The current session token, returned by 'auth.login' after the
 * user's email + password are verified. Set by AuthContext right
 * after sign-in and cleared on sign-out. Kept as a module-level
 * variable (not React state) so apiClient itself doesn't need to
 * be a hook - any file can import { callApi } and use it, including
 * outside components.
 */
let currentToken: string | null = null;

export function setToken(token: string | null) {
  currentToken = token;
}

export function getToken() {
  return currentToken;
}

/**
 * Every backend action - reads and writes alike - goes through this
 * one function, POSTing { action, token, payload } to the Apps
 * Script web app's doPost handler. See Code.gs routeAction_ for the
 * full list of supported actions.
 */
export async function callApi<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await axios.post<ApiEnvelope<T>>(
    API_URL,
    { action, token: currentToken, payload },
    REQUEST_CONFIG
  );

  const envelope = response.data;
  if (!envelope.ok) {
    throw new ApiError(envelope.error || 'UNKNOWN_ERROR', envelope.message);
  }
  return envelope.data as T;
}

export class ApiError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
    this.name = 'ApiError';
  }
}

/**
 * Verifies email + password against the backend. On success returns
 * a fresh session token plus the resolved user. Used by the Login page.
 */
export async function login(email: string, password: string, browser?: string) {
  let response;
  try {
    response = await axios.post<ApiEnvelope<{ token: string; user: AuthUser }>>(
      API_URL,
      { action: 'auth.login', payload: { email, password, browser } },
      // 20s timeout: the backend's first request after an idle period can be
      // slow (cold start + Google Sheets auth), which previously hung with
      // no feedback and looked like the app was ignoring correct credentials.
      { ...REQUEST_CONFIG, timeout: 20000 }
    );
  } catch (err) {
    // A network/timeout/5xx failure never reaches the `!response.data.ok`
    // check below (axios throws before that), so without this catch it
    // surfaced as an unhelpful generic error indistinguishable from a
    // wrong password. Re-throw as a distinct ApiError so the UI (and the
    // person) can tell "server didn't respond" apart from "wrong password".
    if (axios.isAxiosError(err)) {
      if (err.code === 'ECONNABORTED') {
        throw new ApiError('AUTH_TIMEOUT', 'The server took too long to respond. Please try again.');
      }
      if (!err.response) {
        throw new ApiError('AUTH_NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
      }
    }
    throw err;
  }
  if (!response.data.ok) {
    throw new ApiError(response.data.error || 'AUTH_FAILED', response.data.message);
  }
  return response.data.data!;
}

/**
 * Changes the signed-in user's own password. Requires their current
 * password as proof of ownership - see auth.changePassword in Code.gs.
 */
export async function changePassword(currentPassword: string, newPassword: string) {
  return callApi<{ success: true }>('auth.changePassword', { currentPassword, newPassword });
}

/**
 * Requests a "forgot password" reset link be emailed to this address.
 * Always resolves successfully (even for unregistered emails) - the
 * backend deliberately doesn't reveal whether the email exists, so
 * the UI should always show the same "check your email" message.
 */
export async function forgotPassword(email: string) {
  const browser = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const response = await axios.post<ApiEnvelope<{ success: true }>>(
    API_URL,
    { action: 'auth.forgotPassword', payload: { email, browser } },
    REQUEST_CONFIG
  );
  if (!response.data.ok) {
    throw new ApiError(response.data.error || 'AUTH_FAILED', response.data.message);
  }
  return response.data.data!;
}

/**
 * Consumes a reset token from an emailed link and sets a new password.
 * Throws AUTH_INVALID_RESET_TOKEN if the link is unknown, expired, or
 * already used, or PASSWORD_TOO_SHORT if newPassword is under 6 chars.
 */
export async function resetPassword(token: string, newPassword: string) {
  const browser = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const response = await axios.post<ApiEnvelope<{ success: true }>>(
    API_URL,
    { action: 'auth.resetPassword', payload: { token, newPassword, browser } },
    REQUEST_CONFIG
  );
  if (!response.data.ok) {
    throw new ApiError(response.data.error || 'AUTH_FAILED', response.data.message);
  }
  return response.data.data!;
}

/**
 * Verifies an existing session token against the backend and returns
 * the resolved user. Used to silently restore a session on page load.
 */
export async function whoAmI(token: string) {
  const response = await axios.post<ApiEnvelope<AuthUser>>(
    API_URL,
    { action: 'auth.whoami', token },
    REQUEST_CONFIG
  );
  if (!response.data.ok) {
    throw new ApiError(response.data.error || 'AUTH_FAILED', response.data.message);
  }
  return response.data.data!;
}

/**
 * ---- Admin: User Management ----
 * All of the below map straight onto the users.* actions in
 * Code.gs / Users.gs, and are only ever authorized for Admin
 * on the backend (requireRole_(user, [ROLE_ADMIN])). The UI
 * still hides these behind an Admin-only route as a first line
 * of defense, but the real check always happens server-side.
 */

export async function listUsers() {
  return callApi<ManagedUser[]>('users.list');
}

/**
 * Returns { success: true, generatedPassword } - the plaintext
 * password is only ever handed back here, once, so the Admin can
 * relay it to the new user. It is never stored or retrievable again.
 */
export async function createUser(payload: CreateUserPayload) {
  return callApi<{ success: true; generatedPassword: string }>(
    'users.create',
    payload as unknown as Record<string, unknown>
  );
}

/**
 * If role or branch changes, the password is regenerated to match
 * the new Role+Branch formula and returned once in generatedPassword.
 * Otherwise generatedPassword is omitted from the response.
 */
export async function updateUser(payload: UpdateUserPayload) {
  return callApi<{ success: true; generatedPassword?: string }>(
    'users.update',
    payload as unknown as Record<string, unknown>
  );
}

export async function deleteUser(email: string) {
  return callApi<{ success: true }>('users.delete', { email });
}

export async function resetUserPassword(email: string) {
  return callApi<{ success: true; generatedPassword: string }>('users.resetPassword', { email });
}

/** Active branches only - what every dropdown/filter across the app should use. */
/**
 * ---- Notifications ----
 * Purely in-app - see Notifications.gs. Polled by AppLayout's bell
 * icon on an interval, and refetched after any action a user takes.
 */
export async function listNotifications() {
  return callApi<AppNotification[]>('notifications.list');
}

export async function markNotificationRead(id: string) {
  return callApi<{ success: true }>('notifications.markRead', { id });
}

export async function markAllNotificationsRead() {
  return callApi<{ success: true }>('notifications.markAllRead');
}

/**
 * ---- Audit Logs ----
 * Admin/Head Office get every branch (omit branch to see all); every
 * other role is forced server-side to their own branch regardless of
 * what's passed here (see auditlogs.list in Code.gs).
 */
export async function listAuditLogs(branch?: string) {
  return callApi<AuditLogEntry[]>('auditlogs.list', branch ? { branch } : {});
}

/**
 * ---- Exports ----
 * Reuses the same filters as the Students page. pageSize is set high
 * by the caller to pull every matching row in one call rather than
 * paginating, since this is meant to be turned into a downloadable
 * file, not rendered in a table.
 */
export async function exportStudents(sheet: 'response' | 'completed', params: StudentListParams = {}) {
  return callApi<StudentListResult>('exports.students', { sheet, ...params } as unknown as Record<string, unknown>);
}

export async function listBranches() {
  return callApi<string[]>('branches.list');
}

/**
 * Admin-only. Quick-access external links for the Admin dashboard's
 * "System / Important Links" section (item 9) - Data Storage,
 * Image Storage, Backup Google Sheet, Hosting Platform, Uptime
 * Monitor. Only ever contains plain URLs, never credentials - each
 * linked service handles its own login.
 */
export async function getSystemLinks() {
  return callApi<{ links: { key: string; label: string; url: string }[] }>('admin.systemLinks');
}

/**
 * Admin-only. Manually triggers the daily Google Sheet backup right
 * now instead of waiting for the 1:00 AM schedule - useful for
 * testing, or right before doing something risky. Runs the exact same
 * code the automatic schedule uses.
 */
export async function runBackupNow() {
  return callApi<{ success: boolean; totalRows: number }>('admin.runBackupNow');
}

/**
 * ---- Admin: Branch Management ----
 * All of the below map onto the branches.* actions in Code.gs /
 * Branches.gs, and are only ever authorized for Admin on the backend
 * (requireRole_(user, [ROLE_ADMIN])).
 */

/** Admin-only. Includes soft-deleted branches, for the management screen. */
export async function listAllBranches() {
  return callApi<Branch[]>('branches.listAll');
}

/**
 * Creates a new branch, or reactivates it if a branch with that name
 * was previously soft-deleted (reactivated: true in the response).
 */
export async function createBranch(name: string) {
  return callApi<{ success: true; name: string; reactivated?: boolean }>('branches.create', { name });
}

/** Soft delete - hides the branch from every dropdown/filter, existing records untouched. */
export async function deleteBranch(name: string) {
  return callApi<{ success: true }>('branches.delete', { name });
}

/** Undoes a soft delete. */
export async function reactivateBranch(name: string) {
  return callApi<{ success: true }>('branches.reactivate', { name });
}

/**
 * ---- Students / Discontinuation Workflow ----
 * 'sheet' picks which action to call: 'response' hits students.list
 * (the active workflow sheet), 'completed' hits students.listCompleted
 * (rows Admin has already approved). The backend strips fields the
 * caller's role isn't allowed to see before this ever reaches us -
 * see filterStudentRowForRole_ in Filters.gs.
 */
export async function listStudents(sheet: 'response' | 'completed', params: StudentListParams = {}) {
  const action = sheet === 'completed' ? 'students.listCompleted' : 'students.list';
  return callApi<StudentListResult>(action, params as unknown as Record<string, unknown>);
}

/** SCM (or Admin, on a branch's behalf) creates a new discontinuation entry. */
export async function submitStudentEntry(payload: SubmitStudentPayload) {
  return callApi<{ success: true }>('students.submit', payload as unknown as Record<string, unknown>);
}

/** SCM (or Admin) edits the original Reason (SCM) for one entry. */
export type { ReasonScreenshot };

/** SCM may attach multiple call-log screenshots (up to the server-side cap). */
export async function submitScmReason(mid: string, reason: string, screenshots?: ReasonScreenshot[]) {
  return callApi<{ success: true }>('students.submitScmReason', { mid, reason, screenshots });
}

/** HOF fills in their Confirmed Reason for one entry. Call-log screenshot is optional. */
export async function submitHofReason(mid: string, confirmedReason: string, screenshot?: ReasonScreenshot) {
  return callApi<{ success: true }>('students.submitHofReason', { mid, confirmedReason, screenshot });
}

/** Manager fills in their Verified Reason for one entry. Call-log screenshot is optional. */
export async function submitManagerReason(mid: string, verifiedReason: string, screenshot?: ReasonScreenshot) {
  return callApi<{ success: true }>('students.submitManagerReason', { mid, verifiedReason, screenshot });
}

/** Admin/Head Office only: fetches short-lived (5 min) signed URLs for a role's call-log screenshot(s). */
export async function getReasonScreenshotUrl(
  mid: string,
  sheet: 'response' | 'completed',
  role: 'SCM' | 'HOF' | 'Manager'
) {
  return callApi<{ urls: string[] }>('students.getReasonScreenshotUrl', { mid, sheet, role });
}

/** Head Office approves an entry once both HOF and Manager have completed their parts. */
export async function headOfficeApprove(mid: string) {
  return callApi<{ success: true }>('students.headOfficeApprove', { mid });
}

/**
 * Head Office rejects an entry, naming which role(s) (any non-empty
 * subset of 'SCM' | 'HOF' | 'Manager') gave the wrong reason. Only
 * those role(s) become editable again; everyone else stays locked.
 */
export async function headOfficeReject(mid: string, rejectionReason: string, rejectedRoles: string[]) {
  return callApi<{ success: true }>('students.headOfficeReject', { mid, rejectionReason, rejectedRoles });
}

/** Admin approves an entry once Head Office has already approved it. */
export async function approveStudentEntry(mid: string) {
  return callApi<{ success: true }>('students.approve', { mid });
}

/** Admin rejects an entry, with a reason SCM/HOF/Manager will all see. */
export async function rejectStudentEntry(mid: string, rejectionReason: string) {
  return callApi<{ success: true }>('students.reject', { mid, rejectionReason });
}

/**
 * Admin or Head Office permanently deletes a student entry, at any
 * workflow status, from either the active ('response') or
 * already-approved ('completed') sheet. Irreversible - the backend
 * logs the full row snapshot to the audit log before removing it.
 * `confirmMid` must exactly match `mid` - the backend re-checks this
 * server-side, it is not just a UI nicety.
 */
export async function deleteStudentEntry(mid: string, sheet: 'response' | 'completed', confirmMid: string) {
  return callApi<{ success: true }>('students.delete', { mid, sheet, confirmMid });
}

/**
 * SCM edits student detail fields (name/phone/billing/last present
 * day/MID) - not the reason - on an entry in their own branch, while
 * it's still active (same pre-Head-Office-decision window as
 * submitScmReason).
 */
export interface ScmEditableStudentFields {
  MID?: string;
  'Student Name'?: string;
  'Phone Number 1'?: string;
  'Phone Number 2'?: string;
  'Phone Number 3'?: string;
  'Total Billed'?: number;
  'Total Paid'?: number;
  'Last Present Day'?: string;
}
export async function scmUpdateStudentDetails(mid: string, fields: ScmEditableStudentFields) {
  return callApi<{ success: true }>('students.scmUpdateDetails', { mid, fields: fields as unknown as Record<string, unknown> });
}

/**
 * Admin edits any field on a student entry directly - in either the
 * active ('response') or already-approved ('completed') sheet - at
 * any workflow stage, including after approval or rejection.
 */
export async function adminUpdateStudent(
  mid: string,
  sheet: 'response' | 'completed',
  fields: AdminStudentEditFields
) {
  return callApi<{ success: true }>('students.adminUpdate', { mid, sheet, fields });
}

/** ---- Inactive workflow ---- */

export interface InactiveListParams {
  search?: string;
  branch?: string;
  page?: number;
  pageSize?: number;
}

export interface InactiveSubmitPayload {
  mid: string;
  studentName: string;
  phone1: string;
  phone2?: string;
  phone3?: string;
  inactiveFrom: string;
  reason: string;
  // Optional supporting image(s) - never required to submit. SCM may
  // attach multiple; `screenshot` (singular) is kept only for backward
  // compatibility.
  screenshot?: ReasonScreenshot;
  screenshots?: ReasonScreenshot[];
}

export interface InactiveEditFields {
  MID?: string;
  'Student Name'?: string;
  'Phone Number 1'?: string;
  'Phone Number 2'?: string;
  'Phone Number 3'?: string;
  'Last Present Day'?: string;
  Reason?: string;
  Branch?: string;
}

export async function listInactive(
  sheet: 'response' | 'completed',
  params: InactiveListParams = {}
) {
  const action = sheet === 'completed' ? 'inactive.listCompleted' : 'inactive.list';
  return callApi<InactiveListResult>(
    action,
    params as unknown as Record<string, unknown>
  );
}

export async function submitInactive(payload: InactiveSubmitPayload) {
  return callApi<{ success: true }>(
    'inactive.submit',
    payload as unknown as Record<string, unknown>
  );
}

export async function scmCorrectInactive(mid: string, fields: InactiveEditFields) {
  return callApi<{ success: true }>('inactive.scmCorrect', {
    mid,
    fields: fields as unknown as Record<string, unknown>
  });
}

export async function headOfficeUpdateInactive(mid: string, fields: InactiveEditFields) {
  return callApi<{ success: true }>('inactive.headOfficeUpdate', { mid, fields: fields as unknown as Record<string, unknown> });
}

export async function headOfficeApproveInactive(mid: string) {
  return callApi<{ success: true }>('inactive.headOfficeApprove', { mid });
}

export async function headOfficeRejectInactive(mid: string, rejectionReason: string) {
  return callApi<{ success: true }>('inactive.headOfficeReject', {
    mid,
    rejectionReason
  });
}

export async function approveInactive(mid: string) {
  return callApi<{ success: true }>('inactive.approve', { mid });
}

export async function rejectInactive(mid: string, rejectionReason: string) {
  return callApi<{ success: true }>('inactive.reject', {
    mid,
    rejectionReason
  });
}

export async function adminUpdateInactive(mid: string, fields: InactiveEditFields) {
  return callApi<{ success: true }>('inactive.adminUpdate', {
    mid,
    fields: fields as unknown as Record<string, unknown>
  });
}

export async function deleteInactive(mid: string, sheet: 'response' | 'completed', confirmMid: string) {
  return callApi<{ success: true }>('inactive.delete', { mid, sheet, confirmMid });
}

/** Head Office/Admin only: fetches a short-lived (5 min) signed URL for the optional image attached to an inactive request. */
export async function getInactiveScreenshotUrl(mid: string, sheet: 'response' | 'completed') {
  return callApi<{ urls: string[] }>('inactive.getScreenshotUrl', { mid, sheet });
}


/** ---- Transfer workflow ---- */
export async function listTransfer(sheet: 'response' | 'completed', params: StudentListParams = {}) {
  const action = sheet === 'completed' ? 'transfer.listCompleted' : 'transfer.list';
  return callApi<TransferListResult>(action, params as unknown as Record<string, unknown>);
}
export async function submitTransfer(payload: TransferSubmitPayload) {
  return callApi<{ success: true }>('transfer.submit', payload as unknown as Record<string, unknown>);
}
export async function scmCorrectTransfer(mid: string, fields: TransferEditFields) {
  return callApi<{ success: true }>('transfer.scmCorrect', { mid, fields: fields as unknown as Record<string, unknown> });
}
export async function headOfficeUpdateTransfer(mid: string, fields: TransferEditFields) { return callApi<{ success: true }>('transfer.headOfficeUpdate', { mid, fields: fields as unknown as Record<string, unknown> }); }
export async function headOfficeApproveTransfer(mid: string) { return callApi<{ success: true }>('transfer.headOfficeApprove', { mid }); }
export async function headOfficeRejectTransfer(mid: string, rejectionReason: string) { return callApi<{ success: true }>('transfer.headOfficeReject', { mid, rejectionReason }); }
export async function approveTransfer(mid: string) { return callApi<{ success: true }>('transfer.approve', { mid }); }
export async function rejectTransfer(mid: string, rejectionReason: string) { return callApi<{ success: true }>('transfer.reject', { mid, rejectionReason }); }
export async function deleteTransfer(mid: string, sheet: 'response' | 'completed', confirmMid: string) { return callApi<{ success: true }>('transfer.delete', { mid, sheet, confirmMid }); }

/** Head Office/Admin only: fetches a short-lived (5 min) signed URL for the optional image attached to a transfer request. */
export async function getTransferScreenshotUrl(mid: string, sheet: 'response' | 'completed') {
  return callApi<{ urls: string[] }>('transfer.getScreenshotUrl', { mid, sheet });
}

/**
 * ---- Admin: Bulk Data (upload / download / delete) ----
 * All four map onto the bulk.* actions in bulk.py, which enforce
 * Admin-only server-side - the UI hides the page behind an
 * Admin-only route as a first line of defense, same as Users/Branches.
 */
export type BulkWorkflow = 'discontinue' | 'inactive' | 'transfer';
export type BulkSheet = 'active' | 'completed';

export interface BulkTemplateResult {
  workflow: BulkWorkflow;
  columns: string[];
  required: string[];
}
export async function getBulkTemplate(workflow: BulkWorkflow) {
  return callApi<BulkTemplateResult>('bulk.template', { workflow });
}

export interface BulkExportResult {
  columns: string[];
  rows: Record<string, unknown>[];
}
export async function bulkExport(workflow: BulkWorkflow, sheet: BulkSheet, branches: string[]) {
  return callApi<BulkExportResult>('bulk.export', { workflow, sheet, branches });
}

export interface BulkImportRowResult {
  row: number;
  mid: string;
  status: 'inserted' | 'updated' | 'skipped';
  reason?: string;
  warning?: string | null;
}
export interface BulkImportResult {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  results: BulkImportRowResult[];
}
export async function bulkImport(workflow: BulkWorkflow, sheet: BulkSheet, rows: Record<string, unknown>[]) {
  return callApi<BulkImportResult>('bulk.import', { workflow, sheet, rows });
}

export interface BulkDeleteResult {
  deleted: number;
  mids: string[];
}
/** `confirm` must be the literal string 'DELETE' - re-checked server-side too. */
export async function bulkDelete(
  workflow: BulkWorkflow,
  sheet: BulkSheet,
  branches: string[],
  confirm: string,
  mids?: string[]
) {
  return callApi<BulkDeleteResult>('bulk.delete', { workflow, sheet, branches, confirm, mids });
}

/** ---- Sidebar "unseen" badges (see notifications.py) ---- */
export type SidebarPage = 'discontinue' | 'transfer' | 'inactive';
export async function markPageSeen(page: SidebarPage) {
  return callApi<{ success: true }>('pages.markSeen', { page });
}
export async function getUnseenCounts() {
  return callApi<{ discontinue: number; transfer: number; inactive: number }>('pages.unseenCounts', {});
}