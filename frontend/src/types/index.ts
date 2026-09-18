export type Role = 'Admin' | 'Head Office' | 'SCM' | 'HOF' | 'Manager';

export interface AuthUser {
  email: string;
  name: string;
  branch: string;
  role: Role;
}

export type StudentStatus =
  | 'PENDING_HOF_MANAGER'
  | 'WAITING_FOR_MANAGER'
  | 'WAITING_FOR_HOF'
  | 'PENDING_HEAD_OFFICE'
  | 'PENDING_ADMIN'
  | 'APPROVED'
  | 'PENDING_SCM'
  | 'PENDING_CORRECTION';

export const STATUS_LABELS: Record<StudentStatus, string> = {
  PENDING_HOF_MANAGER: 'Pending HOF & Manager',
  WAITING_FOR_MANAGER: 'Waiting for Manager',
  WAITING_FOR_HOF: 'Waiting for HOF',
  PENDING_HEAD_OFFICE: 'Pending Head Office Approval',
  PENDING_ADMIN: 'Pending Admin Verification',
  APPROVED: 'Discontinued',
  PENDING_SCM: 'Pending SCM',
  PENDING_CORRECTION: 'Pending Correction'
};

/** The 3 roles Head Office can flag, individually, on a rejection. */
export type CorrectableRole = 'SCM' | 'HOF' | 'Manager';

export interface StudentEntry {
  'Sl No': number;
  Branch: string;
  MID: string;
  'Student Name': string;
  'Phone Number 1': string;
  'Phone Number 2'?: string;
  'Phone Number 3'?: string;
  Status: StudentStatus;
  /** Human-readable label for Status, computed server-side (Filters.gs). */
  'Current Stage'?: string;
  /**
   * Whether the CURRENT logged-in user may edit this row's own-role
   * field(s) right now (server-computed; the server still re-checks
   * on every write - this is only for greying out the UI).
   */
  canEdit?: boolean;
  canDataEdit?: boolean;
  canScmCorrect?: boolean;
  // Billing fields: present for SCM and Admin/Head Office views, omitted
  // from the narrower HOF/Manager views (see Filters.gs filterStudentRowForRole_).
  'Total Billed'?: number;
  'Total Paid'?: number;
  Arrear?: number;
  'Last Present Day': string;
  'Days Since Present': number | string;
  /** Item 2: same value as 'Days Since Present', computed dynamically server-side on every read. */
  'Days Since Last Present'?: number | string;
  /**
   * Set once, at creation, and never touched again - use this (not
   * 'SCM Updated Date', which changes on every reason edit) for "how
   * old is this entry". Blank on rows created before this field existed.
   */
  'Entry Date'?: string;
  'Reason (SCM)'?: string;
  'SCM Updated Date'?: string;
  'Reason (HOF)'?: string; // Admin/Head Office-facing only
  'HOF Updated Date'?: string;
  'Reason (Manager)'?: string; // Admin/Head Office-facing only
  'Manager Updated Date'?: string;
  'Confirmed Reason'?: string; // HOF-facing alias for Reason (HOF)
  'Verified Reason'?: string; // Manager-facing alias for Reason (Manager)
  'Head Office Decision'?: string;
  'Head Office Name'?: string;
  'Head Office Date'?: string;
  'Admin Approval'?: string;
  'Admin Name'?: string;
  'Approval Date'?: string;
  'Last Rejection Reason'?: string;
  'Last Rejected By'?: string;
  'Last Rejected Stage'?: 'Head Office' | 'Admin' | '';
  'Last Rejected Date'?: string;
  /** Comma-separated raw value from the sheet, e.g. "HOF,Manager". Prefer the List version below. */
  'Rejected Roles'?: string;
  /** Which role(s) Head Office flagged on the most recent rejection and still owe a corrected reason. */
  'Rejected Roles List'?: CorrectableRole[];
  /**
   * Admin/Head Office only: true when this row's Status is the exact
   * stage that role can currently act on (PENDING_ADMIN for Admin,
   * PENDING_HEAD_OFFICE for Head Office). Server-computed (see
   * filters.py:filter_student_row_for_role_) - used purely to group/
   * highlight "needs your decision" rows vs everyone else's status,
   * since both roles can now see every stage instead of only their own.
   */
  'Awaiting My Action'?: boolean;
}

