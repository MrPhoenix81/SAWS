"""
students.py
Core domain logic driving a discontinuation entry through:
  SCM -> (HOF and Manager, both required) -> Head Office -> Admin -> Discontinued
with a rejection loop: Head Office rejecting flags ONE OR MORE
specific roles (SCM / HOF / Manager) as needing to redo their
reason (see head_office_reject_). Only the flagged role(s) can edit;
everyone else stays locked. Once every flagged role has resubmitted,
the record goes back to Head Office automatically.

Admin rejecting (the separate, final-verification reject) still does
a full reset back to SCM, unchanged from before.
"""
from datetime import datetime
import base64

import config
import storage
from db_utils import (
    read_sheet_as_objects_, append_row_, update_row_fields_, delete_row_,
    invalidate_cache_, now_iso_, format_date_only_, mid_exists_anywhere_, validate_phone_numbers_,
    screenshot_keys_, collect_screenshot_keys_,
)
from auth import ApiError, require_role_
from audit_log import log_audit_
from notifications import notify_branch_roles_
from filters import (
    is_scm_editable_stage_, is_hof_editable_stage_, is_manager_editable_stage_,
    filter_student_rows_for_user_, get_rejected_roles_,
)


def _days_since(date_str):
    try:
        d = datetime.fromisoformat(str(date_str)[:19])
        return (datetime.now() - d).days
    except Exception:
        return ''


def submit_student_entry_(user, payload):
    """
    SCM creates a new discontinuation entry (Stage 1, first pass
    only). Notifies HOF + Manager of the same branch. SCM-only, by
    design: every entry has to start with SCM.
    """
    require_role_(user, [config.ROLE_SCM])

    rows = read_sheet_as_objects_(config.SHEET_RESPONSE)
    mid = str(payload.get('mid') or '').strip()
    student_name = str(payload.get('studentName') or '').strip()
    try:
        phone1, phone2, phone3 = validate_phone_numbers_(payload.get('phone1'), payload.get('phone2'), payload.get('phone3'))
    except ValueError as exc:
        raise ApiError('BAD_REQUEST')
    if not mid or not student_name or not str(payload.get('reason') or '').strip():
        raise ApiError('BAD_REQUEST')
    if mid_exists_anywhere_(mid):
        raise ApiError('MID_ALREADY_EXISTS')
    next_sl_no = (max((int(r.get('Sl No') or 0) for r in rows), default=0) + 1) if rows else 1

    total_billed = float(payload.get('totalBilled') or 0)
    total_paid = float(payload.get('totalPaid') or 0)
    last_present_day = payload.get('lastPresentDay') or ''

    # Same call-log proof required on every later SCM/HOF/Manager
    # reason submission is required here too, on the very first SCM
    # submission that creates the record. SCM may attach multiple
    # images (config.SCREENSHOT_MAX_COUNT); HOF/Manager stay single-image.
    screenshots_in = _normalize_screenshot_list_(payload.get('screenshots'), payload.get('screenshot'))
    screenshot_keys = _upload_reason_screenshots_(mid, config.ROLE_SCM, screenshots_in)

    row = {
        'Sl No': next_sl_no,
        'Branch': user['branch'],
        'Batch Name': str(payload.get('batchName') or '').strip(),
        'Faculty Name': str(payload.get('facultyName') or '').strip(),
        'MID': mid,
        'Student Name': student_name,
        'Phone Number 1': phone1,
        'Phone Number 2': phone2,
        'Phone Number 3': phone3,
        'Status': config.STATUS_PENDING_HOF_MANAGER,
        'Total Billed': total_billed,
        'Total Paid': total_paid,
        'Arrear': total_billed - total_paid,
        'Last Present Day': format_date_only_(last_present_day) if last_present_day else '',
        'Days Since Present': _days_since(last_present_day) if last_present_day else '',
        # Set exactly once, here, at creation - never updated again.
        'Entry Date': now_iso_(),
        'Reason (SCM)': payload.get('reason'),
        'SCM Updated Date': now_iso_(),
        config.SCREENSHOT_FIELD_SCM: screenshot_keys,
        'Reason (HOF)': '',
        'HOF Updated Date': '',
        'Reason (Manager)': '',
        'Manager Updated Date': '',
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
        'Rejected Roles': '',
    }

    append_row_(config.SHEET_RESPONSE, row)

    notify_branch_roles_(
        row['Branch'], [config.ROLE_HOF, config.ROLE_MANAGER],
        f"New discontinuation entry submitted for {row['Student Name']} ({row['MID']})",
        config.NOTIF_SUBMITTED, row['MID'],
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'CREATE', 'Submitted student ' + str(row['MID']), row['Branch'], payload.get('browser'))
    log_stage_transition_(user, row['MID'], row['Branch'], '(new)',
                           config.STATUS_LABELS[config.STATUS_PENDING_HOF_MANAGER], payload.get('browser'))
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])

    return row


