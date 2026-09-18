"""
cleanup.py
Item 8: automatic 60-day data retention cleanup.

Once a Discontinue / Transfer / Inactive record has received Admin's
FINAL approval (i.e. it has moved into its *Completed sheet), it is
kept in the production database for config.RECORD_RETENTION_DAYS
(default 60) days, counted from its Admin Final Approval Date - never
from the request/creation date. After that window, it is permanently
removed from the production database.

The record is NEVER removed from the Google Sheet backup - only from
Postgres. backup_to_sheets.py's upsert model preserves it there
indefinitely (flagged _StillInProductionDB = FALSE once this job
deletes it).

SAFETY CHECKS before any delete:
  1. The record actually has a valid Admin Final Approval Date.
  2. The record is actually fully approved (Admin Approval == 'APPROVED').
  3. More than RECORD_RETENTION_DAYS days have passed since that date.
  4. The most recent daily backup run succeeded (see
     backup_to_sheets.LAST_SUCCESSFUL_BACKUP_AT via get_setting_) and
     happened AFTER this record was approved - i.e. this specific
     record has actually been captured by a successful backup at
     least once - otherwise the delete is skipped this run (and
     logged) rather than risking data that was never backed up.
Every delete (and every skip) is logged to config.SHEET_CLEANUP_LOG.
"""
import threading
import time
from datetime import datetime, timedelta, timezone

import config
import storage
from db_utils import read_sheet_as_objects_, delete_row_, get_setting_, append_row_, now_iso_, collect_screenshot_keys_

# (Completed sheet, workflow label) pairs this job sweeps.
_COMPLETED_SHEETS = [
    (config.SHEET_COMPLETED, 'Discontinue'),
    (config.SHEET_TRANSFER_COMPLETED, 'Transfer'),
    (config.SHEET_INACTIVE_COMPLETED, 'Inactive'),
]


def _log_cleanup_(sheet_label, mid, student_name, approval_date, days_since, status, detail):
    try:
        append_row_(config.SHEET_CLEANUP_LOG, {
            'Timestamp': now_iso_(),
            'Sheet': sheet_label,
            'MID': mid,
            'Student Name': student_name,
            'Admin Final Approval Date': approval_date,
            'Days Since Approval': days_since,
            'Status': status,  # 'DELETED' or 'SKIPPED'
            'Detail': detail,
        })
    except Exception as exc:  # noqa: BLE001
        print(f'WARNING: failed to write cleanup log entry for {mid}: {exc}')


def _last_successful_backup_at_():
    raw = get_setting_('LAST_SUCCESSFUL_BACKUP_AT')
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _parse_dt_(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:19])
    except Exception:
        return None


def run_cleanup_(now=None):
    """
    Sweeps every *Completed sheet and permanently deletes any record
    whose Admin Final Approval Date is more than
    config.RECORD_RETENTION_DAYS days old, PROVIDED it has been
    captured by at least one successful backup since being approved.
    Safe to call repeatedly (e.g. once a day from the scheduler).
    """
    now = now or datetime.now()
    last_backup_at = _last_successful_backup_at_()
    deleted, skipped = 0, 0

    for sheet_name, sheet_label in _COMPLETED_SHEETS:
        rows = read_sheet_as_objects_(sheet_name)
        print(f'Fetch complete: {sheet_name} ({len(rows)} row(s)).')
        for row in rows:
            mid = row.get('MID')
            student_name = row.get('Student Name')

            # Safety check 1 & 2: must be a genuine, fully-approved record.
            approval_date_raw = row.get('Approval Date')
            approved = row.get('Admin Approval') == 'APPROVED'
            approval_dt = _parse_dt_(approval_date_raw)
            if not approved or not approval_dt:
                continue  # not eligible - missing/invalid approval date, never delete

            days_since = (now - approval_dt).days

            # Safety check 3: retention window not yet elapsed.
            if days_since <= config.RECORD_RETENTION_DAYS:
                continue

            # Safety check 4: this record must have actually been
            # backed up (a successful backup run must have happened
            # after it was approved) before we permanently delete it.
            if not last_backup_at or last_backup_at.replace(tzinfo=None) < approval_dt:
                skipped += 1
                _log_cleanup_(
                    sheet_label, mid, student_name, approval_date_raw, days_since, 'SKIPPED',
                    'Retention window elapsed but no successful backup has run since this '
                    'record was approved - waiting for the next successful backup before deleting.'
                )
                continue

            delete_row_(sheet_name, row['__row'])
            storage.delete_screenshots_(collect_screenshot_keys_(row))
            deleted += 1
            _log_cleanup_(
                sheet_label, mid, student_name, approval_date_raw, days_since, 'DELETED',
                f'Removed from production DB {days_since} days after Admin final approval '
                f'(retention: {config.RECORD_RETENTION_DAYS} days). Preserved in Google Sheet backup.'
            )

    if deleted or skipped:
        print(f'Cleanup sweep: {deleted} record(s) deleted, {skipped} skipped (pending backup confirmation).')
    return {'deleted': deleted, 'skipped': skipped}


def _run_loop_():
    while True:
        time.sleep(6 * 3600)  # every 6 hours - cheap, and the date check makes it idempotent
        try:
            run_cleanup_()
        except Exception as exc:  # noqa: BLE001
            print(f'Cleanup sweep failed: {exc}')


def start_():
    thread = threading.Thread(target=_run_loop_, daemon=True)
    thread.start()
    print(f'60-day retention cleanup scheduler started (retention: {config.RECORD_RETENTION_DAYS} days '
          f'after Admin final approval).')