/** Fields Admin/Head Office are allowed to directly edit on a student entry, at any workflow stage. */
export interface AdminStudentEditFields {
  Branch?: string;
  MID?: string;
  'Student Name'?: string;
  'Phone Number 1'?: string;
  'Phone Number 2'?: string;
  'Phone Number 3'?: string;
  'Total Billed'?: number;
  'Total Paid'?: number;
  'Last Present Day'?: string;
  'Reason (SCM)'?: string;
  'Reason (HOF)'?: string;
  'Reason (Manager)'?: string;
  Status?: StudentStatus;
}

export interface AppNotification {
  id: string;
  message: string;
  type:
    | 'SUBMITTED'
    | 'WAITING_FOR_MANAGER'
    | 'WAITING_FOR_HOF'
    | 'READY_FOR_HEAD_OFFICE'
    | 'READY_FOR_ADMIN'
    | 'HEAD_OFFICE_REJECTED'
    | 'APPROVED'
    | 'REJECTED';
  relatedMid: string;
  read: boolean;
  createdDate: string;
}

export interface DashboardCards {
  pending: number;
  awaitingHeadOffice: number;
  awaitingAdminApproval: number;
  approved: number;
  rejected: number;
  todaysEntries: number;
  monthlyEntries: number;
  discontinuePending: number;
  discontinueApproved: number;
  inactivePending: number;
  inactiveApproved: number;
  transferPending: number;
  transferApproved: number;
}

export interface TrendPoint {
  label: string;
  count: number;
}

export interface BranchCount {
  branch: string;
  count?: number;
  pending: number;
  approved: number;
  total: number;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface WorkflowSummary { workflow: string; pending: number; approved: number; total: number; }

export interface DashboardData {
  scope?: { branch: string; global: boolean };
  cards: DashboardCards;
  charts: {
    dailyTrend: TrendPoint[];
    monthlyTrend: TrendPoint[];
    approvalTrend: TrendPoint[];
    branchComparison: BranchCount[];
    statusDistribution: StatusCount[];
    workflowComparison: WorkflowSummary[];
  };
}

export interface StudentListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: StudentEntry[];
  /** Count of visible active rows currently awaiting THIS user's action
   *  (their role's stage) - not just the total open count. Drives the
   *  sidebar badge, which clears once their part is submitted and only
   *  the next role in the chain sees it lit. */
  pendingForMe?: number;
}

