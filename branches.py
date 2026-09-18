"""
branches.py
Admin-managed list of branches. Direct port of Branches.gs.

Branches are SOFT-deleted only: deleting a branch just marks it
Active = FALSE. It disappears from every normal dropdown but
existing Users/Students/Completed rows that already reference it
are completely untouched, and it can be brought back with
branches.reactivate (or by re-creating it with the same name).
"""
import config
from db_utils import read_sheet_as_objects_, append_row_, update_row_fields_, now_iso_
from auth import ApiError
from audit_log import log_audit_


def is_branch_active_(row):
    """
    A branch row counts as active unless its Active cell is
    explicitly FALSE/false/0/No. Older rows that pre-date the Active
    column (blank cell) are treated as active.
    """
    v = row.get('Active')
    return v not in (False, 'FALSE', 'false', 'No', 'no', 0)


def normalize_branch_name_(name):
    return str(name or '').strip().upper()


def list_branches_(include_inactive):
    """
    include_inactive=False (default): what every normal dropdown/
    filter should call - only branches currently in use.
    include_inactive=True: Admin branch-management screen only.
    """
    rows = read_sheet_as_objects_(config.SHEET_BRANCHES)
    filtered = rows if include_inactive else [r for r in rows if is_branch_active_(r)]
    return [{'name': r.get('Branch Name'), 'active': is_branch_active_(r)} for r in filtered]


def create_branch_(acting_user, payload):
    """
    Admin-only. Creates a new branch, or - if a branch with that
    name already exists but was soft-deleted - reactivates it
    instead of creating a duplicate row.
    """
    name = normalize_branch_name_(payload.get('name'))
    if not name:
        raise ApiError('BAD_REQUEST')

    rows = read_sheet_as_objects_(config.SHEET_BRANCHES)
    existing = next((r for r in rows if normalize_branch_name_(r.get('Branch Name')) == name), None)

    if existing:
        if is_branch_active_(existing):
            raise ApiError('BAD_REQUEST')  # already exists and is active
        update_row_fields_(config.SHEET_BRANCHES, existing['__row'], {'Active': True})
        log_audit_(acting_user['email'], 'UPDATE', 'Reactivated branch ' + name, name, payload.get('browser'))
        return {'success': True, 'name': name, 'reactivated': True}

    append_row_(config.SHEET_BRANCHES, {'Branch Name': name, 'Active': True})
    log_audit_(acting_user['email'], 'CREATE', 'Created branch ' + name, name, payload.get('browser'))
    return {'success': True, 'name': name}


def delete_branch_(acting_user, payload):
    """Admin-only. SOFT delete: flips Active to FALSE."""
    name = normalize_branch_name_(payload.get('name'))
    if not name:
        raise ApiError('BAD_REQUEST')

    rows = read_sheet_as_objects_(config.SHEET_BRANCHES)
    match = next((r for r in rows if normalize_branch_name_(r.get('Branch Name')) == name), None)
    if not match:
        raise ApiError('BAD_REQUEST')

    update_row_fields_(config.SHEET_BRANCHES, match['__row'], {'Active': False})
    log_audit_(acting_user['email'], 'DELETE',
               'Deactivated branch ' + name + ' (soft delete - existing records untouched)',
               name, payload.get('browser'))
    return {'success': True}


def reactivate_branch_(acting_user, payload):
    """Admin-only. Undoes a soft delete."""
    name = normalize_branch_name_(payload.get('name'))
    if not name:
        raise ApiError('BAD_REQUEST')

    rows = read_sheet_as_objects_(config.SHEET_BRANCHES)
    match = next((r for r in rows if normalize_branch_name_(r.get('Branch Name')) == name), None)
    if not match:
        raise ApiError('BAD_REQUEST')

    update_row_fields_(config.SHEET_BRANCHES, match['__row'], {'Active': True})
    log_audit_(acting_user['email'], 'UPDATE', 'Reactivated branch ' + name, name, payload.get('browser'))
    return {'success': True}
