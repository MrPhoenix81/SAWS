"""
filters.py
Role-based field visibility. This is the SECURITY BOUNDARY for the
"who can see whose reason" rules - it runs on the server before any
student row is serialized to JSON, so a restricted field never
reaches the browser at all. Direct port of Filters.gs.

EDIT-GATING RULES (updated):
Each of SCM / HOF / Manager gets exactly ONE unlocked chance to
submit their reason. Once a role's reason field is filled in, that
role is LOCKED - they cannot revise it - all the way until Head
Office makes a decision. The only way a role becomes editable again
is if Head Office rejects the record AND explicitly names that role
in the 'Rejected Roles' column (see students.py:head_office_reject_).

REASON VISIBILITY (SCM):
SCM's own reason is hidden from SCM the moment it's locked (submitted
and awaiting review), and stays hidden all the way through Head
Office and Admin review. It becomes visible again - read only - once
Admin gives FINAL approval (row['Status'] == config.STATUS_APPROVED,
i.e. the record has moved to the Completed sheet). Admin is always
the final approver; Head Office approving is not enough to unlock it.
"""
from datetime import datetime

import config

# Every status a record can be in BEFORE Head Office has actually
# made a decision (approve/reject) on it - includes PENDING_HEAD_OFFICE
# itself, since sitting in Head Office's queue isn't a decision yet.
PRE_HEAD_OFFICE_STATUSES = [
    config.STATUS_PENDING_SCM,
    config.STATUS_PENDING_HOF_MANAGER,
    config.STATUS_WAITING_FOR_MANAGER,
    config.STATUS_WAITING_FOR_HOF,
    config.STATUS_PENDING_HEAD_OFFICE,
]


def current_stage_label_(row):
    """
    Item 5: when a record sits in the generic PENDING_CORRECTION
    status, the plain STATUS_LABELS lookup can't say WHICH role(s)
    still need to resubmit - there can be one role flagged, or any
    combination (SCM & HOF, HOF & Manager, SCM & Manager, all three,
    etc). Build that combination label on the fly instead of needing
    a separate literal status value for every combination.
    """
    status = row.get('Status')
    if status == config.STATUS_PENDING_CORRECTION:
        roles = get_rejected_roles_(row)
        if roles:
            return 'Pending Correction: ' + ' & '.join(roles)
        return config.STATUS_LABELS.get(status, status or '')
    return config.STATUS_LABELS.get(status, status or '')


def get_rejected_roles_(row):
    """Parses the 'Rejected Roles' column into a clean list, e.g. ['HOF','Manager']."""
    raw = (row.get('Rejected Roles') or '').strip()
    if not raw:
        return []
    return [r.strip() for r in raw.split(',') if r.strip()]


def is_scm_editable_stage_(row_or_status):
    """
    True only when SCM has not yet submitted a reason on this record
    at all (brand new row), OR Head Office rejected and flagged SCM
    specifically for correction. Once SCM's reason is on file and the
    record has moved on, SCM is locked out.
    """
    row = row_or_status if isinstance(row_or_status, dict) else {'Status': row_or_status}
    status = row.get('Status')
    if status == config.STATUS_PENDING_CORRECTION:
        return config.ROLE_SCM in get_rejected_roles_(row)
    # A brand new record (no status yet) or one legitimately reset to
    # PENDING_SCM by a full reset (e.g. Admin's final-verification
    # reject, which still does a full reset) is editable.
    return (not status) or status == config.STATUS_PENDING_SCM


def is_hof_editable_stage_(row_or_status):
    """
    True on HOF's very first (unfilled) submission for this record,
    or when Head Office rejected and flagged HOF specifically.
    """
    row = row_or_status if isinstance(row_or_status, dict) else {'Status': row_or_status}
    status = row.get('Status')
    if status == config.STATUS_PENDING_CORRECTION:
        return config.ROLE_HOF in get_rejected_roles_(row)
    first_submission_stages = (config.STATUS_PENDING_HOF_MANAGER, config.STATUS_WAITING_FOR_HOF)
    return status in first_submission_stages and not row.get('Reason (HOF)')


def is_manager_editable_stage_(row_or_status):
    """Mirrors is_hof_editable_stage_ for Manager."""
    row = row_or_status if isinstance(row_or_status, dict) else {'Status': row_or_status}
    status = row.get('Status')
    if status == config.STATUS_PENDING_CORRECTION:
        return config.ROLE_MANAGER in get_rejected_roles_(row)
    first_submission_stages = (config.STATUS_PENDING_HOF_MANAGER, config.STATUS_WAITING_FOR_MANAGER)
    return status in first_submission_stages and not row.get('Reason (Manager)')


def is_head_office_editable_stage_(status):
    return status == config.STATUS_PENDING_HEAD_OFFICE