export interface StudentListParams {
  /** Single combined search box: matched against MID, name, and phone 1-3 (OR). */
  search?: string;
  status?: string;
  branch?: string;
  /** Filters on 'Entry Date' - when the entry was first created (age of the entry). */
  entryDateFrom?: string;
  entryDateTo?: string;
  /** Filters on 'Last Present Day' - the day the student was last actually present. */
  lastPresentFrom?: string;
  lastPresentTo?: string;
  /** Column to sort by (e.g. 'MID', 'Student Name', 'Arrear', 'Last Present Day', 'Entry Date', 'Status').
   *  Omit for the backend's default ordering (Admin/Head Office see actionable rows first). */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ReasonScreenshot {
  base64: string;
  mimeType: string;
}
export interface SubmitStudentPayload {
  branch?: string; // only used/allowed when the caller is Admin
  mid: string;
  studentName: string;
  phone1: string;
  phone2?: string;
  phone3?: string;
  totalBilled?: number;
  totalPaid?: number;
  lastPresentDay?: string;
  reason: string;
  // Call-log proof - optional, not required to submit. SCM may attach
  // multiple images (up to the server-side cap); `screenshot` (singular)
  // is kept only for backward compatibility.
  screenshot?: ReasonScreenshot;
  screenshots?: ReasonScreenshot[];
}
export interface ManagedUser {
  email: string;
  name: string;
  branch: string;
  role: Role;
}

export interface CreateUserPayload {
  email: string;
  name: string;
  branch: string;
  role: Role;
  /** Required unless autoGenerate is true. */
  password?: string;
  /** When true, the backend ignores `password` and generates one
   * using the Magnus scheme (FirstName + M + 2-digit year + 4 random
   * characters), guaranteed unique. */
  autoGenerate?: boolean;
}

export interface UpdateUserPayload {
  email: string;
  name?: string;
  branch?: string;
  role?: Role;
}

/** One row from auditlogs.list. */
export interface AuditLogEntry {
  timestamp: string;
  userEmail: string;
  action: string;
  details: string;
  branch: string;
  browser: string;
}

/** One row from branches.listAll (Admin-only) - includes soft-deleted branches. */
export interface Branch {
  name: string;
  active: boolean;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export type InactiveStatus =
  | 'INACTIVE_PENDING_HEAD_OFFICE'
  | 'INACTIVE_PENDING_ADMIN'
  | 'INACTIVE_APPROVED'
  | 'INACTIVE_PENDING_SCM';

export const INACTIVE_STATUS_LABELS: Record<InactiveStatus, string> = {
  INACTIVE_PENDING_HEAD_OFFICE: 'Pending Head Office Approval',
  INACTIVE_PENDING_ADMIN: 'Pending Admin Verification',
  INACTIVE_APPROVED: 'Inactive',
  INACTIVE_PENDING_SCM: 'Pending SCM Correction'
};

export interface InactiveEntry {
  'Sl No': number;
  Branch: string;
  MID: string;
  'Student Name': string;
  'Phone Number 1': string;
  'Phone Number 2'?: string;
  'Phone Number 3'?: string;
  'Last Present Day': string;
  /** Item 2: computed dynamically server-side on every read from 'Last Present Day'. */
  'Days Since Last Present'?: number | string;
  Reason: string;
  Status: InactiveStatus;
  'Screenshot Uploaded'?: boolean;
  canEdit?: boolean;
  canDataEdit?: boolean;
  canScmCorrect?: boolean;
  /** True when this row is sitting in THIS user's queue right now (see inactive.py _serialize_). */
  'Awaiting My Action'?: boolean;
  'Entry Date'?: string;
  'Head Office Decision'?: string;
  'Head Office Name'?: string;
  'Head Office Date'?: string;
  'Admin Approval'?: string;
  'Admin Name'?: string;
  'Approval Date'?: string;
  'Last Rejection Reason'?: string;
  'Last Rejected By'?: string;
  'Last Rejected Stage'?: string;
  'Last Rejected Date'?: string;
  canHeadOfficeApprove?: boolean;
  canHeadOfficeReject?: boolean;
  canAdminApprove?: boolean;
  canAdminReject?: boolean;
  canDelete?: boolean;
}

export interface InactiveListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: InactiveEntry[];
  /** Count of visible active rows currently awaiting THIS user's action. */
  pendingForMe?: number;
}


export type TransferStatus = 'TRANSFER_PENDING_HEAD_OFFICE' | 'TRANSFER_PENDING_ADMIN' | 'TRANSFER_PENDING_SCM' | 'TRANSFER_APPROVED';
export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  TRANSFER_PENDING_HEAD_OFFICE: 'Pending Head Office Approval',
  TRANSFER_PENDING_ADMIN: 'Pending Admin Verification',
  TRANSFER_PENDING_SCM: 'Pending SCM Correction',
  TRANSFER_APPROVED: 'Transferred'
};
export interface TransferEntry {
  'Sl No': number; Branch: string; MID: string; 'Student Name': string;
  'Phone Number 1': string; 'Phone Number 2'?: string; 'Phone Number 3'?: string;
  'Transfer To Branch': string; Reason: string; Status: TransferStatus;
  'Screenshot Uploaded'?: boolean;
  canEdit?: boolean; canDataEdit?: boolean; canScmCorrect?: boolean;
  /** True when this row is sitting in THIS user's queue right now (see transfer.py _serialize_). */
  'Awaiting My Action'?: boolean;
  'Entry Date'?: string; 'Head Office Decision'?: string; 'Head Office Name'?: string; 'Head Office Date'?: string;
  'Admin Approval'?: string; 'Admin Name'?: string; 'Approval Date'?: string;
  'Last Rejection Reason'?: string; 'Last Rejected By'?: string; 'Last Rejected Stage'?: string; 'Last Rejected Date'?: string;
  canHeadOfficeApprove?: boolean; canHeadOfficeReject?: boolean; canAdminApprove?: boolean; canAdminReject?: boolean; canDelete?: boolean; canAdminEdit?: boolean;
}
export interface TransferListResult { total: number; page: number; pageSize: number; rows: TransferEntry[]; pendingForMe?: number; }
export interface TransferSubmitPayload { mid: string; studentName: string; phone1: string; phone2?: string; phone3?: string; transferToBranch: string; reason: string; screenshot?: ReasonScreenshot; screenshots?: ReasonScreenshot[]; }
export interface TransferEditFields { MID?: string; 'Student Name'?: string; 'Phone Number 1'?: string; 'Phone Number 2'?: string; 'Phone Number 3'?: string; 'Transfer To Branch'?: string; Reason?: string; }