"""
db_utils.py
Low-level helpers for reading/writing application data, now backed
by Postgres (Neon) instead of Google Sheets. This is a drop-in
replacement for the old sheet_utils.py: every function name, its
arguments, and what it returns are kept identical, so students.py,
transfer.py, inactive.py, users.py, branches.py, notifications.py,
audit_log.py, auth.py, dashboard.py and api.py did not need any
logic changes - only their `from sheet_utils import ...` line became
`from db_utils import ...`.

STORAGE MODEL
Every logical "sheet" (Response, Completed, Users, Branches,
Notifications, AuditLogs, PasswordResets, ...) is stored as rows in
one Postgres table, `sheet_rows`, distinguished by a `sheet_name`
column, with the row's actual fields kept as JSONB in a `data`
column. This mirrors the old spreadsheet model closely enough that
the rest of the app (which only ever accessed fields by header name,
e.g. row['MID']) keeps working unmodified, while giving us a real
transactional database underneath.

Each row's Postgres primary key (`id`) plays the exact role the old
sheet row number played: it's returned as row['__row'] and passed
back into update_row_fields_()/delete_row_() to identify which row
to change. Nothing else in the app needs to know this changed.

A lightweight in-process cache (same idea as the old Sheets-API-call
cache) is kept so a burst of near-simultaneous reads doesn't hit
Postgres once per request - Neon's free tier has a finite compute
budget and this keeps normal usage well inside it.
"""
import json
import re
import threading
import time
from datetime import datetime

import psycopg2.extras

import config
from db import get_conn_, get_cursor_

_cache_lock = threading.RLock()
_cache = {}  # key -> (value, expires_at_epoch_seconds)

_schema_lock = threading.RLock()
_schema_ready = False


# ---------------------------------------------------------------
# Schema
# ---------------------------------------------------------------

def ensure_sheets_exist_():
    """Creates the tables this app needs if they don't already exist.
    Cheap to call on every request (it's guarded by a flag after the
    first successful run in this process)."""
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with get_conn_() as conn:
            cur = conn.cursor()
            cur.execute('''
                CREATE TABLE IF NOT EXISTS sheet_rows (
                    id SERIAL PRIMARY KEY,
                    sheet_name TEXT NOT NULL,
                    data JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            ''')
            cur.execute('CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_name '
                        'ON sheet_rows (sheet_name)')
            cur.execute("CREATE INDEX IF NOT EXISTS idx_sheet_rows_mid "
                        "ON sheet_rows ((data->>'MID'))")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_sheet_rows_email "
                        "ON sheet_rows ((data->>'Email'))")
            cur.execute('''
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            ''')
            cur.close()
        _schema_ready = True


# ---------------------------------------------------------------
# Date formatting helpers (unchanged from the Sheets version)
# ---------------------------------------------------------------

def format_datetime_(dt=None):
    dt = dt or datetime.now()
    return dt.strftime('%Y-%m-%dT%H:%M:%S')


def format_date_only_(dt):
    if dt is None or dt == '':
        return ''
    if isinstance(dt, str):
        return dt[:10]
    return dt.strftime('%Y-%m-%d')


def now_iso_():
    return format_datetime_(datetime.now())


# ---------------------------------------------------------------
# Simple in-process cache (same shape as the old sheet_utils cache)
# ---------------------------------------------------------------

def get_cached_(key, ttl_seconds, producer_fn):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[1] > time.time():
            return hit[0]
        value = producer_fn()
        _cache[key] = (value, time.time() + ttl_seconds)
        return value


def invalidate_cache_(keys):
    with _cache_lock:
        for k in keys:
            _cache.pop(k, None)


def invalidate_sheet_cache_(names=None):
    """Kept for interface-compatibility with the old sheet_utils; there
    is no per-name worksheet handle to drop anymore, but callers may
    still invoke this after bulk operations, so it's a safe no-op that
    also clears the row cache for good measure."""
    with _cache_lock:
        if names is None:
            _cache.clear()
        else:
            for name in names:
                _cache.pop(_sheet_rows_cache_key_(name), None)


def _sheet_rows_cache_key_(name):
    return 'sheet_rows_' + name


# ---------------------------------------------------------------
# Read / write
# ---------------------------------------------------------------

def _read_sheet_as_objects_uncached_(name):
    with get_cursor_() as cur:
        cur.execute(
            'SELECT id, data FROM sheet_rows WHERE sheet_name = %s ORDER BY id ASC',
            (name,),
        )
        rows = []
        for record in cur.fetchall():
            obj = dict(record['data'] or {})
            obj['__row'] = record['id']
            rows.append(obj)
        return rows


def read_sheet_as_objects_(name):
    """Reads every row for a given logical sheet name into a list of
    dicts keyed by field name (plus '__row', the DB row id). Cached
    in-process for config.SHEET_READ_CACHE_TTL_SECONDS. Writes
    (append_row_/update_row_fields_/delete_row_) invalidate this
    sheet's cache entry immediately."""
    ensure_sheets_exist_()
    ttl = getattr(config, 'SHEET_READ_CACHE_TTL_SECONDS', 8)
    return get_cached_(
        _sheet_rows_cache_key_(name), ttl,
        lambda: _read_sheet_as_objects_uncached_(name),
    )