def is_admin_editable_stage_(status):
    return status == config.STATUS_PENDING_ADMIN


def can_role_edit_row_(user, row):
    """
    Whether `user` may edit THIS row's own-role fields right now,
    given its current Status (and Rejected Roles, if any). Admin and
    Head Office can always edit any field on any row.
    """
    role = user['role']
    if role in (config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE):
        return True
    if role == config.ROLE_SCM:
        return is_scm_editable_stage_(row)
    if role == config.ROLE_HOF:
        return is_hof_editable_stage_(row)
    if role == config.ROLE_MANAGER:
        return is_manager_editable_stage_(row)
    return False


def is_admin_final_approved_(row):
    """
    True only once Admin has given FINAL approval on this record.
    Head Office approving is NOT enough - Admin is always the final
    approver (see requirement #1 / #4). Works whether `row` came from
    an active (Response) sheet or a *Completed sheet, since both use
    the same 'Admin Approval' / 'Status' fields.
    """
    return (row.get('Admin Approval') == 'APPROVED') or (
        row.get('Status') in (
            config.STATUS_APPROVED,
            config.STATUS_INACTIVE_APPROVED,
            config.STATUS_TRANSFER_APPROVED,
        )
    )


def days_since_last_present_(row, field='Last Present Day'):
    """
    Item 2: dynamically computes 'Days Since Last Present' from the
    student's Last Present Date every time a row is served, rather
    than trusting a value stored at submission time (which would go
    stale). Returns '' when there's no date to compute from.
    """
    value = row.get(field)
    if not value:
        return ''
    try:
        d = datetime.fromisoformat(str(value)[:19])
    except Exception:
        return ''
    return max((datetime.now() - d).days, 0)


PRESENCE_INACTIVE_THRESHOLD_DAYS = 7


def presence_status_(row):
    """
    Backend-only Active/Inactive derivation from 'Days Since Present'
    (itself derived from 'Last Present Day' - see students.py:_days_since).
    Not currently surfaced in the frontend UI by design - kept here so
    it's available to any future consumer (exports, reports, other
    endpoints) without duplicating the threshold logic.
    """
    days_since = row.get('Days Since Present')
    if row.get('Last Present Day') in (None, '') or days_since in (None, ''):
        return 'Inactive'
    try:
        return 'Active' if int(days_since) <= PRESENCE_INACTIVE_THRESHOLD_DAYS else 'Inactive'
    except (TypeError, ValueError):
        return 'Inactive'


