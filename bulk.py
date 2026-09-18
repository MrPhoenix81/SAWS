"""
bulk.py
Admin-only "Bulk Data" tools: upload (import) many rows at once,
download (export) many rows at once, and bulk delete - across all
three workflows (Discontinue, Inactive, Transfer) and either sheet
(the active/in-progress one or the Completed/approved one).

This intentionally bypasses the normal step-by-step workflow engine
(SCM -> HOF/Manager -> Head Office -> Admin, etc.) - it's meant for
an Admin migrating/managing data in bulk, not for driving a single
student through approval stages. Every row written here is written
as-is, exactly like the row shapes already used elsewhere in the app
(see config.STUDENT_COLUMNS / TRANSFER_COLUMNS / INACTIVE_COLUMNS).

All three entry points (bulk_import_, bulk_export_, bulk_delete_)
are Admin-only.
"""
import config
import storage
from db_utils import (
    read_sheet_as_objects_, append_row_, delete_row_, invalidate_cache_,
    now_iso_, format_date_only_, mid_exists_anywhere_, validate_phone_numbers_,
    collect_screenshot_keys_,
)
from auth import ApiError, require_role_
from audit_log import log_audit_
from branches import normalize_branch_name_, list_branches_

# ---------------------------------------------------------------
# Workflow registry - one place that knows the sheet names, column
# list, and default statuses for each of the 3 workflows, so the
# functions below don't need a big if/elif per workflow.
# ---------------------------------------------------------------
WORKFLOWS = {
    'discontinue': {
        'label': 'Discontinue',
        'columns': config.STUDENT_COLUMNS,
        'active_sheet': config.SHEET_RESPONSE,
        'completed_sheet': config.SHEET_COMPLETED,
        'active_default_status': config.STATUS_PENDING_HOF_MANAGER,
        'completed_default_status': config.STATUS_APPROVED,
        'required': ['MID', 'Branch', 'Student Name', 'Phone Number 1', 'Phone Number 2'],
    },
    'inactive': {
        'label': 'Inactive',
        'columns': config.INACTIVE_COLUMNS,
        'active_sheet': config.SHEET_INACTIVE_RESPONSE,
        'completed_sheet': config.SHEET_INACTIVE_COMPLETED,
        'active_default_status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
        'completed_default_status': config.STATUS_INACTIVE_APPROVED,
        'required': ['MID', 'Branch', 'Student Name', 'Phone Number 1', 'Phone Number 2', 'Last Present Day'],
    },
    'transfer': {
        'label': 'Transfer',
        'columns': config.TRANSFER_COLUMNS,
        'active_sheet': config.SHEET_TRANSFER_RESPONSE,
        'completed_sheet': config.SHEET_TRANSFER_COMPLETED,
        'active_default_status': config.STATUS_TRANSFER_PENDING_HEAD_OFFICE,
        'completed_default_status': config.STATUS_TRANSFER_APPROVED,
        'required': ['MID', 'Branch', 'Student Name', 'Phone Number 1', 'Phone Number 2', 'Transfer To Branch'],
    },
}

# Columns that hold a plain calendar date (no time-of-day) across the
# three workflows, formatted with format_date_only_ when present.
DATE_ONLY_FIELDS = {'Last Present Day'}


def _get_workflow_(workflow):
    spec = WORKFLOWS.get(workflow)
    if not spec:
        raise ApiError('BAD_REQUEST')
    return spec


def _sheet_name_(spec, sheet_key):
    return spec['completed_sheet'] if sheet_key == 'completed' else spec['active_sheet']


def bulk_template_(user, payload):
    """Returns the column headers for a workflow, so the frontend can
    build a downloadable blank template that always matches exactly
    what bulk_import_ below expects - one source of truth."""
    require_role_(user, [config.ROLE_ADMIN])
    workflow = payload.get('workflow')
    spec = _get_workflow_(workflow)
    return {'workflow': workflow, 'columns': spec['columns'], 'required': spec['required']}


# ---------------------------------------------------------------
# Export (download)
# ---------------------------------------------------------------

