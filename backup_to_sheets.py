"""
backup_to_sheets.py
Writes a daily snapshot of every table in the Neon database to a
Google Sheet, as a safety-net backup that can outlive the production
database.

APPEND-ONLY / STACKED HISTORY MODEL:
Every dataset gets its own tab. Each run appends one row per LIVE
database row straight to the BOTTOM of the sheet, stamped with
'Backup Date' / 'Backup Timestamp (IST)' as the FIRST TWO COLUMNS -
it NEVER updates, overwrites, or removes a row a previous run wrote.
That means:
  - the same student/record appears again in every run's block for as
    long as it stays in the production database, so its status
    changes are visible over time simply by comparing blocks - the
    newest block for a record is always further down the sheet than
    an older one, and
  - once a record is deleted from the production database (including
    by the 60-day retention cleanup - see cleanup.py), it simply stops
    appearing in NEW blocks - every row about it from earlier runs
    stays exactly where it was, permanently.
Use the 'Backup Date' column to filter/pivot to "today's snapshot",
"this record's full history over time", etc. inside the sheet itself.
'_DatabaseRowId' (the last column) identifies which production DB row
a given line came from, so you can trace one record's full history
across many runs. There's also a dedicated 'Backup Runs' tab that logs
every single run's date/time/status/row-count in one place, so you can
see at a glance when backups actually happened without opening any of
the big data tabs.

Heads-up: because nothing is ever removed or merged, each tab grows by
(number of live rows) every single run. For a school-sized dataset
this is fine for a very long time, but if you ever want to trim
ancient history, do it manually in the Sheet itself (e.g. move rows
older than N months to an archive tab/spreadsheet) - this script will
never do that for you, on purpose.

EXCEPTION - Users and Branches: these barely change day to day, so
repeating an identical row every run would just be noise. For these
two tabs only, a row is appended only when it's brand new or has
actually changed since the last time it was recorded - see
_DIFF_ONLY_SHEETS below. Every other dataset keeps the plain
always-append behavior described above.

Run it two ways:
  1. As a Render Cron Job (recommended - see README.md): a separate,
     tiny Render service that runs `python backup_to_sheets.py` once
     a day regardless of whether your web app happens to be awake.
  2. From inside the running web app, via scheduler.py, which calls
     run_backup_() once every 24 hours (by default at 1:00 AM
     BACKUP_TIMEZONE - see config.py) in a background thread. Fine for
     getting started, but a free/starter web service that spins down
     when idle may miss a scheduled run - the Cron Job approach
     doesn't have that problem.

FAILURE HANDLING: a failed backup is recorded in the app's own
database (config.SHEET_BACKUP_LOG, readable from inside the app) AND
printed to stderr, and the exception is re-raised - it is never
silently swallowed or marked successful. cleanup.py refuses to
permanently delete a record unless the most recent backup run
succeeded, so a failing backup automatically pauses the 60-day
cleanup rather than risking data loss.

Setup (see README.md for the full walkthrough):
  1. Create a new, separate Google Sheet (this can be a blank one -
     it does not need to match the app's old sheet structure).
  2. Create a Google Cloud service account, download its JSON key,
     and share that new Sheet with the service account's email
     (Editor access).
  3. Set two environment variables (or use GOOGLE_SERVICE_ACCOUNT_FILE
     / a local service_account.json to point at a key file instead of
     pasting JSON - see config.py):
       BACKUP_SPREADSHEET_ID          - the ID from the sheet's URL
       GOOGLE_SERVICE_ACCOUNT_JSON    - the FULL contents of the
                                         downloaded JSON key file
"""
import json
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials

import config
from db_utils import read_sheet_as_objects_, set_setting_, append_row_

SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

# The Google Sheet is for humans to read, so its date/time columns are
# shown in IST (Asia/Kolkata) rather than UTC - everything else in the
# app (SHEET_BACKUP_LOG, internal timestamps) stays in UTC/ISO-8601,
# since that's what code should compare against.
_DISPLAY_TZ = ZoneInfo('Asia/Kolkata')