def filter_student_row_for_role_(row, user):
    """
    Strips fields a given role must not see from one student row, and
    adds the computed 'Current Stage' / 'canEdit' fields every role
    is allowed to see.
    """
    out = {col: row.get(col) for col in config.STUDENT_COLUMNS}
    out['Current Stage'] = current_stage_label_(row)
    out['Rejected Roles List'] = get_rejected_roles_(row)
    out['SCM Screenshot Uploaded'] = bool(row.get(config.SCREENSHOT_FIELD_SCM))
    out['HOF Screenshot Uploaded'] = bool(row.get(config.SCREENSHOT_FIELD_HOF))
    out['Manager Screenshot Uploaded'] = bool(row.get(config.SCREENSHOT_FIELD_MANAGER))
    # Item 2: always computed fresh from 'Last Present Day', never the
    # value that was snapshotted when the entry was first submitted.
    out['Days Since Present'] = days_since_last_present_(row)
    out['Days Since Last Present'] = out['Days Since Present']
    out['Presence Status'] = presence_status_(row)

    role = user['role']

    if role in (config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE):
        out['canEdit'] = True
        # Admin and Head Office now see records at every stage (see
        # students.py:list_students_), not just the one they can act
        # on. This flag is the clear separation the frontend groups
        # and highlights by: True only for the specific status that
        # is actually sitting in THIS role's queue right now.
        if role == config.ROLE_ADMIN:
            out['Awaiting My Action'] = row.get('Status') == config.STATUS_PENDING_ADMIN
        else:
            out['Awaiting My Action'] = row.get('Status') == config.STATUS_PENDING_HEAD_OFFICE
        return out

    if role == config.ROLE_SCM:
        # Cannot see HOF reason, Manager reason, Head Office remarks, or Admin remarks
        for key in ['Reason (HOF)', 'HOF Updated Date', 'Reason (Manager)', 'Manager Updated Date',
                    'Head Office Decision', 'Head Office Name', 'Head Office Date',
                    'Admin Approval', 'Admin Name', 'Approval Date',
                    'HOF Screenshot Uploaded', 'Manager Screenshot Uploaded']:
            out.pop(key, None)
        editable = is_scm_editable_stage_(row)
        out['canEdit'] = editable
        out['Awaiting My Action'] = editable
        # Item 1: SCM's own reason is hidden while it's under review
        # (submitted, locked, awaiting Head Office/Admin) - only
        # visible again while it's theirs to write/edit (brand-new
        # row, or flagged for correction by Head Office), OR once
        # Admin has given FINAL approval. Head Office approving alone
        # does NOT unlock it - Admin is the final approver.
        if not (editable or is_admin_final_approved_(row)):
            out['Reason (SCM)'] = ''
        # The rejection reason itself is only meaningful - and only
        # shown - to the role Head Office actually flagged.
        was_rejected_for_me = config.ROLE_SCM in get_rejected_roles_(row)
        if not was_rejected_for_me:
            out.pop('Last Rejection Reason', None)
            out.pop('Last Rejected By', None)
            out.pop('Last Rejected Stage', None)
            out.pop('Last Rejected Date', None)
        return out

    if role == config.ROLE_HOF:
        # Narrow view: student identity/contact + timing + current stage only.
        editable = is_hof_editable_stage_(row)
        was_rejected_for_me = config.ROLE_HOF in get_rejected_roles_(row)
        return {
            'Sl No': row.get('Sl No'),
            'MID': row.get('MID'),
            'Branch': row.get('Branch'),
            'Batch Name': row.get('Batch Name'),
            'Faculty Name': row.get('Faculty Name'),
            'Student Name': row.get('Student Name'),
            'Phone Number 1': row.get('Phone Number 1'),
            'Phone Number 2': row.get('Phone Number 2'),
            'Phone Number 3': row.get('Phone Number 3'),
            'Status': row.get('Status'),
            'Current Stage': out['Current Stage'],
            'Entry Date': row.get('Entry Date'),
            'Last Present Day': row.get('Last Present Day'),
            'Days Since Present': days_since_last_present_(row),
            'Days Since Last Present': days_since_last_present_(row),
            'Presence Status': out['Presence Status'],
            # Item 1: hidden once submitted, visible again only while
            # editable (fresh, or Head Office flagged HOF specifically).
            'Confirmed Reason': (row.get('Reason (HOF)') or '') if editable else '',
            'HOF Updated Date': row.get('HOF Updated Date') or '',
            'HOF Screenshot Uploaded': bool(row.get(config.SCREENSHOT_FIELD_HOF)),
            'Last Rejection Reason': row.get('Last Rejection Reason') if was_rejected_for_me else '',
            'Last Rejected Date': row.get('Last Rejected Date') if was_rejected_for_me else '',
            'canEdit': editable,
            'Awaiting My Action': editable,
        }

    if role == config.ROLE_MANAGER:
        # Narrow view: mirrors HOF above. Sees a 'Verified Reason' field.
        editable = is_manager_editable_stage_(row)
        was_rejected_for_me = config.ROLE_MANAGER in get_rejected_roles_(row)
        return {
            'Sl No': row.get('Sl No'),
            'MID': row.get('MID'),
            'Branch': row.get('Branch'),
            'Batch Name': row.get('Batch Name'),
            'Faculty Name': row.get('Faculty Name'),
            'Student Name': row.get('Student Name'),
            'Phone Number 1': row.get('Phone Number 1'),
            'Phone Number 2': row.get('Phone Number 2'),
            'Phone Number 3': row.get('Phone Number 3'),
            'Status': row.get('Status'),
            'Current Stage': out['Current Stage'],
            'Entry Date': row.get('Entry Date'),
            'Last Present Day': row.get('Last Present Day'),
            'Days Since Present': days_since_last_present_(row),
            'Days Since Last Present': days_since_last_present_(row),
            'Presence Status': out['Presence Status'],
            'Verified Reason': (row.get('Reason (Manager)') or '') if editable else '',
            'Manager Updated Date': row.get('Manager Updated Date') or '',
            'Manager Screenshot Uploaded': bool(row.get(config.SCREENSHOT_FIELD_MANAGER)),
            'Last Rejection Reason': row.get('Last Rejection Reason') if was_rejected_for_me else '',
            'Last Rejected Date': row.get('Last Rejected Date') if was_rejected_for_me else '',
            'canEdit': editable,
            'Awaiting My Action': editable,
        }

    # Unknown role: return nothing but the bare identifiers.
    return {'Sl No': row.get('Sl No'), 'MID': row.get('MID'), 'Branch': row.get('Branch'), 'canEdit': False}


def filter_student_rows_for_user_(rows, user):
    """
    Applies filter_student_row_for_role_ across a list, and also
    applies branch scoping (SCM/HOF/Manager only see rows from their
    own branch; Admin and Head Office see every branch).
    """
    if user['role'] in config.GLOBAL_VISIBILITY_ROLES:
        scoped = rows
    else:
        scoped = [r for r in rows if r.get('Branch') == user['branch']]
    return [filter_student_row_for_role_(r, user) for r in scoped]