def find_response_row_by_mid_(mid):
    """Finds a Response-sheet row by MID. Raises STUDENT_NOT_FOUND if missing."""
    rows = read_sheet_as_objects_(config.SHEET_RESPONSE)
    match = next((r for r in rows if str(r.get('MID')) == str(mid)), None)
    if not match:
        raise ApiError('STUDENT_NOT_FOUND')
    return match


def compute_workflow_status_(hof_reason, manager_reason):
    hof_done = bool(hof_reason)
    manager_done = bool(manager_reason)
    if hof_done and manager_done:
        return config.STATUS_PENDING_HEAD_OFFICE
    if hof_done and not manager_done:
        return config.STATUS_WAITING_FOR_MANAGER
    if not hof_done and manager_done:
        return config.STATUS_WAITING_FOR_HOF
    return config.STATUS_PENDING_HOF_MANAGER


def log_stage_transition_(user, mid, branch, from_label, to_label, browser):
    log_audit_(user['email'], 'STAGE_TRANSITION', f"{mid}: {from_label} -> {to_label}", branch, browser)


def _clear_correction_flag_(row, role, extra_fields):
    """
    Shared logic for "a flagged role just resubmitted after a Head
    Office rejection": removes `role` from Rejected Roles; if that
    was the last flagged role, moves the record back to Head Office
    for re-review and notifies Head Office; otherwise stays in
    PENDING_CORRECTION waiting on whoever's left.
    Mutates `extra_fields` (the dict about to be written) in place
    and returns the resulting Status for logging/notification.
    """
    remaining = [r for r in get_rejected_roles_(row) if r != role]
    extra_fields['Rejected Roles'] = ','.join(remaining)
    if remaining:
        extra_fields['Status'] = config.STATUS_PENDING_CORRECTION
    else:
        extra_fields['Status'] = config.STATUS_PENDING_HEAD_OFFICE
    return extra_fields['Status']


def _require_reason_changed_(previous, new_value):
    """
    Item 4: after Head Office or Admin rejects an entry, whoever is
    asked to correct it must actually change something before they
    can resubmit - even a single added space is enough, but the
    literal same text is not. Only applies when there IS a previous
    value to compare against (i.e. this is a correction, not someone's
    first-ever submission).
    """
    if previous and str(new_value) == str(previous):
        raise ApiError('REASON_UNCHANGED')


def _upload_reason_screenshot_(mid, role, screenshot):
    """
    Validates and uploads the OPTIONAL call-log screenshot that may
    accompany an HOF/Manager reason submission (single image only).
    `screenshot` is {'base64': <raw base64, no data-URI prefix>,
    'mimeType': 'image/jpeg'}. Returns the storage key to save on the
    row, or '' if none was provided - no longer required to submit a
    reason.
    """
    if not screenshot or not screenshot.get('base64'):
        return ''
    mime_type = screenshot.get('mimeType')
    if mime_type not in config.SCREENSHOT_ALLOWED_MIME_TYPES:
        raise ApiError('BAD_REQUEST')
    try:
        file_bytes = base64.b64decode(screenshot['base64'], validate=True)
    except Exception:
        raise ApiError('BAD_REQUEST')
    if not file_bytes or len(file_bytes) > config.SCREENSHOT_MAX_BYTES:
        raise ApiError('BAD_REQUEST')
    return storage.upload_screenshot_(file_bytes, mime_type, mid, role)


def _normalize_screenshot_list_(screenshots, legacy_screenshot):
    """
    SCM-only multi-image uploads (see config.SCREENSHOT_MAX_COUNT).
    Accepts the new `screenshots` list (list of {base64, mimeType})
    if present, otherwise falls back to wrapping the legacy singular
    `screenshot` field so older frontend builds keep working. Always
    returns a plain list (possibly empty).
    """
    if screenshots:
        if not isinstance(screenshots, list):
            raise ApiError('BAD_REQUEST')
        return screenshots
    return [legacy_screenshot] if legacy_screenshot else []