# Every dataset we back up, and the column order to write it in. Kept
# separate from config.py's *_COLUMNS lists so this file stays the
# one place that defines what the backup looks like.
BACKUP_DATASETS = {
    config.SHEET_USERS: config.USERS_COLUMNS,
    config.SHEET_BRANCHES: config.BRANCHES_COLUMNS,
    config.SHEET_RESPONSE: config.STUDENT_COLUMNS,
    config.SHEET_COMPLETED: config.STUDENT_COLUMNS,
    config.SHEET_INACTIVE_RESPONSE: config.INACTIVE_COLUMNS,
    config.SHEET_INACTIVE_COMPLETED: config.INACTIVE_COLUMNS,
    config.SHEET_TRANSFER_RESPONSE: config.TRANSFER_COLUMNS,
    config.SHEET_TRANSFER_COMPLETED: config.TRANSFER_COLUMNS,
    # Notifications and AuditLogs are intentionally NOT backed up here -
    # they're high-volume, low-value-to-restore logs, not source data.
    config.SHEET_PASSWORD_RESETS: config.PASSWORD_RESET_COLUMNS,
}

# Users' password column holds a SHA-256 hash, never plaintext - but
# there's no reason to even keep the hash in a backup sheet that may
# be shared more widely than the database itself. Redact it there.
_REDACT_COLUMNS = {
    config.SHEET_USERS: {'Password'},
}

# Bookkeeping columns - written as the FIRST columns of every dataset
# tab (before the sheet's own normal columns) so it's immediately
# obvious which run produced any given row without having to scroll
# right. '_DatabaseRowId' is kept at the very end since it's an
# internal identifier, not something you'd normally scan for.
_BACKUP_DATE_COL = 'Backup Date'
_BACKUP_TS_COL = 'Backup Timestamp (IST)'
_DB_ROW_ID_COL = '_DatabaseRowId'
_LEADING_BOOKKEEPING_COLS = [_BACKUP_DATE_COL, _BACKUP_TS_COL]
_TRAILING_BOOKKEEPING_COLS = [_DB_ROW_ID_COL]

# A dedicated tab that simply lists every backup run's date/time, in
# one place, independent of any single dataset - the fastest way to
# see "when did we last back up, and how often has it actually run"
# without opening a big data tab. Grows by one row per run, forever.
_RUNS_TAB_NAME = 'Backup Runs'
_RUNS_TAB_COLUMNS = ['Backup Date', 'Backup Timestamp (IST)', 'Status', 'Total Rows Appended']


# Datasets where nothing meaningful changes most days (user accounts,
# branch list) - repeating an identical row every single run would
# just be noise. For these, only append a new row when a record is
# brand new OR at least one of its actual data columns has changed
# since the last time it was recorded. Every other dataset (Response,
# Completed, Inactive*, Transfer*, Notifications, AuditLogs,
# PasswordResets) keeps the plain "always append" stacked-history
# behavior, since those are exactly the ones whose day-to-day status
# changes are the point of the backup.
_DIFF_ONLY_SHEETS = {config.SHEET_USERS, config.SHEET_BRANCHES}


def _cell_safe_(value):
    """
    Google Sheets cells only accept strings/numbers/booleans - never a
    list or dict. Several columns (e.g. 'Screenshot Key', which can
    hold more than one uploaded file) are stored as JSON arrays in
    Postgres and come back from read_sheet_as_objects_() as native
    Python lists. Flatten anything like that into a plain string
    before it ever reaches the Sheets API, or every dataset after the
    first one containing such a value fails the whole backup run.

    Booleans are normalized to the exact text Google Sheets itself
    displays ('TRUE'/'FALSE') - Python's default str(True) == 'True'
    (different case), which would never match what's actually on the
    sheet when read back, breaking the Users/Branches "only append if
    changed" diffing every single time even when nothing changed.
    """
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (list, tuple)):
        return ', '.join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value)
    if value is None:
        return ''
    return value


def _load_service_account_info_():
    raw_json = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON')
    if raw_json:
        try:
            return json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                'GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste '
                'the *entire* contents of the service account key file.'
            ) from exc

    file_path = getattr(config, 'GOOGLE_SERVICE_ACCOUNT_FILE', None)
    if file_path and os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    raise RuntimeError(
        'No Google service account credentials found for the backup job. Set '
        'GOOGLE_SERVICE_ACCOUNT_JSON (paste the full service account key JSON), '
        'or place a service_account.json file next to config.py.'
    )


