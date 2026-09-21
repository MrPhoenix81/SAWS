"""
transfer.py
Backend workflow for student branch transfers.

Workflow:
    SCM submits -> Head Office approves/rejects -> Admin approves/rejects.

There is intentionally NO HOF or Manager stage.

Active requests live in TransferResponse. Final approved requests are
moved to TransferCompleted.

Admin does not edit transfer requests; Admin can only approve, reject,
or delete, matching the frontend permission rules.
"""
import base64

import config
import storage
from db_utils import (
    read_sheet_as_objects_, append_row_, update_row_fields_, delete_row_,
    invalidate_cache_, now_iso_, screenshot_keys_, collect_screenshot_keys_,
)
from auth import ApiError, require_role_
from audit_log import log_audit_
from notifications import notify_branch_roles_
from filters import is_admin_final_approved_


def _normalize_screenshot_list_(screenshots, legacy_screenshot):
    """
    SCM may attach multiple supporting images (config.SCREENSHOT_MAX_COUNT)
    when submitting a transfer request. Accepts the new `screenshots`
    list if present, otherwise falls back to wrapping the legacy
    singular `screenshot` field so older frontend builds keep working.
    """
    if screenshots:
        if not isinstance(screenshots, list):
            raise ApiError('BAD_REQUEST')
        return screenshots
    return [legacy_screenshot] if legacy_screenshot else []


def _upload_screenshots_(mid, screenshots):
    """
    Validates and uploads up to config.SCREENSHOT_MAX_COUNT supporting
    images SCM may attach when submitting a transfer request. Unlike
    the discontinuation call-log screenshot, this is never required -
    returns [] when none were provided. Returns the list of storage
    keys to save on the row otherwise.
    """
    if not screenshots:
        return []
    if len(screenshots) > config.SCREENSHOT_MAX_COUNT:
        raise ApiError('BAD_REQUEST')
    files = []
    for screenshot in screenshots:
        if not screenshot or not screenshot.get('base64'):
            continue
        mime_type = screenshot.get('mimeType')
        if mime_type not in config.SCREENSHOT_ALLOWED_MIME_TYPES:
            raise ApiError('BAD_REQUEST')
        try:
            file_bytes = base64.b64decode(screenshot['base64'], validate=True)
        except Exception:
            raise ApiError('BAD_REQUEST')
        if not file_bytes or len(file_bytes) > config.SCREENSHOT_MAX_BYTES:
            raise ApiError('BAD_REQUEST')
        files.append((file_bytes, mime_type))
    if not files:
        return []
    return storage.upload_screenshots_(files, mid, 'TRANSFER')


def _find_row_(sheet_name, mid):
    if not mid:
        raise ApiError('BAD_REQUEST')
    rows = read_sheet_as_objects_(sheet_name)
    for row in rows:
        if str(row.get('MID', '')).strip() == str(mid).strip():
            return row
    return None


def _find_active_(mid):
    row = _find_row_(config.SHEET_TRANSFER_RESPONSE, mid)
    if not row:
        raise ApiError('STUDENT_NOT_FOUND')
    return row


def _find_any_(mid, preferred='active'):
    preferred_sheet = (
        config.SHEET_TRANSFER_COMPLETED
        if preferred == 'completed'
        else config.SHEET_TRANSFER_RESPONSE
    )
    other_sheet = (
        config.SHEET_TRANSFER_RESPONSE
        if preferred_sheet == config.SHEET_TRANSFER_COMPLETED
        else config.SHEET_TRANSFER_COMPLETED
    )
    row = _find_row_(preferred_sheet, mid)
    if row:
        return preferred_sheet, row
    row = _find_row_(other_sheet, mid)
    if row:
        return other_sheet, row
    raise ApiError('STUDENT_NOT_FOUND')


def _branch_visible_(user, row):
    if user['role'] in config.GLOBAL_VISIBILITY_ROLES:
        return True
    return row.get('Branch') == user.get('branch')