def bulk_export_(user, payload):
    """
    Admin-only. payload: { workflow, sheet: 'active'|'completed',
    branches: [...] (omit or include 'ALL' for every branch) }.
    Returns { columns, rows } - the frontend builds the actual .xlsx
    file client-side (same pattern already used by exports.students).
    """
    require_role_(user, [config.ROLE_ADMIN])
    workflow = payload.get('workflow')
    spec = _get_workflow_(workflow)
    sheet_name = _sheet_name_(spec, payload.get('sheet'))

    rows = read_sheet_as_objects_(sheet_name)

    branches = payload.get('branches') or []
    branches = [normalize_branch_name_(b) for b in branches if str(b or '').strip()]
    if branches and 'ALL' not in branches:
        rows = [r for r in rows if normalize_branch_name_(r.get('Branch')) in branches]

    columns = spec['columns']
    out_rows = [{col: r.get(col, '') for col in columns} for r in rows]

    log_audit_(
        user['email'], 'EXPORT',
        f"Bulk exported {len(out_rows)} row(s) from {sheet_name} "
        f"({spec['label']}, branches: {', '.join(branches) if branches and 'ALL' not in branches else 'ALL'})",
        'ALL', payload.get('browser'),
    )

    return {'columns': columns, 'rows': out_rows}


# ---------------------------------------------------------------
# Import (upload)
# ---------------------------------------------------------------

def _normalize_row_(spec, raw_row, sheet_key, next_sl_no):
    """Builds one full row dict (every column in spec['columns'],
    nothing else) from a raw uploaded row, applying the same light
    defaults/formatting the rest of the app uses. Raises ValueError
    with a short human reason if the row can't be used."""
    row = {}
    for col in spec['columns']:
        row[col] = raw_row.get(col, '')
        if isinstance(row[col], str):
            row[col] = row[col].strip()

    for field in spec['required']:
        if not str(row.get(field, '')).strip():
            raise ValueError(f"missing required field '{field}'")

    row['MID'] = str(row['MID']).strip()
    row['Branch'] = normalize_branch_name_(row['Branch'])

    phone1, phone2, phone3 = validate_phone_numbers_(
        row.get('Phone Number 1'), row.get('Phone Number 2'), row.get('Phone Number 3')
    )
    row['Phone Number 1'], row['Phone Number 2'], row['Phone Number 3'] = phone1, phone2, phone3

    if mid_exists_anywhere_(row['MID']):
        raise ValueError(f"MID {row['MID']} already exists")

    for field in DATE_ONLY_FIELDS:
        if field in row and row[field]:
            row[field] = format_date_only_(row[field])

    if not str(row.get('Sl No') or '').strip():
        row['Sl No'] = next_sl_no
    else:
        try:
            row['Sl No'] = int(float(row['Sl No']))
        except (TypeError, ValueError):
            row['Sl No'] = next_sl_no

    if not str(row.get('Status') or '').strip():
        row['Status'] = (
            spec['completed_default_status'] if sheet_key == 'completed' else spec['active_default_status']
        )

    if not str(row.get('Entry Date') or '').strip():
        row['Entry Date'] = now_iso_()

    if 'Total Billed' in row or 'Total Paid' in row:
        try:
            billed = float(row.get('Total Billed') or 0)
        except (TypeError, ValueError):
            billed = 0
        try:
            paid = float(row.get('Total Paid') or 0)
        except (TypeError, ValueError):
            paid = 0
        row['Total Billed'] = billed
        row['Total Paid'] = paid
        row['Arrear'] = billed - paid

    return row