def _get_backup_spreadsheet_():
    if not config.BACKUP_SPREADSHEET_ID:
        raise RuntimeError(
            'BACKUP_SPREADSHEET_ID is not set - skipping backup. Set it to the '
            'ID of a Google Sheet you want daily backups written to.'
        )
    creds_info = _load_service_account_info_()
    creds = Credentials.from_service_account_info(creds_info, scopes=SCOPES)
    client = gspread.authorize(creds)
    return client.open_by_key(config.BACKUP_SPREADSHEET_ID)


def _get_or_create_tab_(spreadsheet, name, num_cols):
    try:
        return spreadsheet.worksheet(name)
    except gspread.WorksheetNotFound:
        return spreadsheet.add_worksheet(title=name, rows=200, cols=max(num_cols, 10))


def _write_dataset_(spreadsheet, name, columns, run_started_ist, run_started_ist_str):
    """
    Appends one row per currently-live database row to the BOTTOM of
    this dataset's tab, stamped with today's date and this run's exact
    timestamp AS THE FIRST TWO COLUMNS. Never updates, overwrites, or
    deletes anything a previous run wrote - every run's block sits
    below the last one, so a record's status changes are visible as
    separate rows over time, and a record that's later deleted from
    production simply stops getting new rows while every earlier row
    about it stays put forever.

    EXCEPTION: for `name` in _DIFF_ONLY_SHEETS (Users, Branches), a row
    is only appended when it's brand new OR at least one of its actual
    data columns differs from the last row recorded for that same
    database row - unchanged rows are skipped entirely so the tab
    isn't padded with identical repeats every single run.

    Returns the number of rows actually appended this run.
    """
    live_rows = read_sheet_as_objects_(name)
    redact = _REDACT_COLUMNS.get(name, set())
    full_columns = _LEADING_BOOKKEEPING_COLS + list(columns) + _TRAILING_BOOKKEEPING_COLS

    ws = _get_or_create_tab_(spreadsheet, name, len(full_columns))

    existing_values = ws.get_all_values()
    header = existing_values[0] if existing_values else []
    if header != full_columns:
        # First run for this tab (or an older/shorter/differently
        # ordered header from a prior version) - (re)write the header
        # row only. Never touches any data rows below it.
        ws.update(range_name='A1', values=[full_columns], value_input_option='RAW')

    diff_only = name in _DIFF_ONLY_SHEETS
    last_seen_by_id = {}
    if diff_only:
        data_start = len(_LEADING_BOOKKEEPING_COLS)
        data_end = data_start + len(columns)
        for existing_row in existing_values[1:]:  # skip header
            if len(existing_row) != len(full_columns):
                continue  # different/older schema (e.g. from before a column was added or reordered) - don't compare against it, just ignore it
            row_id = existing_row[data_end]  # _DatabaseRowId is the last column
            # Later rows are further down the sheet, so simply
            # overwriting the dict entry as we scan top-to-bottom
            # naturally leaves each id's MOST RECENT recorded values.
            last_seen_by_id[row_id] = tuple(existing_row[data_start:data_end])

    backup_date = run_started_ist.strftime('%Y-%m-%d')
    rows_to_append = []
    for row in live_rows:
        data_values = [_cell_safe_('(redacted)' if col in redact else row.get(col, '')) for col in columns]
        db_row_id = row.get('__row')

        if diff_only:
            comparable = tuple(str(v) for v in data_values)
            if last_seen_by_id.get(str(db_row_id)) == comparable:
                continue  # unchanged since last time - skip, don't repeat it
            last_seen_by_id[str(db_row_id)] = comparable

        values = [backup_date, run_started_ist_str] + data_values + [db_row_id]
        rows_to_append.append(values)

    if rows_to_append:
        ws.append_rows(rows_to_append, value_input_option='RAW')

    return len(rows_to_append)