def _serialize_(row, user):
    result = {k: v for k, v in row.items() if k != '__row'}
    status = row.get('Status')

    # Only SCM can correct a rejected transfer for its own branch.
    result['canEdit'] = (
        user['role'] == config.ROLE_SCM
        and row.get('Branch') == user.get('branch')
        and status == config.STATUS_TRANSFER_PENDING_SCM
    )

    result['canHeadOfficeApprove'] = (
        user['role'] in (config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN)
        and status == config.STATUS_TRANSFER_PENDING_HEAD_OFFICE
    )
    result['canHeadOfficeReject'] = result['canHeadOfficeApprove']

    result['canAdminApprove'] = (
        user['role'] == config.ROLE_ADMIN
        and status == config.STATUS_TRANSFER_PENDING_ADMIN
    )
    result['canAdminReject'] = result['canAdminApprove']

    result['canDelete'] = user['role'] in (config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE)
    # Intentionally no canAdminEdit permission.
    result['canAdminEdit'] = False

    # True only when this SPECIFIC row is sitting in THIS user's queue
    # right now - drives the "Needs Your Attention" table split on the
    # frontend (see inactive.py / students.py for the parallel flag).
    result['Awaiting My Action'] = (
        result['canEdit'] or result['canHeadOfficeApprove'] or result['canAdminApprove']
    )

    # Never send the raw storage key to the browser - only whether one
    # was uploaded. Head Office/Admin fetch a short-lived signed URL
    # on demand via get_transfer_screenshot_url_.
    result['Screenshot Uploaded'] = bool(screenshot_keys_(result.pop(config.SCREENSHOT_FIELD_TRANSFER, None)))

    # Item 1: SCM's own Reason is hidden while the request is under
    # review and becomes visible again only once SCM may edit it
    # (e.g. after a rejection) or once Admin has given FINAL approval.
    if user['role'] == config.ROLE_SCM and not (result['canEdit'] or is_admin_final_approved_(row)):
        result['Reason'] = ''
    return result


def _next_sl_no_():
    rows = read_sheet_as_objects_(config.SHEET_TRANSFER_RESPONSE)
    completed = read_sheet_as_objects_(config.SHEET_TRANSFER_COMPLETED)
    values = []
    for row in rows + completed:
        try:
            values.append(int(row.get('Sl No') or 0))
        except (TypeError, ValueError):
            pass
    return max(values, default=0) + 1


def _active_branch_names_():
    rows = read_sheet_as_objects_(config.SHEET_BRANCHES)
    names = set()
    for row in rows:
        active = row.get('Active')
        if active in (True, 'TRUE', 'true', 1, '1', 'Yes', 'YES', 'yes', ''):
            name = str(row.get('Branch Name', '')).strip()
            if name:
                names.add(name)
    return names


def _validate_target_branch_(source_branch, target_branch):
    target_branch = str(target_branch or '').strip()
    if not target_branch:
        raise ApiError('BAD_REQUEST')
    if target_branch == str(source_branch or '').strip():
        raise ApiError('BAD_REQUEST')
    if target_branch not in _active_branch_names_():
        raise ApiError('BAD_REQUEST')
    return target_branch