def bulk_import_(user, payload):
    """
    Admin-only. payload: { workflow, sheet: 'active'|'completed',
    rows: [ {column: value, ...}, ... ] }.
    Every row is validated and inserted independently - one bad row
    (duplicate MID, missing field, bad phone number) is skipped and
    reported, it does not fail the whole batch.
    Returns { total, inserted, skipped, results: [...] }.
    """
    require_role_(user, [config.ROLE_ADMIN])
    workflow = payload.get('workflow')
    spec = _get_workflow_(workflow)
    sheet_key = payload.get('sheet')
    sheet_name = _sheet_name_(spec, sheet_key)

    raw_rows = payload.get('rows')
    if not raw_rows or not isinstance(raw_rows, list):
        raise ApiError('BAD_REQUEST')
    if len(raw_rows) > 2000:
        raise ApiError('BAD_REQUEST')  # sanity cap - split larger files into batches

    existing_rows = read_sheet_as_objects_(sheet_name)
    next_sl_no = (max((int(float(r.get('Sl No') or 0)) for r in existing_rows), default=0) + 1) if existing_rows else 1

    known_branches = {normalize_branch_name_(b['name']) for b in list_branches_(True)}
    seen_mids_this_batch = set()

    results = []
    inserted = 0
    touched_branches = set()

    for idx, raw_row in enumerate(raw_rows):
        row_num = idx + 1
        if not isinstance(raw_row, dict) or not any(str(v or '').strip() for v in raw_row.values()):
            continue  # silently skip fully blank rows (common at the end of a spreadsheet)
        mid_for_report = str(raw_row.get('MID') or '').strip() or '(no MID)'
        try:
            row = _normalize_row_(spec, raw_row, sheet_key, next_sl_no)
            if row['MID'] in seen_mids_this_batch:
                raise ValueError(f"MID {row['MID']} is duplicated earlier in this same file")
            seen_mids_this_batch.add(row['MID'])
            warning = None
            if row['Branch'] not in known_branches:
                warning = f"branch '{row['Branch']}' is not in your Branches list yet"
            append_row_(sheet_name, row)
            next_sl_no += 1
            inserted += 1
            touched_branches.add(row['Branch'])
            results.append({'row': row_num, 'mid': row['MID'], 'status': 'inserted', 'warning': warning})
        except ValueError as exc:
            results.append({'row': row_num, 'mid': mid_for_report, 'status': 'skipped', 'reason': str(exc)})

    log_audit_(
        user['email'], 'BULK_IMPORT',
        f"Bulk imported {inserted} of {len(raw_rows)} row(s) into {sheet_name} ({spec['label']})",
        'ALL', payload.get('browser'),
    )
    invalidate_cache_(['dashboard_ALL'] + [f'dashboard_{b}' for b in touched_branches])

    return {
        'total': len(raw_rows),
        'inserted': inserted,
        'skipped': len(raw_rows) - inserted,
        'results': results,
    }


# ---------------------------------------------------------------
# Bulk delete
# ---------------------------------------------------------------

def bulk_delete_(user, payload):
    """
    Admin-only, irreversible. payload: { workflow, sheet:
    'active'|'completed', branches: [...] ('ALL' or omit for every
    branch), mids: [...] (optional - restrict to exactly these MIDs),
    confirm: must be the literal string 'DELETE' }.
    Returns { deleted, mids }.
    """
    require_role_(user, [config.ROLE_ADMIN])
    if str(payload.get('confirm') or '') != 'DELETE':
        raise ApiError('BAD_REQUEST')

    workflow = payload.get('workflow')
    spec = _get_workflow_(workflow)
    sheet_name = _sheet_name_(spec, payload.get('sheet'))

    rows = read_sheet_as_objects_(sheet_name)

    branches = payload.get('branches') or []
    branches = [normalize_branch_name_(b) for b in branches if str(b or '').strip()]
    if branches and 'ALL' not in branches:
        rows = [r for r in rows if normalize_branch_name_(r.get('Branch')) in branches]

    mids = payload.get('mids') or []
    mids = {str(m).strip() for m in mids if str(m or '').strip()}
    if mids:
        rows = [r for r in rows if str(r.get('MID', '')).strip() in mids]

    if not rows:
        return {'deleted': 0, 'mids': []}

    deleted_mids = []
    touched_branches = set()
    screenshot_keys = []
    for row in rows:
        delete_row_(sheet_name, row['__row'])
        screenshot_keys.extend(collect_screenshot_keys_(row))
        deleted_mids.append(row.get('MID'))
        touched_branches.add(normalize_branch_name_(row.get('Branch')))

    storage.delete_screenshots_(screenshot_keys)

    log_audit_(
        user['email'], 'BULK_DELETE',
        f"Bulk deleted {len(deleted_mids)} row(s) from {sheet_name} ({spec['label']}, "
        f"branches: {', '.join(branches) if branches and 'ALL' not in branches else 'ALL'})",
        'ALL', payload.get('browser'),
    )
    invalidate_cache_(['dashboard_ALL'] + [f'dashboard_{b}' for b in touched_branches])

    return {'deleted': len(deleted_mids), 'mids': deleted_mids}