def _log_run_to_runs_tab_(spreadsheet, run_started_ist, run_started_ist_str, status, total_rows):
    """
    Appends one row to the dedicated 'Backup Runs' tab for every
    single run (success or failure) - a running log of exactly when
    backups happened, separate from any one dataset's data. Never
    overwrites a previous entry.
    """
    ws = _get_or_create_tab_(spreadsheet, _RUNS_TAB_NAME, len(_RUNS_TAB_COLUMNS))
    if ws.row_values(1) != _RUNS_TAB_COLUMNS:
        ws.update(range_name='A1', values=[_RUNS_TAB_COLUMNS], value_input_option='RAW')
    ws.append_rows(
        [[run_started_ist.strftime('%Y-%m-%d'), run_started_ist_str, status, total_rows]],
        value_input_option='RAW',
    )


def _log_backup_result_(status, detail, started, finished, total_rows):
    """
    Records this run in config.SHEET_BACKUP_LOG (a real Postgres
    table, readable by the app itself and any future admin UI) - not
    just stdout, which disappears the moment the process restarts.
    Both successes and failures are logged; a failure is NEVER marked
    as a success.
    """
    try:
        append_row_(config.SHEET_BACKUP_LOG, {
            'Started At': started.isoformat(),
            'Finished At': finished.isoformat() if finished else '',
            'Status': status,  # 'SUCCESS' or 'FAILED'
            'Detail': detail,
            'Total Rows': total_rows,
        })
        if status == 'SUCCESS':
            set_setting_('LAST_SUCCESSFUL_BACKUP_AT', finished.isoformat())
    except Exception as log_exc:  # noqa: BLE001
        # Even the *logging* failing must not look like a silent
        # success - surface it loudly on stderr.
        print(f'WARNING: failed to record backup log entry: {log_exc}', file=sys.stderr)


def run_backup_():
    started = datetime.now(timezone.utc)  # kept in UTC internally for SHEET_BACKUP_LOG / comparisons
    run_started_iso = started.isoformat()
    started_ist = started.astimezone(_DISPLAY_TZ)  # what actually gets shown in the Google Sheet
    started_ist_str = started_ist.strftime('%Y-%m-%d %H:%M:%S')
    total_rows = 0
    spreadsheet = None
    try:
        spreadsheet = _get_backup_spreadsheet_()
        for name, columns in BACKUP_DATASETS.items():
            count = _write_dataset_(spreadsheet, name, columns, started_ist, started_ist_str)
            total_rows += count
            print(f'  {name}: {count} live row(s) appended')

        # A small "Backup Info" tab so it's obvious at a glance how fresh
        # the snapshot is when someone opens the sheet.
        info_ws = _get_or_create_tab_(spreadsheet, '_BackupInfo', 2)
        info_ws.update(range_name='A1', values=[
            ['Last backup (IST)', started_ist_str],
            ['Rows appended this run', str(total_rows)],
            ['Model', 'Append-only / stacked history - each run adds a new block below the last; nothing is ever overwritten or removed.'],
        ], value_input_option='RAW')

        _log_run_to_runs_tab_(spreadsheet, started_ist, started_ist_str, 'SUCCESS', total_rows)

        finished = datetime.now(timezone.utc)
        print(f'Backup complete: {total_rows} row(s) appended in {(finished - started).total_seconds():.1f}s')
        _log_backup_result_('SUCCESS', f'{total_rows} rows appended', started, finished, total_rows)
        return {'success': True, 'totalRows': total_rows}
    except Exception as exc:  # noqa: BLE001
        finished = datetime.now(timezone.utc)
        # Log the failure explicitly - never let this look like a
        # successful run to anything reading SHEET_BACKUP_LOG or the
        # 'Backup Runs' tab.
        _log_backup_result_('FAILED', str(exc), started, finished, total_rows)
        if spreadsheet is not None:
            try:
                _log_run_to_runs_tab_(spreadsheet, started_ist, started_ist_str, f'FAILED: {exc}', total_rows)
            except Exception:  # noqa: BLE001
                pass  # the spreadsheet itself may be unreachable - SHEET_BACKUP_LOG above already caught it
        raise


if __name__ == '__main__':
    try:
        run_backup_()
    except Exception as exc:  # noqa: BLE001
        print(f'Backup FAILED: {exc}', file=sys.stderr)
        sys.exit(1)