def validate_phone_numbers_(phone1, phone2, phone3=''):
    """Validate the three phone fields used by every workflow.

    Phone 1 (student) and Phone 2 (parent 1) are mandatory.
    Phone 3 (parent 2) is optional. Every supplied number must be
    exactly 10 digits. Returns the normalized strings.
    """
    values = [str(phone1 or '').strip(), str(phone2 or '').strip(), str(phone3 or '').strip()]
    if not values[0] or not values[1]:
        raise ValueError('PHONE_REQUIRED')
    for value in values:
        if value and not re.fullmatch(r'\d{10}', value):
            raise ValueError('PHONE_INVALID')
    return values


def screenshot_keys_(value):
    """
    Normalizes a screenshot-field's stored value into a clean list of
    storage keys. Older rows hold a single key as a plain string;
    newer multi-image uploads hold a JSON list. This is the one place
    that difference gets flattened out, so every caller (URL signing,
    the 'uploaded' boolean flags, cleanup sweeps) can treat every row
    the same way regardless of when it was written.
    """
    if not value:
        return []
    if isinstance(value, list):
        return [str(k) for k in value if k]
    return [str(value)]


# Every column name, across Discontinue/Transfer/Inactive, that might
# hold screenshot storage key(s) on a row. Transfer and Inactive both
# happen to use the same column name ('Screenshot Key') - the set()
# below dedupes that so it isn't read twice.
_SCREENSHOT_FIELD_NAMES = sorted(set([
    config.SCREENSHOT_FIELD_SCM,
    config.SCREENSHOT_FIELD_HOF,
    config.SCREENSHOT_FIELD_MANAGER,
    config.SCREENSHOT_FIELD_TRANSFER,
    config.SCREENSHOT_FIELD_INACTIVE,
]))


def collect_screenshot_keys_(row):
    """
    Pulls every Supabase Storage key attached to a row (SCM/HOF/Manager
    call-log screenshots on Discontinue rows, or the single screenshot
    field on Transfer/Inactive rows), regardless of workflow - so a
    generic "delete this row" call site doesn't need to know which
    field names apply to which sheet.
    """
    keys = []
    for field in _SCREENSHOT_FIELD_NAMES:
        keys.extend(screenshot_keys_(row.get(field)))
    return keys


def mid_exists_anywhere_(mid, exclude_sheet=None, exclude_row=None):
    """Return True when MID is already present in any SDMS workflow
    sheet. MID uniqueness is global: the same MID cannot exist in
    another branch or in another workflow (Discontinue, Inactive, or
    Transfer)."""
    value = str(mid or '').strip()
    if not value:
        return False
    sheets = (
        config.SHEET_RESPONSE, config.SHEET_COMPLETED,
        config.SHEET_INACTIVE_RESPONSE, config.SHEET_INACTIVE_COMPLETED,
        config.SHEET_TRANSFER_RESPONSE, config.SHEET_TRANSFER_COMPLETED,
    )
    for sheet_name in sheets:
        for row in read_sheet_as_objects_(sheet_name):
            if exclude_sheet == sheet_name and exclude_row is not None and row.get('__row') == exclude_row:
                continue
            if str(row.get('MID', '')).strip() == value:
                return True
    return False


def append_row_(name, row_obj):
    """Appends one row (dict keyed by field name) to a sheet. Returns
    the number of rows now in that sheet (kept for interface parity
    with the old sheet_utils; nothing in this app currently uses the
    return value)."""
    ensure_sheets_exist_()
    payload = json.dumps(row_obj, default=str)
    with get_conn_() as conn:
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO sheet_rows (sheet_name, data) VALUES (%s, %s::jsonb)',
            (name, payload),
        )
        cur.execute('SELECT COUNT(*) FROM sheet_rows WHERE sheet_name = %s', (name,))
        count = cur.fetchone()[0]
        cur.close()
    invalidate_cache_([_sheet_rows_cache_key_(name)])
    return count


def update_row_fields_(name, row_number, fields):
    """Updates specific fields (by field name) on a given row id."""
    if not fields:
        return
    ensure_sheets_exist_()
    payload = json.dumps(fields, default=str)
    with get_conn_() as conn:
        cur = conn.cursor()
        cur.execute(
            'UPDATE sheet_rows SET data = data || %s::jsonb '
            'WHERE id = %s AND sheet_name = %s',
            (payload, row_number, name),
        )
        cur.close()
    invalidate_cache_([_sheet_rows_cache_key_(name)])


def delete_row_(name, row_number):
    """Deletes a row by its DB row id."""
    ensure_sheets_exist_()
    with get_conn_() as conn:
        cur = conn.cursor()
        cur.execute(
            'DELETE FROM sheet_rows WHERE id = %s AND sheet_name = %s',
            (row_number, name),
        )
        cur.close()
    invalidate_cache_([_sheet_rows_cache_key_(name)])


# ---------------------------------------------------------------
# Settings (key/value store - replaces the old Settings worksheet)
# ---------------------------------------------------------------

def get_setting_(key):
    ensure_sheets_exist_()
    with get_cursor_() as cur:
        cur.execute('SELECT value FROM settings WHERE key = %s', (key,))
        row = cur.fetchone()
        return row['value'] if row else None


def set_setting_(key, value):
    ensure_sheets_exist_()
    with get_conn_() as conn:
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO settings (key, value) VALUES (%s, %s) '
            'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            (key, value),
        )
        cur.close()