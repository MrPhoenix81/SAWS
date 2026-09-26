"""
config.py
Central configuration for the Student Discontinuation Management
System Flask backend. Direct Python port of Config.gs.

All secrets/deployment-specific values are read from environment
variables (a .env file is supported via python-dotenv) instead of
being hardcoded, since this is no longer bound to a single Apps
Script project.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ---- Primary database (Neon Postgres) ----
# See db.py - this is the app's real, live data store now. Get this
# connection string from your Neon project dashboard and set it as
# the DATABASE_URL environment variable (locally in .env, and in
# Render -> Environment for the deployed app). Nothing in this file
# needs to change once that's set.
DATABASE_URL = os.environ.get('DATABASE_URL', '')

# ---- Daily Google Sheets backup (safety net only - NOT read from) ----
# The app never reads from this spreadsheet; backup_to_sheets.py only
# ever writes a fresh daily snapshot to it. Leave BACKUP_SPREADSHEET_ID
# blank to disable backups entirely.
BACKUP_SPREADSHEET_ID = os.environ.get('BACKUP_SPREADSHEET_ID', '')

# Path to the Google service-account JSON key file (downloaded from
# Google Cloud Console), used ONLY for writing the daily backup. The
# service account's email must be shared on the target Google Sheet
# with "Editor" access, exactly the way you'd share a sheet with any
# other collaborator. Prefer GOOGLE_SERVICE_ACCOUNT_JSON (paste the
# full key file contents as an env var) in production - see
# backup_to_sheets.py.
_configured_service_account_file = os.environ.get('GOOGLE_SERVICE_ACCOUNT_FILE', 'service_account.json')

# Render mounts Secret Files under /etc/secrets. If a local Windows path was
# copied into Render's environment, use the same filename from that mount.
if os.name != 'nt' and '\\' in _configured_service_account_file:
    _render_secret_file = Path('/etc/secrets') / Path(_configured_service_account_file.replace('\\', '/')).name
    GOOGLE_SERVICE_ACCOUNT_FILE = (
        str(_render_secret_file)
        if _render_secret_file.exists()
        else _configured_service_account_file
    )
else:
    GOOGLE_SERVICE_ACCOUNT_FILE = _configured_service_account_file

# Hour of day (UTC, 0-23) the in-process scheduler runs the backup at,
# if you're using the built-in scheduler instead of a Render Cron Job.
# See scheduler.py and README.md for the two options.
# Default corresponds to 1:00 AM in BACKUP_TIMEZONE (see below) -
# computed once at import time so the default "just works" without
# anyone having to hand-convert timezones.
BACKUP_TIMEZONE = os.environ.get('BACKUP_TIMEZONE', 'Asia/Kolkata')
BACKUP_LOCAL_HOUR = int(os.environ.get('BACKUP_LOCAL_HOUR', '1'))  # 1:00 AM local time


def _default_backup_hour_utc_():
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        today_local = datetime.now(ZoneInfo(BACKUP_TIMEZONE)).replace(
            hour=BACKUP_LOCAL_HOUR, minute=0, second=0, microsecond=0)
        return today_local.astimezone(ZoneInfo('UTC')).hour
    except Exception:
        # Fall back to a fixed offset guess (IST = UTC+5:30) rather than
        # crashing the whole app if zoneinfo data isn't available.
        return (BACKUP_LOCAL_HOUR - 5) % 24


BACKUP_HOUR_UTC = int(os.environ.get('BACKUP_HOUR_UTC', str(_default_backup_hour_utc_())))

# Clock-aligned (IST) start hours for the other two in-process
# schedulers. The cleanup sweep runs every CLEANUP_INTERVAL_HOURS
# starting at CLEANUP_ANCHOR_HOUR_IST; the Supabase keepalive runs
# every KEEPALIVE_INTERVAL_HOURS starting at KEEPALIVE_ANCHOR_HOUR_IST.
# e.g. anchor 1, interval 1 -> 1:00, 2:00, 3:00 ... IST (every hour).
# e.g. anchor 2, interval 2 -> 2:00, 4:00, 6:00 ... IST (every 2 hours).
CLEANUP_ANCHOR_HOUR_IST = int(os.environ.get('CLEANUP_ANCHOR_HOUR_IST', '1'))
CLEANUP_INTERVAL_HOURS = int(os.environ.get('CLEANUP_INTERVAL_HOURS', '1'))
KEEPALIVE_ANCHOR_HOUR_IST = int(os.environ.get('KEEPALIVE_ANCHOR_HOUR_IST', '2'))
KEEPALIVE_INTERVAL_HOURS = int(os.environ.get('KEEPALIVE_INTERVAL_HOURS', '2'))
SCHEDULER_TIMEZONE = os.environ.get('SCHEDULER_TIMEZONE', 'Asia/Kolkata')

# ---- Sheet/table names (logical dataset names - used as both the
# Postgres `sheet_name` value and the backup spreadsheet's tab name) ----
SHEET_USERS = 'Users'
SHEET_BRANCHES = 'Branches'
SHEET_RESPONSE = 'Response'    # active workflow rows
SHEET_COMPLETED = 'Completed'  # final-verified rows moved here
SHEET_INACTIVE_RESPONSE = 'InactiveResponse'  # active inactive requests
SHEET_INACTIVE_COMPLETED = 'InactiveCompleted'  # approved inactive requests
SHEET_TRANSFER_RESPONSE = 'TransferResponse'  # active transfer requests
SHEET_TRANSFER_COMPLETED = 'TransferCompleted'  # approved transfer requests
SHEET_NOTIFICATIONS = 'Notifications'
SHEET_AUDITLOGS = 'AuditLogs'
SHEET_SETTINGS = 'Settings'  # now a real key/value table - see db_utils.get_setting_/set_setting_
SHEET_PASSWORD_RESETS = 'PasswordResets'
# Append-only log of every daily Google Sheet backup attempt (success
# AND failure) - see backup_to_sheets.py. Kept in Postgres (not just
# stdout) so a failed backup is still visible after a Render restart.
SHEET_BACKUP_LOG = 'BackupLog'
# Append-only log of every automatic 60-day retention deletion - see cleanup.py.
SHEET_CLEANUP_LOG = 'CleanupLog'

# How long a sheet's rows stay cached in-process before a read hits the
# database again. Short enough that data still feels live, long enough
# that bursts of near-simultaneous reads (page loads, the 15s/30s frontend
# polling) collapse into a single API call instead of one each.
SHEET_READ_CACHE_TTL_SECONDS = int(os.environ.get('SHEET_READ_CACHE_TTL_SECONDS', '20'))

# Dashboard aggregation is more expensive than a single sheet read, so it
# has its own cache duration. Set to 0 to disable dashboard result caching.
DASHBOARD_CACHE_TTL_SECONDS = int(os.environ.get('DASHBOARD_CACHE_TTL_SECONDS', '120'))

# ---- Roles ----
ROLE_ADMIN = 'Admin'
ROLE_HEAD_OFFICE = 'Head Office'
ROLE_SCM = 'SCM'
ROLE_HOF = 'HOF'
ROLE_MANAGER = 'Manager'

VALID_ROLES = [ROLE_ADMIN, ROLE_HEAD_OFFICE, ROLE_SCM, ROLE_HOF, ROLE_MANAGER]

# Roles that can see every branch.
GLOBAL_VISIBILITY_ROLES = [ROLE_ADMIN, ROLE_HEAD_OFFICE]

# ---- Call-log screenshot proof (SCM/HOF/Manager reason submissions) ----
SCREENSHOT_FIELD_SCM = 'Reason (SCM) Screenshot Key'
SCREENSHOT_FIELD_HOF = 'Reason (HOF) Screenshot Key'
SCREENSHOT_FIELD_MANAGER = 'Reason (Manager) Screenshot Key'
SCREENSHOT_FIELDS_BY_ROLE = {
    ROLE_SCM: SCREENSHOT_FIELD_SCM,
    ROLE_HOF: SCREENSHOT_FIELD_HOF,
    ROLE_MANAGER: SCREENSHOT_FIELD_MANAGER,
}
SCREENSHOT_RETENTION_HOURS = 120  # hours after Admin's final approval before deletion
SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
SCREENSHOT_ALLOWED_MIME_TYPES = {'image/jpeg', 'image/png'}
# SCM-only multi-image uploads (Discontinue/Inactive/Transfer submissions
# and SCM reason resubmissions) may attach up to this many images at once.
# HOF/Manager stay single-image, unchanged.
SCREENSHOT_MAX_COUNT = 6

# ---- Optional supporting image (Transfer/Inactive SCM submissions) ----
# Unlike the discontinuation call-log screenshot above, this is OPTIONAL
# on both workflows - SCM may attach a photo when submitting a Transfer
# or Inactive request, but it's not required to submit. Only Head
# Office and Admin can view it.
SCREENSHOT_FIELD_TRANSFER = 'Screenshot Key'
SCREENSHOT_FIELD_INACTIVE = 'Screenshot Key'

# ---- Workflow status values ----
STATUS_PENDING_HOF_MANAGER = 'PENDING_HOF_MANAGER'
STATUS_WAITING_FOR_MANAGER = 'WAITING_FOR_MANAGER'
STATUS_WAITING_FOR_HOF = 'WAITING_FOR_HOF'
STATUS_PENDING_HEAD_OFFICE = 'PENDING_HEAD_OFFICE'
STATUS_PENDING_ADMIN = 'PENDING_ADMIN'
STATUS_APPROVED = 'APPROVED'
STATUS_PENDING_SCM = 'PENDING_SCM'
# NEW: used only when Head Office rejects and flags ONE OR MORE
# specific roles (SCM / HOF / Manager) as needing to redo their
# reason. Which role(s) exactly is stored in the 'Rejected Roles'
# column (comma-separated). This replaces the old behaviour where a
# Head Office rejection always wiped HOF+Manager and went back to
# SCM only.
STATUS_PENDING_CORRECTION = 'PENDING_CORRECTION'

# ---- Inactive workflow status values ----
STATUS_INACTIVE_PENDING_HEAD_OFFICE = 'INACTIVE_PENDING_HEAD_OFFICE'
STATUS_INACTIVE_PENDING_ADMIN = 'INACTIVE_PENDING_ADMIN'
STATUS_INACTIVE_APPROVED = 'INACTIVE_APPROVED'
STATUS_INACTIVE_PENDING_SCM = 'INACTIVE_PENDING_SCM'

# ---- Transfer workflow status values ----
STATUS_TRANSFER_PENDING_HEAD_OFFICE = 'TRANSFER_PENDING_HEAD_OFFICE'
STATUS_TRANSFER_PENDING_ADMIN = 'TRANSFER_PENDING_ADMIN'
STATUS_TRANSFER_APPROVED = 'TRANSFER_APPROVED'
STATUS_TRANSFER_PENDING_SCM = 'TRANSFER_PENDING_SCM'

STATUS_LABELS = {
    STATUS_PENDING_HOF_MANAGER: 'Pending HOF & Manager',
    STATUS_WAITING_FOR_MANAGER: 'Waiting for Manager',
    STATUS_WAITING_FOR_HOF: 'Waiting for HOF',
    STATUS_PENDING_HEAD_OFFICE: 'Pending Head Office Approval',
    STATUS_PENDING_ADMIN: 'Pending Admin Verification',
    STATUS_APPROVED: 'Discontinued',
    STATUS_PENDING_SCM: 'Pending SCM',
    STATUS_PENDING_CORRECTION: 'Pending Correction (rejected by Head Office)',
    STATUS_INACTIVE_PENDING_HEAD_OFFICE: 'Inactive - Pending Head Office',
    STATUS_INACTIVE_PENDING_ADMIN: 'Inactive - Pending Admin',
    STATUS_INACTIVE_APPROVED: 'Inactive',
    STATUS_INACTIVE_PENDING_SCM: 'Inactive - Pending SCM',
    STATUS_TRANSFER_PENDING_HEAD_OFFICE: 'Transfer - Pending Head Office',
    STATUS_TRANSFER_PENDING_ADMIN: 'Transfer - Pending Admin',
    STATUS_TRANSFER_APPROVED: 'Transferred',
    STATUS_TRANSFER_PENDING_SCM: 'Transfer - Pending SCM',
}

# The set of roles that can ever be asked to "correct" their reason
# after a Head Office rejection.
CORRECTABLE_ROLES = [ROLE_SCM, ROLE_HOF, ROLE_MANAGER]

# ---- Notification types ----
NOTIF_SUBMITTED = 'SUBMITTED'
NOTIF_WAIT_MANAGER = 'WAITING_FOR_MANAGER'
NOTIF_WAIT_HOF = 'WAITING_FOR_HOF'
NOTIF_READY_HEAD_OFFICE = 'READY_FOR_HEAD_OFFICE'
NOTIF_READY_ADMIN = 'READY_FOR_ADMIN'
NOTIF_HEAD_OFFICE_REJECTED = 'HEAD_OFFICE_REJECTED'
NOTIF_APPROVED = 'APPROVED'
NOTIF_REJECTED = 'REJECTED'

# ---- Students/Completed column order ----
STUDENT_COLUMNS = [
    'Sl No', 'Branch', 'Batch Name', 'Faculty Name', 'MID', 'Student Name',
    'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
    'Status', 'Total Billed', 'Total Paid', 'Arrear',
    'Last Present Day', 'Days Since Present',
    'Entry Date',
    'Reason (SCM)', 'SCM Updated Date',
    'Reason (HOF)', 'HOF Updated Date',
    'Reason (Manager)', 'Manager Updated Date',
    'Head Office Decision', 'Head Office Name', 'Head Office Date',
    'Admin Approval', 'Admin Name', 'Approval Date',
    'Last Rejection Reason', 'Last Rejected By', 'Last Rejected Stage', 'Last Rejected Date',
    # NEW: comma-separated subset of {SCM,HOF,Manager} - which
    # role(s) Head Office flagged as having the wrong reason on the
    # most recent rejection. Cleared (blank) once every flagged role
    # has resubmitted and the record goes back to Head Office.
    'Rejected Roles',
]

TRANSFER_COLUMNS = [
    'Sl No', 'Branch', 'Batch Name', 'Faculty Name', 'MID', 'Student Name',
    'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
    'Transfer To Branch', 'Reason', SCREENSHOT_FIELD_TRANSFER,
    'Status', 'Entry Date',
    'Head Office Decision', 'Head Office Name', 'Head Office Date',
    'Admin Approval', 'Admin Name', 'Approval Date',
    'Last Rejection Reason', 'Last Rejected By', 'Last Rejected Stage', 'Last Rejected Date',
]

INACTIVE_COLUMNS = [
    'Sl No', 'Branch', 'Batch Name', 'Faculty Name', 'MID', 'Student Name',
    'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
    'Last Present Day', 'Reason', SCREENSHOT_FIELD_INACTIVE,
    'Status', 'Entry Date',
    'Head Office Decision', 'Head Office Name', 'Head Office Date',
    'Admin Approval', 'Admin Name', 'Approval Date',
    'Last Rejection Reason', 'Last Rejected By', 'Last Rejected Stage', 'Last Rejected Date',
]

# 'Page' tags which sidebar module a notification belongs to, so the
# unseen-count badge for that module can be computed without having to
# cross-reference the MID back into a workflow sheet. See notifications.py.
PAGE_DISCONTINUE = 'discontinue'
PAGE_TRANSFER = 'transfer'
PAGE_INACTIVE = 'inactive'

NOTIFICATION_COLUMNS = ['ID', 'ToEmail', 'Message', 'Type', 'Related MID', 'Read', 'Created Date', 'Page']
AUDITLOG_COLUMNS = ['Timestamp', 'User Email', 'Action', 'Details', 'Branch', 'Browser']
BACKUP_LOG_COLUMNS = ['Started At', 'Finished At', 'Status', 'Detail', 'Total Rows']
CLEANUP_LOG_COLUMNS = ['Timestamp', 'Sheet', 'MID', 'Student Name', 'Admin Final Approval Date',
                        'Days Since Approval', 'Status', 'Detail']
# 'Password' holds a SHA-256 hash only - never the plaintext password.
USERS_COLUMNS = ['Email', 'Name', 'Branch', 'Role', 'Password']

# 'Active' drives soft delete for branches.delete.
BRANCHES_COLUMNS = ['Branch Name', 'Active']

PASSWORD_RESET_COLUMNS = ['Token', 'Email', 'Created Date', 'Expires At', 'Used']
RESET_TOKEN_EXPIRY_MINUTES = 30

# ---- Automatic data retention (60 days after Admin final approval) ----
# Once a Discontinue/Transfer/Inactive record has sat in its
# *Completed sheet for more than this many days, counted from its
# Admin Final Approval Date (never from Entry Date), it is permanently
# removed from the production database - but NEVER from the Google
# Sheet backup. See cleanup.py.
RECORD_RETENTION_DAYS = int(os.environ.get('RECORD_RETENTION_DAYS', '60'))

# ---- Admin dashboard: System / Important Links ----
# Plain URLs only - never credentials. The linked service handles its
# own login. Leave any of these blank to hide that link.
SYSTEM_LINK_DATABASE = os.environ.get('SYSTEM_LINK_DATABASE', '')
SYSTEM_LINK_IMAGE_STORAGE = os.environ.get('SYSTEM_LINK_IMAGE_STORAGE', '')
SYSTEM_LINK_BACKUP_SHEET = os.environ.get(
    'SYSTEM_LINK_BACKUP_SHEET',
    (f'https://docs.google.com/spreadsheets/d/{BACKUP_SPREADSHEET_ID}/edit'
     if BACKUP_SPREADSHEET_ID else '')
)
SYSTEM_LINK_HOSTING = os.environ.get('SYSTEM_LINK_HOSTING', '')
SYSTEM_LINK_UPTIME_MONITOR = os.environ.get('SYSTEM_LINK_UPTIME_MONITOR', '')

# ---- Misc ----
SESSION_TIMEOUT_MINUTES = 120

# Column headers that represent a plain calendar day with no
# meaningful time-of-day component.
DATE_ONLY_COLUMNS = ['Last Present Day']

# Default frontend origin used to build "forgot password" links
# (used only if the Settings sheet doesn't have APP_BASE_URL yet).
DEFAULT_APP_BASE_URL = os.environ.get('APP_BASE_URL', 'http://localhost:5173')

# ---- Outbound email (forgot-password) ----
# Apps Script used MailApp (sends as the script owner) for free.
# Flask has no equivalent built in, so this uses plain SMTP. Leave
# SMTP_HOST unset to disable email sending (the reset endpoint will
# still succeed - it just won't deliver a link - see auth.py).
SMTP_HOST = os.environ.get('SMTP_HOST', '')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER', '')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD', '')
SMTP_FROM = os.environ.get('SMTP_FROM', SMTP_USER)