def _upload_reason_screenshots_(mid, role, screenshots):
    """
    Validates and uploads up to config.SCREENSHOT_MAX_COUNT call-log
    images for an SCM reason submission (initial entry or
    resubmission). Returns the list of storage keys to save on the
    row - empty list if none were provided, since a screenshot is
    never required.
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
    return storage.upload_screenshots_(files, mid, role)


def submit_scm_reason_(user, mid, reason, screenshot, browser, screenshots=None):
    """
    SCM (re)submits their 'Reason (SCM)'. Only allowed when SCM is
    currently unlocked for this record:
      - a brand-new/blank record, OR
      - the record was fully reset to PENDING_SCM (e.g. by an Admin
        final-verification rejection), OR
      - Head Office rejected and flagged SCM specifically for
        correction (Status == PENDING_CORRECTION and 'SCM' listed in
        Rejected Roles) - in which case HOF/Manager are left
        untouched, and once SCM resubmits the record either goes back
        to Head Office (if SCM was the only flagged role) or stays in
        PENDING_CORRECTION waiting on HOF/Manager.
    """
    require_role_(user, [config.ROLE_SCM, config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if user['role'] != config.ROLE_ADMIN and row['Branch'] != user['branch']:
        raise ApiError('AUTH_FORBIDDEN')
    if user['role'] == config.ROLE_SCM and not is_scm_editable_stage_(row):
        raise ApiError('AUTH_FORBIDDEN')

    from_label = config.STATUS_LABELS.get(row.get('Status'), row.get('Status'))
    is_full_reset = (not row.get('Status')) or row.get('Status') == config.STATUS_PENDING_SCM
    is_targeted_correction = row.get('Status') == config.STATUS_PENDING_CORRECTION

    # Item 4: this is a resubmission-after-rejection exactly when it's
    # a targeted correction, or a full reset that still has SCM's old
    # (rejected) text sitting on the row.
    if is_targeted_correction or (is_full_reset and row.get('Reason (SCM)')):
        _require_reason_changed_(row.get('Reason (SCM)'), reason)

    screenshots_in = _normalize_screenshot_list_(screenshots, screenshot)
    screenshot_keys = _upload_reason_screenshots_(mid, config.ROLE_SCM, screenshots_in)
    fields = {
        'Reason (SCM)': reason,
        'SCM Updated Date': now_iso_(),
        config.SCREENSHOT_FIELD_SCM: screenshot_keys,
    }

    if is_full_reset:
        fields.update({
            'Status': config.STATUS_PENDING_HOF_MANAGER,
            'Reason (HOF)': '',
            'HOF Updated Date': '',
            'Reason (Manager)': '',
            'Manager Updated Date': '',
            'Head Office Decision': '',
            'Head Office Name': '',
            'Head Office Date': '',
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
            'Rejected Roles': '',
        })
    elif is_targeted_correction:
        _clear_correction_flag_(row, config.ROLE_SCM, fields)

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], fields)

    if is_full_reset:
        notify_branch_roles_(
            row['Branch'], [config.ROLE_HOF, config.ROLE_MANAGER],
            f"SCM revised the entry for {row['Student Name']} ({mid}) after rejection. Please review.",
            config.NOTIF_SUBMITTED, mid,
        config.PAGE_DISCONTINUE
    )
    elif is_targeted_correction and fields['Status'] == config.STATUS_PENDING_HEAD_OFFICE:
        notify_branch_roles_(
            row['Branch'], [config.ROLE_HEAD_OFFICE],
            f"SCM corrected their reason for {row['Student Name']} ({mid}). Ready for your review again.",
            config.NOTIF_READY_HEAD_OFFICE, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'UPDATE', 'SCM reason submitted for ' + str(mid), row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], from_label,
                           config.STATUS_LABELS.get(fields.get('Status', row.get('Status')), row.get('Status')), browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def submit_hof_reason_(user, mid, confirmed_reason, screenshot, browser):
    """
    HOF submits their 'Confirmed Reason' - either their one-time
    first submission (advances the normal SCM->HOF/Manager->Head
    Office flow) or a targeted correction after Head Office flagged
    HOF specifically. Once submitted, HOF is locked until/unless
    flagged again.
    """
    require_role_(user, [config.ROLE_HOF, config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if user['role'] != config.ROLE_ADMIN and row['Branch'] != user['branch']:
        raise ApiError('AUTH_FORBIDDEN')
    if user['role'] == config.ROLE_HOF and not is_hof_editable_stage_(row):
        raise ApiError('AUTH_FORBIDDEN')

    from_label = config.STATUS_LABELS.get(row.get('Status'), row.get('Status'))
    is_targeted_correction = row.get('Status') == config.STATUS_PENDING_CORRECTION

    if is_targeted_correction:
        _require_reason_changed_(row.get('Reason (HOF)'), confirmed_reason)

    screenshot_key = _upload_reason_screenshot_(mid, config.ROLE_HOF, screenshot)
    fields = {
        'Reason (HOF)': confirmed_reason,
        'HOF Updated Date': now_iso_(),
        config.SCREENSHOT_FIELD_HOF: screenshot_key,
    }

    if is_targeted_correction:
        new_status = _clear_correction_flag_(row, config.ROLE_HOF, fields)
    else:
        new_status = compute_workflow_status_(confirmed_reason, row.get('Reason (Manager)'))
        fields['Status'] = new_status

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], fields)

    if new_status == config.STATUS_PENDING_HEAD_OFFICE:
        notify_branch_roles_(
            row['Branch'], [config.ROLE_HEAD_OFFICE],
            f"Entry for {row['Student Name']} ({mid}) is ready for Head Office approval.",
            config.NOTIF_READY_HEAD_OFFICE, mid,
        config.PAGE_DISCONTINUE
    )
    # If Manager still pending (either still-open first pass, or still
    # flagged in a targeted correction): no one else is notified yet.

    log_audit_(user['email'], 'UPDATE', 'HOF reason submitted for ' + str(mid), row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], from_label, config.STATUS_LABELS[new_status], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def submit_manager_reason_(user, mid, verified_reason, screenshot, browser):
    """Manager fills in (or, if flagged, corrects) their 'Verified Reason'. Mirrors submit_hof_reason_."""
    require_role_(user, [config.ROLE_MANAGER, config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if user['role'] != config.ROLE_ADMIN and row['Branch'] != user['branch']:
        raise ApiError('AUTH_FORBIDDEN')
    if user['role'] == config.ROLE_MANAGER and not is_manager_editable_stage_(row):
        raise ApiError('AUTH_FORBIDDEN')

    from_label = config.STATUS_LABELS.get(row.get('Status'), row.get('Status'))
    is_targeted_correction = row.get('Status') == config.STATUS_PENDING_CORRECTION

    if is_targeted_correction:
        _require_reason_changed_(row.get('Reason (Manager)'), verified_reason)

    screenshot_key = _upload_reason_screenshot_(mid, config.ROLE_MANAGER, screenshot)
    fields = {
        'Reason (Manager)': verified_reason,
        'Manager Updated Date': now_iso_(),
        config.SCREENSHOT_FIELD_MANAGER: screenshot_key,
    }

    if is_targeted_correction:
        new_status = _clear_correction_flag_(row, config.ROLE_MANAGER, fields)
    else:
        new_status = compute_workflow_status_(row.get('Reason (HOF)'), verified_reason)
        fields['Status'] = new_status

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], fields)

    if new_status == config.STATUS_PENDING_HEAD_OFFICE:
        notify_branch_roles_(
            row['Branch'], [config.ROLE_HEAD_OFFICE],
            f"Entry for {row['Student Name']} ({mid}) is ready for Head Office approval.",
            config.NOTIF_READY_HEAD_OFFICE, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'UPDATE', 'Manager reason submitted for ' + str(mid), row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], from_label, config.STATUS_LABELS[new_status], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def head_office_approve_(user, mid, browser):
    """
    Head Office approves once both HOF and Manager are done. Moves
    the record to PENDING_ADMIN and notifies Admin only.
    """
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if row.get('Status') != config.STATUS_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')  # not at the Head Office stage

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], {
        'Status': config.STATUS_PENDING_ADMIN,
        'Head Office Decision': 'APPROVED',
        'Head Office Name': user['name'],
        'Head Office Date': now_iso_(),
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_ADMIN],
        f"Entry for {row['Student Name']} ({mid}) was approved by Head Office and is ready for Admin verification.",
        config.NOTIF_READY_ADMIN, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'APPROVE', 'Head Office approved student ' + str(mid), row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], config.STATUS_LABELS[config.STATUS_PENDING_HEAD_OFFICE],
                           config.STATUS_LABELS[config.STATUS_PENDING_ADMIN], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def head_office_reject_(user, mid, rejection_reason, rejected_roles, browser):
    """
    Head Office rejects and names exactly which role(s) (any non-empty
    subset of SCM / HOF / Manager) provided the wrong reason. Only
    those role(s) get unlocked to edit again; everyone else's reason
    stays exactly as it is. Status becomes PENDING_CORRECTION and only
    the flagged role(s) are notified. Once every flagged role has
    resubmitted, the record automatically goes back to Head Office.
    """
    require_role_(user, [config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if row.get('Status') != config.STATUS_PENDING_HEAD_OFFICE:
        raise ApiError('AUTH_FORBIDDEN')

    roles = [r for r in (rejected_roles or []) if r in config.CORRECTABLE_ROLES]
    if not roles:
        raise ApiError('BAD_REQUEST')  # Head Office must name at least one role

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], {
        'Status': config.STATUS_PENDING_CORRECTION,
        'Head Office Decision': 'REJECTED',
        'Head Office Name': user['name'],
        'Head Office Date': now_iso_(),
        'Rejected Roles': ','.join(roles),
        'Last Rejection Reason': rejection_reason,
        'Last Rejected By': user['name'],
        'Last Rejected Stage': 'Head Office',
        'Last Rejected Date': now_iso_(),
    })

    notify_branch_roles_(
        row['Branch'], roles,
        f"Entry for {row['Student Name']} ({mid}) was REJECTED by Head Office - "
        f"{', '.join(roles)} must correct their reason. Reason given: {rejection_reason}",
        config.NOTIF_HEAD_OFFICE_REJECTED, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(
        user['email'], 'REJECT',
        f"Head Office rejected student {mid} (flagged: {', '.join(roles)}): {rejection_reason}",
        row['Branch'], browser
    )
    log_stage_transition_(user, mid, row['Branch'], config.STATUS_LABELS[config.STATUS_PENDING_HEAD_OFFICE],
                           config.STATUS_LABELS[config.STATUS_PENDING_CORRECTION], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


# SCM edits the STUDENT DETAIL fields (not the workflow reason).
SCM_EDITABLE_DETAIL_FIELDS = [
    'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
    'Total Billed', 'Total Paid', 'Last Present Day',
]


def submit_scm_student_details_(user, mid, fields, browser):
    """
    SCM edits identifying/contact/billing details on an active entry
    in their own branch. Never touches Branch, Status, or any
    reason/decision fields - that's submit_scm_reason_'s job. Gated
    by the same is_scm_editable_stage_ lock as the reason itself.
    """
    require_role_(user, [config.ROLE_SCM])
    # SCM may submit/correct their workflow reason, but may not use a
    # separate student-detail editor. Head Office/Admin are the only
    # roles allowed to directly edit data fields.
    raise ApiError('AUTH_FORBIDDEN')

    row = find_response_row_by_mid_(mid)
    if row['Branch'] != user['branch']:
        raise ApiError('AUTH_FORBIDDEN')
    if not is_scm_editable_stage_(row):
        raise ApiError('AUTH_FORBIDDEN')

    update = {k: v for k, v in fields.items() if k in SCM_EDITABLE_DETAIL_FIELDS}

    if any(k in update for k in ('Phone Number 1', 'Phone Number 2', 'Phone Number 3')):
        try:
            p1 = update.get('Phone Number 1', row.get('Phone Number 1'))
            p2 = update.get('Phone Number 2', row.get('Phone Number 2'))
            p3 = update.get('Phone Number 3', row.get('Phone Number 3'))
            p1, p2, p3 = validate_phone_numbers_(p1, p2, p3)
            update['Phone Number 1'], update['Phone Number 2'], update['Phone Number 3'] = p1, p2, p3
        except ValueError as exc:
            raise ApiError('BAD_REQUEST')

    if 'MID' in update:
        new_mid = str(update['MID'] or '').strip()
        if not new_mid:
            raise ApiError('BAD_REQUEST')
        if mid_exists_anywhere_(new_mid, config.SHEET_RESPONSE, row.get('__row')):
            raise ApiError('MID_ALREADY_EXISTS')
        update['MID'] = new_mid

    # Keep derived fields in sync when their inputs change.
    next_billed = float(update.get('Total Billed', row.get('Total Billed') or 0) or 0)
    next_paid = float(update.get('Total Paid', row.get('Total Paid') or 0) or 0)
    if 'Total Billed' in update or 'Total Paid' in update:
        update['Arrear'] = next_billed - next_paid
    if update.get('Last Present Day'):
        update['Last Present Day'] = format_date_only_(update['Last Present Day'])
        update['Days Since Present'] = _days_since(update['Last Present Day'])

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], update)

    log_audit_(user['email'], 'UPDATE',
               f"SCM edited student details for {mid} ({', '.join(update.keys())})",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])

    return {'success': True}


# Head Office may edit any of these fields at any stage, INCLUDING
# every reason field.
HEAD_OFFICE_EDITABLE_FIELDS = [
    'Branch', 'MID', 'Student Name', 'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
    'Total Billed', 'Total Paid', 'Last Present Day',
    'Reason (SCM)', 'Reason (HOF)', 'Reason (Manager)',
    'Status', 'Head Office Decision', 'Head Office Name', 'Head Office Date',
    'Admin Approval', 'Admin Name', 'Approval Date',
]

# Admin may edit these same fields EXCEPT the three reason fields -
# Admin is a final-verification role, not a reason-correction role.
ADMIN_EDITABLE_FIELDS = [f for f in HEAD_OFFICE_EDITABLE_FIELDS
                          if f not in ('Reason (SCM)', 'Reason (HOF)', 'Reason (Manager)')]


def find_row_by_mid_in_sheet_(sheet_name, mid):
    """Finds a row by MID in a specific sheet, or None if not found."""
    rows = read_sheet_as_objects_(sheet_name)
    return next((r for r in rows if str(r.get('MID')) == str(mid)), None)


def get_reason_screenshot_url_(user, mid, sheet_key, role, browser):
    """
    Admin/Head Office only: returns a short-lived (5 min) signed URL
    for the call-log screenshot a given role (SCM/HOF/Manager)
    uploaded on this student's record. Every view is audit-logged.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    field = config.SCREENSHOT_FIELDS_BY_ROLE.get(role)
    if not field:
        raise ApiError('BAD_REQUEST')
    sheet_name = config.SHEET_COMPLETED if sheet_key == 'completed' else config.SHEET_RESPONSE
    row = find_row_by_mid_in_sheet_(sheet_name, mid)
    if not row:
        raise ApiError('STUDENT_NOT_FOUND')
    keys = screenshot_keys_(row.get(field))
    if not keys:
        raise ApiError('STUDENT_NOT_FOUND')
    log_audit_(user['email'], 'VIEW', f'Viewed {role} call-log screenshot(s) for {mid}', row['Branch'], browser)
    return {'urls': storage.get_signed_urls_(keys)}


