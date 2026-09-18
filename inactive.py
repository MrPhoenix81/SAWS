"""
inactive.py
Backend workflow for student inactivity.

Workflow:
    SCM submits -> Head Office approves/rejects -> Admin approves/rejects.

There is intentionally NO HOF or Manager stage in this workflow.
Active requests live in InactiveResponse. Final approved requests are
moved to InactiveCompleted.
"""
from datetime import datetime
import base64

import config
import storage
from db_utils import (
    read_sheet_as_objects_, append_row_, update_row_fields_, delete_row_,
    invalidate_cache_, now_iso_, format_date_only_, screenshot_keys_, collect_screenshot_keys_,
)
from auth import ApiError, require_role_
from audit_log import log_audit_
from notifications import notify_branch_roles_
from filters import is_admin_final_approved_, days_since_last_present_


def _normalize_screenshot_list_(screenshots, legacy_screenshot):
    """
    SCM may attach multiple supporting images (config.SCREENSHOT_MAX_COUNT)
    when submitting an inactive request. Accepts the new `screenshots`
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
    images SCM may attach when submitting an inactive request. Never
    required - returns [] when none were provided. Returns the list
    of storage keys to save on the row otherwise.
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
    return storage.upload_screenshots_(files, mid, 'INACTIVE')


def _find_row_(sheet_name, mid):
    if not mid:
        raise ApiError('BAD_REQUEST')
    rows = read_sheet_as_objects_(sheet_name)
    for row in rows:
        if str(row.get('MID', '')).strip() == str(mid).strip():
            return row
    return None


def _find_active_(mid):
    row = _find_row_(config.SHEET_INACTIVE_RESPONSE, mid)
    if not row:
        raise ApiError('STUDENT_NOT_FOUND')
    return row


def _find_any_(mid, preferred='active'):
    preferred_sheet = (
        config.SHEET_INACTIVE_COMPLETED
        if preferred == 'completed'
        else config.SHEET_INACTIVE_RESPONSE
    )
    other_sheet = (
        config.SHEET_INACTIVE_RESPONSE
        if preferred_sheet == config.SHEET_INACTIVE_COMPLETED
        else config.SHEET_INACTIVE_COMPLETED
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
    """Return a row plus server-authoritative action permissions."""
    result = {k: v for k, v in row.items() if k != '__row'}
    status = row.get('Status')

    result['canEdit'] = (
        user['role'] == config.ROLE_SCM and
        row.get('Branch') == user.get('branch') and
        status == config.STATUS_INACTIVE_PENDING_SCM
    ) or user['role'] == config.ROLE_ADMIN

    result['canHeadOfficeApprove'] = (
        user['role'] in (config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN) and
        status == config.STATUS_INACTIVE_PENDING_HEAD_OFFICE
    )
    result['canHeadOfficeReject'] = result['canHeadOfficeApprove']
    result['canAdminApprove'] = (
        user['role'] == config.ROLE_ADMIN and
        status == config.STATUS_INACTIVE_PENDING_ADMIN
    )
    result['canAdminReject'] = result['canAdminApprove']
    result['canDelete'] = user['role'] in (config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE)

    # Distinct from 'canEdit' (which is always True for Admin so it can
    # edit any row) - this is only True when this SPECIFIC row is
    # sitting in THIS user's queue right now, i.e. it's their turn to
    # act on it. Drives the "Needs Your Attention" table split on the
    # frontend (see students.py's equivalent flag for the parallel
    # implementation).
    result['Awaiting My Action'] = (
        (user['role'] == config.ROLE_SCM and row.get('Branch') == user.get('branch') and
         status == config.STATUS_INACTIVE_PENDING_SCM) or
        (user['role'] == config.ROLE_HEAD_OFFICE and status == config.STATUS_INACTIVE_PENDING_HEAD_OFFICE) or
        (user['role'] == config.ROLE_ADMIN and status == config.STATUS_INACTIVE_PENDING_ADMIN)
    )

    # Never send the raw storage key to the browser - only whether one
    # was uploaded. Head Office/Admin fetch a short-lived signed URL
    # on demand via get_inactive_screenshot_url_.
    result['Screenshot Uploaded'] = bool(screenshot_keys_(result.pop(config.SCREENSHOT_FIELD_INACTIVE, None)))

    # Item 1: SCM's own Reason is hidden while the request is under
    # review (submitted, awaiting Head Office/Admin) and becomes
    # visible again only once SCM may edit it (e.g. after a rejection)
    # or once Admin has given FINAL approval. Head Office/Admin always
    # see it - they need it to make their decision.
    if user['role'] == config.ROLE_SCM and not (result['canEdit'] or is_admin_final_approved_(row)):
        result['Reason'] = ''

    # Item 2: 'Days Since Last Present' is always computed fresh from
    # 'Last Present Day', never a stale value stored at submission time.
    result['Days Since Last Present'] = days_since_last_present_(row)
    return result


def _next_sl_no_():
    rows = read_sheet_as_objects_(config.SHEET_INACTIVE_RESPONSE)
    completed = read_sheet_as_objects_(config.SHEET_INACTIVE_COMPLETED)
    values = []
    for row in rows + completed:
        try:
            values.append(int(row.get('Sl No') or 0))
        except (TypeError, ValueError):
            pass
    return max(values, default=0) + 1


def submit_inactive_(user, payload):
    """SCM creates an inactive request for their own branch."""
    require_role_(user, [config.ROLE_SCM])

    mid = str(payload.get('mid') or '').strip()
    student_name = str(payload.get('studentName') or '').strip()
    inactive_from = payload.get('inactiveFrom') or ''
    reason = str(payload.get('reason') or '').strip()

    if not mid or not student_name or not inactive_from or not reason:
        raise ApiError('BAD_REQUEST')

    # Do not allow two simultaneous inactive records for the same MID.
    if _find_row_(config.SHEET_INACTIVE_RESPONSE, mid) or _find_row_(config.SHEET_INACTIVE_COMPLETED, mid):
        raise ApiError('MID_ALREADY_EXISTS')

    # Optional supporting image(s) - never required to submit an inactive
    # request. SCM may attach multiple (config.SCREENSHOT_MAX_COUNT).
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
        'Last Present Day': format_date_only_(inactive_from),
        'Reason': reason,
        config.SCREENSHOT_FIELD_INACTIVE: screenshot_keys,
        'Status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
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

    append_row_(config.SHEET_INACTIVE_RESPONSE, row)

    notify_branch_roles_(
        row['Branch'], [config.ROLE_HEAD_OFFICE],
        f"New inactive request submitted for {row['Student Name']} ({row['MID']}).",
        config.NOTIF_SUBMITTED, row['MID'],
        config.PAGE_INACTIVE
    )
    log_audit_(
        user['email'], 'CREATE',
        f"Submitted inactive request for {row['MID']}",
        row['Branch'], payload.get('browser')
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return _serialize_(row, user)


def list_inactive_(user, completed=False, params=None):
    """List active or approved inactive requests visible to the signed-in user."""
    params = params or {}
    sheet = config.SHEET_INACTIVE_COMPLETED if completed else config.SHEET_INACTIVE_RESPONSE
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

    # Item 6: same server-side enforcement as the Discontinue workflow -
    # Admin's Active page shows ONLY requests pending Admin; Head
    # Office's Active page shows ONLY requests pending Head Office.
    if not completed:
        if user['role'] == config.ROLE_ADMIN:
            rows = [r for r in rows if r.get('Status') == config.STATUS_INACTIVE_PENDING_ADMIN]
        elif user['role'] == config.ROLE_HEAD_OFFICE:
            rows = [r for r in rows if r.get('Status') == config.STATUS_INACTIVE_PENDING_HEAD_OFFICE]

    rows.sort(key=lambda r: str(r.get('Entry Date') or ''), reverse=True)

    page = max(int(params.get('page') or 1), 1)
    page_size = max(min(int(params.get('pageSize') or 25), 200), 1)
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
            if r.get('Branch') == user.get('branch') and r.get('Status') == config.STATUS_INACTIVE_PENDING_SCM
        )
    elif role == config.ROLE_HEAD_OFFICE:
        pending_for_me = sum(1 for r in rows if r.get('Status') == config.STATUS_INACTIVE_PENDING_HEAD_OFFICE)
    elif role == config.ROLE_ADMIN:
        pending_for_me = sum(1 for r in rows if r.get('Status') == config.STATUS_INACTIVE_PENDING_ADMIN)
    else:
        pending_for_me = 0

    return {
        'total': len(rows),
        'page': page,
        'pageSize': page_size,
        'rows': [_serialize_(r, user) for r in page_rows],
        'pendingForMe': pending_for_me,
    }


def head_office_approve_inactive_(user, mid, browser):
    """Head Office sends an inactive request to Admin for final approval."""
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = _find_active_(mid)

    if not _branch_visible_(user, row):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_INACTIVE_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')

    now = now_iso_()
    update_row_fields_(config.SHEET_INACTIVE_RESPONSE, row['__row'], {
        'Status': config.STATUS_INACTIVE_PENDING_ADMIN,
        'Head Office Decision': 'APPROVED',
        'Head Office Name': user['name'],
        'Head Office Date': now,
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_ADMIN],
        f"Inactive request for {row['Student Name']} ({mid}) is approved by Head Office and awaits Admin approval.",
        config.NOTIF_READY_ADMIN, mid,
        config.PAGE_INACTIVE
    )
    log_audit_(user['email'], 'APPROVE',
               f"Head Office approved inactive request {mid}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def head_office_reject_inactive_(user, mid, rejection_reason, browser):
    """Head Office rejects an inactive request and returns it to SCM."""
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = _find_active_(mid)

    if not _branch_visible_(user, row):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_INACTIVE_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')
    if not str(rejection_reason or '').strip():
        raise ApiError('BAD_REQUEST')

    now = now_iso_()
    update_row_fields_(config.SHEET_INACTIVE_RESPONSE, row['__row'], {
        'Status': config.STATUS_INACTIVE_PENDING_SCM,
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
        f"Inactive request for {row['Student Name']} ({mid}) was rejected by Head Office. Reason: {rejection_reason}",
        config.NOTIF_HEAD_OFFICE_REJECTED, mid,
        config.PAGE_INACTIVE
    )
    log_audit_(user['email'], 'REJECT',
               f"Head Office rejected inactive request {mid}: {rejection_reason}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def admin_approve_inactive_(user, mid, browser):
    """Admin gives final approval and moves the row to InactiveCompleted."""
    require_role_(user, [config.ROLE_ADMIN])
    row = _find_active_(mid)

    if row.get('Status') != config.STATUS_INACTIVE_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')

    completed = dict(row)
    completed.pop('__row', None)
    completed['Status'] = config.STATUS_INACTIVE_APPROVED
    completed['Admin Approval'] = 'APPROVED'
    completed['Admin Name'] = user['name']
    completed['Approval Date'] = now_iso_()

    append_row_(config.SHEET_INACTIVE_COMPLETED, completed)
    delete_row_(config.SHEET_INACTIVE_RESPONSE, row['__row'])

    notify_branch_roles_(
        row['Branch'],
        [config.ROLE_SCM, config.ROLE_HEAD_OFFICE],
        f"Inactive request for {row['Student Name']} ({mid}) received final Admin approval.",
        config.NOTIF_APPROVED, mid,
        config.PAGE_INACTIVE
    )
    log_audit_(user['email'], 'APPROVE',
               f"Admin approved inactive request {mid}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def admin_reject_inactive_(user, mid, rejection_reason, browser):
    """Admin rejects an inactive request and returns it to SCM."""
    require_role_(user, [config.ROLE_ADMIN])
    row = _find_active_(mid)

    if row.get('Status') != config.STATUS_INACTIVE_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')
    if not str(rejection_reason or '').strip():
        raise ApiError('BAD_REQUEST')

    now = now_iso_()
    update_row_fields_(config.SHEET_INACTIVE_RESPONSE, row['__row'], {
        'Status': config.STATUS_INACTIVE_PENDING_SCM,
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
        f"Inactive request for {row['Student Name']} ({mid}) was rejected by Admin. Reason: {rejection_reason}",
        config.NOTIF_REJECTED, mid,
        config.PAGE_INACTIVE
    )
    log_audit_(user['email'], 'REJECT',
               f"Admin rejected inactive request {mid}: {rejection_reason}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def head_office_update_inactive_(user, mid, fields, browser):
    """Head Office can edit inactive data and reason while reviewing the request."""
    require_role_(user, [config.ROLE_HEAD_OFFICE])
    if not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    sheet, row = _find_any_(mid, 'active')
    allowed = {
        'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2',
        'Phone Number 3', 'Last Present Day', 'Reason',
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
                config.SHEET_INACTIVE_RESPONSE,
                config.SHEET_INACTIVE_COMPLETED,
            ):
                for other in read_sheet_as_objects_(other_sheet):
                    if str(other.get('MID', '')).strip() == new_mid and other.get('__row') != row.get('__row'):
                        raise ApiError('MID_ALREADY_EXISTS')
            update['MID'] = new_mid

    if 'Last Present Day' in update:
        update['Last Present Day'] = format_date_only_(update['Last Present Day'])

    update_row_fields_(sheet, row['__row'], update)
    log_audit_(user['email'], 'UPDATE',
               f"Head Office edited inactive request {mid}: {', '.join(update.keys())}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def admin_update_inactive_(user, mid, fields, browser):
    """Admin may edit the editable inactive fields at any time."""
    require_role_(user, [config.ROLE_ADMIN])
    if not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    sheet, row = _find_any_(mid, 'active')
    allowed = {
        'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2',
        'Phone Number 3', 'Last Present Day', 'Reason', 'Branch',
    }
    update = {k: v for k, v in fields.items() if k in allowed}

    if 'Last Present Day' in update:
        update['Last Present Day'] = format_date_only_(update['Last Present Day'])

    if 'MID' in update and str(update['MID']) != str(mid):
        new_mid = str(update['MID']).strip()
        if not new_mid:
            raise ApiError('BAD_REQUEST')
        for other_sheet in (config.SHEET_INACTIVE_RESPONSE, config.SHEET_INACTIVE_COMPLETED):
            for other in read_sheet_as_objects_(other_sheet):
                if str(other.get('MID', '')).strip() == new_mid and other.get('__row') != row.get('__row'):
                    raise ApiError('MID_ALREADY_EXISTS')

    if update:
        update_row_fields_(sheet, row['__row'], update)

    log_audit_(user['email'], 'UPDATE',
               f"Admin edited inactive request {mid}: {', '.join(update.keys())}",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def get_inactive_screenshot_url_(user, mid, sheet_key, browser):
    """
    Admin/Head Office only: returns a short-lived (5 min) signed URL
    for the optional supporting image SCM attached to this inactive
    request. Every view is audit-logged.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    sheet, row = _find_any_(mid, sheet_key)
    keys = screenshot_keys_(row.get(config.SCREENSHOT_FIELD_INACTIVE))
    if not keys:
        raise ApiError('STUDENT_NOT_FOUND')
    log_audit_(user['email'], 'VIEW', f'Viewed inactive request image(s) for {mid}', row['Branch'], browser)
    return {'urls': storage.get_signed_urls_(keys)}