def submit_transfer_(user, payload):
    """SCM creates a transfer request for their own branch."""
    require_role_(user, [config.ROLE_SCM])

    mid = str(payload.get('mid') or '').strip()
    student_name = str(payload.get('studentName') or '').strip()
    reason = str(payload.get('reason') or '').strip()
    target_branch = _validate_target_branch_(user.get('branch'), payload.get('transferToBranch'))

    if not mid or not student_name or not reason:
        raise ApiError('BAD_REQUEST')

    # Prevent duplicate active/completed transfer records for the same MID.
    if _find_row_(config.SHEET_TRANSFER_RESPONSE, mid) or _find_row_(config.SHEET_TRANSFER_COMPLETED, mid):
        raise ApiError('MID_ALREADY_EXISTS')

    # Optional supporting image(s) - never required to submit a transfer.
    # SCM may attach multiple (config.SCREENSHOT_MAX_COUNT).
    screenshots_in = _normalize_screenshot_list_(payload.get('screenshots'), payload.get('screenshot'))
    screenshot_keys = _upload_screenshots_(mid, screenshots_in)

    row = {
        'Sl No': _next_sl_no_(),
        'Branch': user['branch'],
        'MID': mid,
        'Student Name': student_name,
        'Phone Number 1': payload.get('phone1') or '',
        'Phone Number 2': payload.get('phone2') or '',
        'Phone Number 3': payload.get('phone3') or '',
        'Transfer To Branch': target_branch,
        'Reason': reason,
        config.SCREENSHOT_FIELD_TRANSFER: screenshot_keys,
        'Status': config.STATUS_TRANSFER_PENDING_HEAD_OFFICE,
        'Entry Date': now_iso_(),
        'Head Office Decision': '',
        'Head Office Name': '',
        'Head Office Date': '',
        'Admin Approval': '',
        'Admin Name': '',
        'Approval Date': '',
        'Last Rejection Reason': '',
        'Last Rejected By': '',
        'Last Rejected Stage': '',
        'Last Rejected Date': '',
    }

    append_row_(config.SHEET_TRANSFER_RESPONSE, row)

    notify_branch_roles_(
        row['Branch'], [config.ROLE_HEAD_OFFICE],
        f"New transfer request submitted for {row['Student Name']} ({row['MID']}) to {row['Transfer To Branch']}.",
        config.NOTIF_SUBMITTED, row['MID'],
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'CREATE',
        f"Submitted transfer request for {row['MID']} to {row['Transfer To Branch']}",
        row['Branch'], payload.get('browser')
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return _serialize_(row, user)


def list_transfer_(user, completed=False, params=None):
    """List active or approved transfer requests visible to the signed-in user."""
    params = params or {}
    sheet = config.SHEET_TRANSFER_COMPLETED if completed else config.SHEET_TRANSFER_RESPONSE
    rows = read_sheet_as_objects_(sheet)

    if user['role'] not in config.GLOBAL_VISIBILITY_ROLES:
        rows = [r for r in rows if r.get('Branch') == user.get('branch')]

    if params.get('search'):
        q = str(params['search']).strip().lower()
        rows = [
            r for r in rows
            if q in str(r.get('MID', '')).lower()
            or q in str(r.get('Student Name', '')).lower()
            or any(q in str(r.get(k, '')).lower() for k in
                   ('Phone Number 1', 'Phone Number 2', 'Phone Number 3'))
        ]

    if params.get('branch') and user['role'] in config.GLOBAL_VISIBILITY_ROLES:
        rows = [r for r in rows if r.get('Branch') == params['branch']]

    if params.get('status'):
        rows = [r for r in rows if r.get('Status') == params['status']]

    # Admin's Active page still shows ONLY requests pending Admin.
    # Head Office is NOT restricted any more: it sees every request at
    # every stage (like the Discontinue workflow), so it can still
    # follow a request after it moves on to Admin. The frontend uses
    # the 'Awaiting My Action' flag to separate the ones needing
    # Head Office's own decision.
    if not completed:
        if user['role'] == config.ROLE_ADMIN:
            rows = [r for r in rows if r.get('Status') == config.STATUS_TRANSFER_PENDING_ADMIN]

    rows.sort(key=lambda r: str(r.get('Entry Date') or ''), reverse=True)

    # Column sort requested from the table header (MID, student name,
    # branch or status). It replaces the default ordering below.
    sort_by = params.get('sortBy')
    if sort_by in ('MID', 'Student Name', 'Branch', 'Status'):
        descending = str(params.get('sortDir') or 'asc').lower() == 'desc'
        rows.sort(key=lambda r: str(r.get(sort_by) or '').lower(), reverse=descending)
    # Head Office: bubble requests sitting in its own queue to the top
    # (stable sort keeps the newest-first order inside each group).
    elif not completed and user['role'] == config.ROLE_HEAD_OFFICE:
        rows.sort(key=lambda r: 0 if r.get('Status') == config.STATUS_TRANSFER_PENDING_HEAD_OFFICE else 1)

    page = max(int(params.get('page') or 1), 1)
    page_size = max(min(int(params.get('pageSize') or 25), 9999), 1)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    # "My turn" count for the sidebar badge (computed over every visible
    # active row, not just this page) - role-specific so the badge
    # clears once THIS user's part is done rather than staying lit for
    # everyone until the whole workflow finishes.
    role = user['role']
    if role == config.ROLE_SCM:
        pending_for_me = sum(
            1 for r in rows
            if r.get('Branch') == user.get('branch') and r.get('Status') == config.STATUS_TRANSFER_PENDING_SCM
        )
    elif role == config.ROLE_HEAD_OFFICE:
        pending_for_me = sum(1 for r in rows if r.get('Status') == config.STATUS_TRANSFER_PENDING_HEAD_OFFICE)
    elif role == config.ROLE_ADMIN:
        pending_for_me = sum(1 for r in rows if r.get('Status') == config.STATUS_TRANSFER_PENDING_ADMIN)
    else:
        pending_for_me = 0

    return {
        'total': len(rows),
        'page': page,
        'pageSize': page_size,
        'rows': [_serialize_(r, user) for r in page_rows],
        'pendingForMe': pending_for_me,
    }


def head_office_approve_transfer_(user, mid, browser):
    """Head Office sends a transfer request to Admin for final approval."""
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = _find_active_(mid)

    if not _branch_visible_(user, row):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_TRANSFER_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')

    now = now_iso_()
    update_row_fields_(config.SHEET_TRANSFER_RESPONSE, row['__row'], {
        'Status': config.STATUS_TRANSFER_PENDING_ADMIN,
        'Head Office Decision': 'APPROVED',
        'Head Office Name': user['name'],
        'Head Office Date': now,
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_ADMIN],
        f"Transfer request for {row['Student Name']} ({mid}) to {row['Transfer To Branch']} is approved by Head Office and awaits Admin approval.",
        config.NOTIF_READY_ADMIN, mid,
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'APPROVE',
        f"Head Office approved transfer request {mid}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def head_office_reject_transfer_(user, mid, rejection_reason, browser):
    """Head Office rejects a transfer request and returns it to SCM."""
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = _find_active_(mid)

    if not _branch_visible_(user, row):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_TRANSFER_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')
    if not str(rejection_reason or '').strip():
        raise ApiError('BAD_REQUEST')

    now = now_iso_()
    update_row_fields_(config.SHEET_TRANSFER_RESPONSE, row['__row'], {
        'Status': config.STATUS_TRANSFER_PENDING_SCM,
        'Head Office Decision': 'REJECTED',
        'Head Office Name': user['name'],
        'Head Office Date': now,
        'Last Rejection Reason': rejection_reason,
        'Last Rejected By': user['name'],
        'Last Rejected Stage': 'Head Office',
        'Last Rejected Date': now,
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_SCM],
        f"Transfer request for {row['Student Name']} ({mid}) was rejected by Head Office. Reason: {rejection_reason}",
        config.NOTIF_HEAD_OFFICE_REJECTED, mid,
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'REJECT',
        f"Head Office rejected transfer request {mid}: {rejection_reason}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def admin_approve_transfer_(user, mid, browser):
    """Admin gives final approval and moves the row to TransferCompleted."""
    require_role_(user, [config.ROLE_ADMIN])
    row = _find_active_(mid)

    if row.get('Status') != config.STATUS_TRANSFER_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')

    completed = dict(row)
    completed.pop('__row', None)
    completed['Status'] = config.STATUS_TRANSFER_APPROVED
    completed['Admin Approval'] = 'APPROVED'
    completed['Admin Name'] = user['name']
    completed['Approval Date'] = now_iso_()

    append_row_(config.SHEET_TRANSFER_COMPLETED, completed)
    delete_row_(config.SHEET_TRANSFER_RESPONSE, row['__row'])

    notify_branch_roles_(
        row['Branch'], [config.ROLE_SCM, config.ROLE_HEAD_OFFICE],
        f"Transfer request for {row['Student Name']} ({mid}) to {row['Transfer To Branch']} received final Admin approval.",
        config.NOTIF_APPROVED, mid,
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'APPROVE',
        f"Admin approved transfer request {mid}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def admin_reject_transfer_(user, mid, rejection_reason, browser):
    """Admin rejects a transfer request and returns it to SCM."""
    require_role_(user, [config.ROLE_ADMIN])
    row = _find_active_(mid)

    if row.get('Status') != config.STATUS_TRANSFER_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')
    if not str(rejection_reason or '').strip():
        raise ApiError('BAD_REQUEST')

    now = now_iso_()
    update_row_fields_(config.SHEET_TRANSFER_RESPONSE, row['__row'], {
        'Status': config.STATUS_TRANSFER_PENDING_SCM,
        'Admin Approval': 'REJECTED',
        'Admin Name': user['name'],
        'Approval Date': now,
        'Last Rejection Reason': rejection_reason,
        'Last Rejected By': user['name'],
        'Last Rejected Stage': 'Admin',
        'Last Rejected Date': now,
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_SCM],
        f"Transfer request for {row['Student Name']} ({mid}) was rejected by Admin. Reason: {rejection_reason}",
        config.NOTIF_REJECTED, mid,
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'REJECT',
        f"Admin rejected transfer request {mid}: {rejection_reason}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def get_transfer_screenshot_url_(user, mid, sheet_key, browser):
    """
    Admin/Head Office only: returns a short-lived (5 min) signed URL
    for the optional supporting image SCM attached to this transfer
    request. Every view is audit-logged.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    sheet, row = _find_any_(mid, sheet_key)
    keys = screenshot_keys_(row.get(config.SCREENSHOT_FIELD_TRANSFER))
    if not keys:
        raise ApiError('STUDENT_NOT_FOUND')
    log_audit_(user['email'], 'VIEW', f'Viewed transfer request image(s) for {mid}', row['Branch'], browser)
    return {'urls': storage.get_signed_urls_(keys)}


def delete_transfer_(user, mid, sheet_key, confirm_mid, browser):
    """
    Admin or Head Office permanently deletes a transfer record. The
    caller must re-type the exact MID as `confirm_mid` first, matching
    the Discontinue workflow's delete confirmation.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    if str(confirm_mid or '').strip() != str(mid or '').strip():
        raise ApiError('BAD_REQUEST')
    sheet, row = _find_any_(mid, sheet_key)

    delete_row_(sheet, row['__row'])
    storage.delete_screenshots_(collect_screenshot_keys_(row))
    log_audit_(
        user['email'], 'DELETE',
        f"({user['role']}) deleted transfer request {mid} from {sheet}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def head_office_update_transfer_(user, mid, fields, browser):
    """Head Office can edit transfer data and reason while reviewing the request."""
    require_role_(user, [config.ROLE_HEAD_OFFICE])
    if not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    sheet, row = _find_any_(mid, 'active')
    allowed = {
        'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2',
        'Phone Number 3', 'Transfer To Branch', 'Reason',
    }
    update = {k: v for k, v in fields.items() if k in allowed}
    if not update:
        raise ApiError('BAD_REQUEST')

    if 'MID' in update:
        new_mid = str(update['MID']).strip()
        if not new_mid:
            raise ApiError('BAD_REQUEST')
        if new_mid != str(mid).strip():
            for other_sheet in (
                config.SHEET_TRANSFER_RESPONSE,
                config.SHEET_TRANSFER_COMPLETED,
            ):
                for other in read_sheet_as_objects_(other_sheet):
                    if str(other.get('MID', '')).strip() == new_mid and other.get('__row') != row.get('__row'):
                        raise ApiError('MID_ALREADY_EXISTS')
            update['MID'] = new_mid

    if 'Transfer To Branch' in update:
        update['Transfer To Branch'] = _validate_target_branch_(
            row.get('Branch'), update['Transfer To Branch']
        )

    update_row_fields_(sheet, row['__row'], update)
    log_audit_(user['email'], 'UPDATE',
               f"Head Office edited transfer request {mid}: {', '.join(update.keys())}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def submit_transfer_correction_(user, mid, fields, browser):
    """SCM corrects a rejected transfer and returns it to Head Office."""
    require_role_(user, [config.ROLE_SCM])
    row = _find_active_(mid)

    if row.get('Branch') != user.get('branch'):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_TRANSFER_PENDING_SCM:
        raise ApiError('AUTH_FORBIDDEN')
    if not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    allowed = {
        'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2',
        'Phone Number 3', 'Transfer To Branch', 'Reason',
    }
    update = {k: v for k, v in fields.items() if k in allowed}
    if not update:
        raise ApiError('BAD_REQUEST')

    # Item 4: after a Head Office/Admin rejection, SCM must actually
    # change at least one field before resubmitting - identical values
    # across the board are rejected.
    if all(str(update[k]) == str(row.get(k, '')) for k in update):
        raise ApiError('REASON_UNCHANGED')

    if 'MID' in update:
        new_mid = str(update['MID']).strip()
        if not new_mid:
            raise ApiError('BAD_REQUEST')
        if new_mid != str(mid):
            if _find_row_(config.SHEET_TRANSFER_RESPONSE, new_mid) or _find_row_(config.SHEET_TRANSFER_COMPLETED, new_mid):
                raise ApiError('MID_ALREADY_EXISTS')
            update['MID'] = new_mid

    if 'Transfer To Branch' in update:
        update['Transfer To Branch'] = _validate_target_branch_(
            row.get('Branch'), update['Transfer To Branch']
        )

    update.update({
        'Status': config.STATUS_TRANSFER_PENDING_HEAD_OFFICE,
        'Head Office Decision': '',
        'Head Office Name': '',
        'Head Office Date': '',
        'Admin Approval': '',
        'Admin Name': '',
        'Approval Date': '',
        'Last Rejection Reason': '',
        'Last Rejected By': '',
        'Last Rejected Stage': '',
        'Last Rejected Date': '',
    })

    update_row_fields_(config.SHEET_TRANSFER_RESPONSE, row['__row'], update)

    notify_branch_roles_(
        row['Branch'], [config.ROLE_HEAD_OFFICE],
        f"Corrected transfer request for {row['Student Name']} ({update.get('MID', mid)}) is ready for Head Office review.",
        config.NOTIF_SUBMITTED, update.get('MID', mid),
        config.PAGE_TRANSFER
    )
    log_audit_(
        user['email'], 'UPDATE',
        f"SCM corrected transfer request {mid}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}