def admin_update_student_entry_(user, mid, sheet_key, fields, browser):
    """
    Admin or Head Office edits fields on a student entry, in either
    the Response (active workflow) or Completed sheet, at any time.
    Head Office may edit any field, including all three reason
    fields. Admin may edit everything EXCEPT the reason fields -
    Admin's role here is final verification, not reason correction.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    if not fields or not isinstance(fields, dict):
        raise ApiError('BAD_REQUEST')

    sheet_name = config.SHEET_COMPLETED if sheet_key == 'completed' else config.SHEET_RESPONSE
    row = find_row_by_mid_in_sheet_(sheet_name, mid)
    if not row:
        raise ApiError('STUDENT_NOT_FOUND')

    allowed_fields = HEAD_OFFICE_EDITABLE_FIELDS if user['role'] == config.ROLE_HEAD_OFFICE else ADMIN_EDITABLE_FIELDS
    update = {k: v for k, v in fields.items() if k in allowed_fields}
    if any(k in update for k in ('Phone Number 1', 'Phone Number 2', 'Phone Number 3')):
        try:
            p1 = update.get('Phone Number 1', row.get('Phone Number 1'))
            p2 = update.get('Phone Number 2', row.get('Phone Number 2'))
            p3 = update.get('Phone Number 3', row.get('Phone Number 3'))
            p1, p2, p3 = validate_phone_numbers_(p1, p2, p3)
            update['Phone Number 1'], update['Phone Number 2'], update['Phone Number 3'] = p1, p2, p3
        except ValueError as exc:
            raise ApiError('BAD_REQUEST')
    if 'MID' in update:
        new_mid = str(update['MID'] or '').strip()
        if not new_mid:
            raise ApiError('BAD_REQUEST')
        if mid_exists_anywhere_(new_mid, sheet_name, row.get('__row')):
            raise ApiError('MID_ALREADY_EXISTS')
        update['MID'] = new_mid

    next_billed = float(update.get('Total Billed', row.get('Total Billed') or 0) or 0)
    next_paid = float(update.get('Total Paid', row.get('Total Paid') or 0) or 0)
    if 'Total Billed' in update or 'Total Paid' in update:
        update['Arrear'] = next_billed - next_paid
    if update.get('Last Present Day'):
        update['Last Present Day'] = format_date_only_(update['Last Present Day'])
        update['Days Since Present'] = _days_since(update['Last Present Day'])
    if 'Reason (SCM)' in update:
        update['SCM Updated Date'] = now_iso_()
    if 'Reason (HOF)' in update:
        update['HOF Updated Date'] = now_iso_()
    if 'Reason (Manager)' in update:
        update['Manager Updated Date'] = now_iso_()

    update_row_fields_(sheet_name, row['__row'], update)

    log_audit_(user['email'], 'UPDATE',
               f"({user['role']}) edited student {mid} ({', '.join(update.keys())})",
               row['Branch'], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])

    return {'success': True}


def approve_student_entry_(user, mid, browser):
    """
    Admin's FINAL verification approval: moves the row from Response
    to Completed, only allowed once Head Office has already approved
    (Status === PENDING_ADMIN). Notifies SCM + HOF + Manager + Head Office.
    """
    require_role_(user, [config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if row.get('Status') != config.STATUS_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')  # Head Office hasn't approved this yet

    completed_row = dict(row)
    completed_row.pop('__row', None)
    completed_row['Status'] = config.STATUS_APPROVED
    completed_row['Admin Approval'] = 'APPROVED'
    completed_row['Admin Name'] = user['name']
    completed_row['Approval Date'] = now_iso_()

    append_row_(config.SHEET_COMPLETED, completed_row)
    delete_row_(config.SHEET_RESPONSE, row['__row'])

    notify_branch_roles_(
        row['Branch'], [config.ROLE_SCM, config.ROLE_HOF, config.ROLE_MANAGER, config.ROLE_HEAD_OFFICE],
        f"Entry for {row['Student Name']} ({mid}) has been given FINAL VERIFICATION by Admin. Student is now Discontinued.",
        config.NOTIF_APPROVED, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'APPROVE', 'Admin gave final verification for student ' + str(mid), row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], config.STATUS_LABELS[config.STATUS_PENDING_ADMIN],
                           config.STATUS_LABELS[config.STATUS_APPROVED], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def reject_student_entry_(user, mid, rejection_reason, browser):
    """
    Admin rejects the final verification: entry goes back to Pending
    SCM (full reset - HOF and Manager reasons are cleared and SCM
    starts the HOF/Manager cycle over), exactly as before. This is
    intentionally different from head_office_reject_, which targets
    specific role(s) instead of resetting everything.
    """
    require_role_(user, [config.ROLE_ADMIN])
    row = find_response_row_by_mid_(mid)
    if row.get('Status') != config.STATUS_PENDING_ADMIN:
        raise ApiError('AUTH_FORBIDDEN')

    update_row_fields_(config.SHEET_RESPONSE, row['__row'], {
        'Status': config.STATUS_PENDING_SCM,
        'Admin Approval': 'REJECTED',
        'Admin Name': user['name'],
        'Approval Date': now_iso_(),
        'Reason (HOF)': '',
        'HOF Updated Date': '',
        'Reason (Manager)': '',
        'Manager Updated Date': '',
        'Rejected Roles': '',
        'Last Rejection Reason': rejection_reason,
        'Last Rejected By': user['name'],
        'Last Rejected Stage': 'Admin',
        'Last Rejected Date': now_iso_(),
    })

    notify_branch_roles_(
        row['Branch'], [config.ROLE_SCM],
        f"Entry for {row['Student Name']} ({mid}) was REJECTED by Admin. Reason: {rejection_reason}",
        config.NOTIF_REJECTED, mid,
        config.PAGE_DISCONTINUE
    )

    log_audit_(user['email'], 'REJECT', f"Admin rejected student {mid}: {rejection_reason}", row['Branch'], browser)
    log_stage_transition_(user, mid, row['Branch'], config.STATUS_LABELS[config.STATUS_PENDING_ADMIN],
                           config.STATUS_LABELS[config.STATUS_PENDING_SCM], browser)
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])


def delete_student_entry_(user, mid, sheet_key, confirm_mid, browser):
    """
    Admin or Head Office permanently deletes a student entry at ANY
    workflow status, from either the active Response sheet or the
    Completed sheet. Hard, irreversible delete - the caller must
    re-type the exact MID as `confirm_mid` (same UX as the other two
    workflows) before this is allowed to proceed.
    """
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    if not mid:
        raise ApiError('BAD_REQUEST')
    if str(confirm_mid or '').strip() != str(mid).strip():
        raise ApiError('BAD_REQUEST')

    preferred_sheet = config.SHEET_COMPLETED if sheet_key == 'completed' else config.SHEET_RESPONSE
    other_sheet = config.SHEET_RESPONSE if preferred_sheet == config.SHEET_COMPLETED else config.SHEET_COMPLETED

    sheet_name = preferred_sheet
    row = find_row_by_mid_in_sheet_(preferred_sheet, mid)
    if not row:
        row = find_row_by_mid_in_sheet_(other_sheet, mid)
        sheet_name = other_sheet
    if not row:
        raise ApiError('STUDENT_NOT_FOUND')

    delete_row_(sheet_name, row['__row'])
    storage.delete_screenshots_(collect_screenshot_keys_(row))

    log_audit_(
        user['email'], 'DELETE',
        f"({user['role']}) permanently deleted student {mid} ({row['Student Name']}, was "
        f"{config.STATUS_LABELS.get(row.get('Status'), row.get('Status'))}, from {sheet_name})",
        row['Branch'], browser
    )
    invalidate_cache_(['dashboard_' + row['Branch'], 'dashboard_ALL'])

    return {'success': True}


def list_students_(user, sheet_name, params):
    """List entries visible to this user, with optional search/filter params."""
    params = params or {}
    rows = read_sheet_as_objects_(sheet_name)

    # Single combined search box from the frontend: OR-match against
    # MID, Student Name, and all three phone numbers (see apiClient.ts /
    # Students.tsx - StudentListParams.search).
    if params.get('search'):
        q = str(params['search']).strip().lower()
        if q:
            def _search_match(r):
                if q in str(r.get('MID', '')).lower():
                    return True
                if q in str(r.get('Student Name', '')).lower():
                    return True
                return any(q in str(r.get(p, '')).lower() for p in
                           ['Phone Number 1', 'Phone Number 2', 'Phone Number 3'])
            rows = [r for r in rows if _search_match(r)]

    # Legacy per-field filters (still supported, AND-combined with each
    # other and with 'search' above, for any caller that wants a
    # narrower match on one specific field).
    if params.get('mid'):
        rows = [r for r in rows if params['mid'] in str(r.get('MID', ''))]
    if params.get('studentName'):
        q = params['studentName'].lower()
        rows = [r for r in rows if q in str(r.get('Student Name', '')).lower()]
    if params.get('phone'):
        q = params['phone']
        rows = [r for r in rows if any(q in str(r.get(p, '')) for p in
                                        ['Phone Number 1', 'Phone Number 2', 'Phone Number 3'])]
    if params.get('status'):
        rows = [r for r in rows if r.get('Status') == params['status']]
    if params.get('branch') and user['role'] in config.GLOBAL_VISIBILITY_ROLES:
        rows = [r for r in rows if r.get('Branch') == params['branch']]
    if params.get('batch'):
        q = str(params['batch']).strip().lower()
        if q:
            rows = [r for r in rows if q in str(r.get('Batch Name', '')).lower()]

    # NOTE: Admin and Head Office used to have their Active page
    # hard-filtered down to ONLY the status they can act on
    # (PENDING_ADMIN / PENDING_HEAD_OFFICE respectively), which meant
    # they could never see where a record sat at any other stage.
    # That restriction has been removed - Admin and Head Office now
    # see every record on the Active sheet (still branch-scoped like
    # everyone else via GLOBAL_VISIBILITY_ROLES above). To keep "what
    # needs MY decision right now" easy to spot, filter_student_row_for_role_
    # stamps each row with an 'Awaiting My Action' flag, and the
    # frontend uses that to visually separate the two groups instead
    # of hiding one of them.

    # "How old is this entry" - filters on the immutable 'Entry Date'.
    if params.get('entryDateFrom') or params.get('entryDateTo'):
        def entry_date_ok(r):
            if not r.get('Entry Date'):
                return False
            try:
                d = datetime.fromisoformat(str(r['Entry Date'])[:19])
            except Exception:
                return False
            if params.get('entryDateFrom'):
                if d < datetime.fromisoformat(str(params['entryDateFrom'])[:19] if 'T' in str(params['entryDateFrom']) else str(params['entryDateFrom']) + 'T00:00:00'):
                    return False
            if params.get('entryDateTo'):
                end_str = str(params['entryDateTo'])
                end = datetime.fromisoformat(end_str[:19] if 'T' in end_str else end_str + 'T23:59:59')
                if d > end:
                    return False
            return True
        rows = [r for r in rows if entry_date_ok(r)]

    # Separate filter on 'Last Present Day'.
    if params.get('lastPresentFrom') or params.get('lastPresentTo'):
        def last_present_ok(r):
            if not r.get('Last Present Day'):
                return False
            try:
                d = datetime.fromisoformat(str(r['Last Present Day'])[:10])
            except Exception:
                return False
            if params.get('lastPresentFrom'):
                if d < datetime.fromisoformat(str(params['lastPresentFrom'])[:10]):
                    return False
            if params.get('lastPresentTo'):
                end = datetime.fromisoformat(str(params['lastPresentTo'])[:10]).replace(hour=23, minute=59, second=59)
                if d.replace(hour=23, minute=59, second=59) > end:
                    return False
            return True
        rows = [r for r in rows if last_present_ok(r)]

    filtered = filter_student_rows_for_user_(rows, user)

    # "My turn" count for the sidebar badge: how many of this user's
    # visible active rows are actually awaiting THEIR action right now.
    # Deliberately role-specific rather than reusing the raw 'canEdit'
    # flag everywhere - for Head Office/Admin, canEdit on a row is
    # always true (they can edit any row), which would make the badge
    # never clear. What actually clears their badge is the row reaching
    # the status they're meant to act on.
    role = user['role']
    if role in (config.ROLE_SCM, config.ROLE_HOF, config.ROLE_MANAGER):
        pending_for_me = sum(1 for r in filtered if r.get('canEdit'))
    elif role == config.ROLE_HEAD_OFFICE:
        pending_for_me = sum(1 for r in filtered if r.get('Status') == config.STATUS_PENDING_HEAD_OFFICE)
    elif role == config.ROLE_ADMIN:
        pending_for_me = sum(1 for r in filtered if r.get('Status') == config.STATUS_PENDING_ADMIN)
    else:
        pending_for_me = 0

    if params.get('sortBy'):
        sort_student_rows_(filtered, params['sortBy'], params.get('sortDir'))
    elif sheet_name == config.SHEET_RESPONSE:
        # No explicit sort requested - bubble rows needing THIS user's
        # action to the top. Only applies to the active workflow sheet.
        if user['role'] == config.ROLE_ADMIN:
            filtered.sort(key=lambda r: 0 if r.get('Status') == config.STATUS_PENDING_ADMIN else 1)
        elif user['role'] == config.ROLE_HEAD_OFFICE:
            filtered.sort(key=lambda r: 0 if r.get('Status') == config.STATUS_PENDING_HEAD_OFFICE else 1)

    # pagination
    page = int(params.get('page') or 1)
    page_size = int(params.get('pageSize') or 25)
    start = (page - 1) * page_size
    page_rows = filtered[start:start + page_size]

    return {'total': len(filtered), 'page': page, 'pageSize': page_size, 'rows': page_rows, 'pendingForMe': pending_for_me}


STUDENT_SORT_NUMERIC_FIELDS = ['Sl No', 'Total Billed', 'Total Paid', 'Arrear', 'Days Since Present']
STUDENT_SORT_DATE_FIELDS = ['Last Present Day', 'Entry Date', 'SCM Updated Date',
                             'HOF Updated Date', 'Manager Updated Date', 'Approval Date']


def sort_student_rows_(rows, sort_by, sort_dir):
    """In-place sort of already role-filtered rows by any column."""
    reverse = sort_dir == 'desc'

    if sort_by in STUDENT_SORT_NUMERIC_FIELDS:
        rows.sort(key=lambda r: float(r.get(sort_by) or 0), reverse=reverse)
        return

    if sort_by in STUDENT_SORT_DATE_FIELDS:
        def date_key(r):
            v = r.get(sort_by)
            if not v:
                return (1, 0)  # blanks always last regardless of direction
            try:
                return (0, datetime.fromisoformat(str(v)[:19]).timestamp())
            except Exception:
                return (1, 0)
        # blanks must stay last even when reversed, so sort in two passes.
        non_blank = [r for r in rows if r.get(sort_by)]
        blank = [r for r in rows if not r.get(sort_by)]

        def parsed(r):
            try:
                return datetime.fromisoformat(str(r[sort_by])[:19]).timestamp()
            except Exception:
                return 0
        non_blank.sort(key=parsed, reverse=reverse)
        rows[:] = non_blank + blank
        return

    # Default: case-insensitive string compare.
    rows.sort(key=lambda r: str(r.get(sort_by) or '').lower(), reverse=reverse)