def delete_inactive_(user, mid, sheet_key, confirm_mid, browser):
    """
    Admin or Head Office permanently deletes an inactive record. The
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
        f"({user['role']}) deleted inactive request {mid} from {sheet}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}


def submit_inactive_correction_(user, mid, fields, browser):
    """
    SCM corrects an inactive request after Head Office/Admin rejection.
    The request is returned to Head Office after SCM resubmits.
    """
    require_role_(user, [config.ROLE_SCM])
    row = _find_active_(mid)

    if row.get('Branch') != user.get('branch'):
        raise ApiError('AUTH_FORBIDDEN')
    if row.get('Status') != config.STATUS_INACTIVE_PENDING_SCM:
        raise ApiError('AUTH_FORBIDDEN')
    if not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    allowed = {
        'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2',
        'Phone Number 3', 'Last Present Day', 'Reason',
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
            if _find_row_(config.SHEET_INACTIVE_RESPONSE, new_mid) or _find_row_(config.SHEET_INACTIVE_COMPLETED, new_mid):
                raise ApiError('MID_ALREADY_EXISTS')
            update['MID'] = new_mid

    if 'Last Present Day' in update:
        update['Last Present Day'] = format_date_only_(update['Last Present Day'])

    update.update({
        'Status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
        'Head Office Decision': '',
        'Head Office Name': '',
        'Head Office Date': '',
        'Last Rejection Reason': '',
        'Last Rejected By': '',
        'Last Rejected Stage': '',
        'Last Rejected Date': '',
    })

    update_row_fields_(config.SHEET_INACTIVE_RESPONSE, row['__row'], update)

    notify_branch_roles_(
        row['Branch'], [config.ROLE_HEAD_OFFICE],
        f"Corrected inactive request for {row['Student Name']} ({update.get('MID', mid)}) is ready for Head Office review.",
        config.NOTIF_SUBMITTED, update.get('MID', mid),
        config.PAGE_INACTIVE
    )
    log_audit_(
        user['email'], 'UPDATE',
        f"SCM corrected inactive request {mid}",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])
    return {'success': True}