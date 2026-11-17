"""Cross-workflow MID search for Admin and Head Office."""
import config
from auth import ApiError, require_role_
from audit_log import log_audit_
from db_utils import (
    read_sheet_as_objects_,
    update_row_fields_,
    invalidate_cache_,
    now_iso_,
)
from filters import filter_student_row_for_role_
from inactive import _serialize_ as serialize_inactive_
from students import _attach_inactive_conversion_dates_
from transfer import _serialize_ as serialize_transfer_

_ACTIVE_SHEETS = {
    'Discontinue': config.SHEET_RESPONSE,
    'Inactive': config.SHEET_INACTIVE_RESPONSE,
    'Transfer': config.SHEET_TRANSFER_RESPONSE,
}

_PENDING_STATUSES = {
    'Discontinue': (
        config.STATUS_PENDING_SCM,
        config.STATUS_PENDING_HOF_MANAGER,
        config.STATUS_WAITING_FOR_MANAGER,
        config.STATUS_WAITING_FOR_HOF,
        config.STATUS_PENDING_HEAD_OFFICE,
        config.STATUS_PENDING_ADMIN,
        config.STATUS_PENDING_CORRECTION,
    ),
    'Inactive': (
        config.STATUS_INACTIVE_PENDING_SCM,
        config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
        config.STATUS_INACTIVE_PENDING_ADMIN,
    ),
    'Transfer': (
        config.STATUS_TRANSFER_PENDING_SCM,
        config.STATUS_TRANSFER_PENDING_HEAD_OFFICE,
        config.STATUS_TRANSFER_PENDING_ADMIN,
    ),
}


def _status_options_(workflow, row, tab, role):
    if tab != 'active':
        return []
    statuses = list(_PENDING_STATUSES[workflow])
    if workflow == 'Discontinue' and row.get('Status') != config.STATUS_PENDING_CORRECTION:
        statuses.remove(config.STATUS_PENDING_CORRECTION)
    if role == config.ROLE_ADMIN:
        pending_admin_status = {
            'Discontinue': config.STATUS_PENDING_ADMIN,
            'Inactive': config.STATUS_INACTIVE_PENDING_ADMIN,
            'Transfer': config.STATUS_TRANSFER_PENDING_ADMIN,
        }[workflow]
        if (
            row.get('Head Office Decision') != 'APPROVED'
            and row.get('Status') != pending_admin_status
        ):
            statuses.remove(pending_admin_status)
    return statuses


def search_records_by_mid_(user, mid):
    """Return all matching workflow records with role-filtered details."""
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    normalized_mid = str(mid or '').strip()
    if not normalized_mid:
        raise ApiError('BAD_REQUEST')

    discontinue_rows = _attach_inactive_conversion_dates_(
        read_sheet_as_objects_(config.SHEET_RESPONSE)
        + read_sheet_as_objects_(config.SHEET_COMPLETED)
    )
    results = []

    for row in discontinue_rows:
        if str(row.get('MID') or '').strip() != normalized_mid:
            continue
        sheet = (
            'completed'
            if row.get('Status') == config.STATUS_APPROVED
            else 'active'
        )
        results.append({
            'workflow': 'Discontinue',
            'tab': sheet,
            'record': filter_student_row_for_role_(row, user),
            'statusOptions': _status_options_('Discontinue', row, sheet, user['role']),
        })

    for sheet_name, tab in (
        (config.SHEET_INACTIVE_RESPONSE, 'active'),
        (config.SHEET_INACTIVE_COMPLETED, 'completed'),
    ):
        for row in read_sheet_as_objects_(sheet_name):
            if (
                str(row.get('MID') or '').strip() != normalized_mid
                or row.get('Status') == config.STATUS_INACTIVE_CONVERTED
            ):
                continue
            results.append({
                'workflow': 'Inactive',
                'tab': tab,
                'record': serialize_inactive_(row, user),
                'statusOptions': _status_options_('Inactive', row, tab, user['role']),
            })

    for sheet_name, tab in (
        (config.SHEET_TRANSFER_RESPONSE, 'active'),
        (config.SHEET_TRANSFER_COMPLETED, 'completed'),
    ):
        for row in read_sheet_as_objects_(sheet_name):
            if str(row.get('MID') or '').strip() != normalized_mid:
                continue
            results.append({
                'workflow': 'Transfer',
                'tab': tab,
                'record': serialize_transfer_(row, user),
                'statusOptions': _status_options_('Transfer', row, tab, user['role']),
            })

    return {'MID': normalized_mid, 'results': results}


def update_record_status_(user, mid, workflow, status, browser):
    """Admin and Head Office may move active records between pending stages, never approve them."""
    require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
    normalized_mid = str(mid or '').strip()
    if not normalized_mid or not isinstance(workflow, str) or workflow not in _ACTIVE_SHEETS:
        raise ApiError('BAD_REQUEST')
    if not isinstance(status, str):
        raise ApiError('BAD_REQUEST')

    sheet_name = _ACTIVE_SHEETS[workflow]
    row = next(
        (
            candidate
            for candidate in read_sheet_as_objects_(sheet_name)
            if str(candidate.get('MID') or '').strip() == normalized_mid
        ),
        None,
    )
    if row is None:
        completed_sheet = {
            'Discontinue': config.SHEET_COMPLETED,
            'Inactive': config.SHEET_INACTIVE_COMPLETED,
            'Transfer': config.SHEET_TRANSFER_COMPLETED,
        }[workflow]
        if any(
            str(candidate.get('MID') or '').strip() == normalized_mid
            for candidate in read_sheet_as_objects_(completed_sheet)
        ):
            raise ApiError('AUTH_FORBIDDEN')
        raise ApiError('STUDENT_NOT_FOUND')

    if row.get('Status') in (
        config.STATUS_APPROVED,
        config.STATUS_INACTIVE_APPROVED,
        config.STATUS_INACTIVE_CONVERTED,
        config.STATUS_TRANSFER_APPROVED,
    ):
        raise ApiError('AUTH_FORBIDDEN')

    allowed_statuses = _status_options_(workflow, row, 'active', user['role'])
    if status not in allowed_statuses:
        raise ApiError('BAD_REQUEST')
    if status == config.STATUS_PENDING_CORRECTION:
        rejected_roles = {
            role.strip()
            for role in str(row.get('Rejected Roles') or '').split(',')
            if role.strip()
        }
        if not rejected_roles or not rejected_roles.issubset(set(config.CORRECTABLE_ROLES)):
            raise ApiError('BAD_REQUEST')

    old_status = row.get('Status') or ''
    if status == old_status:
        return {'success': True, 'status': status}
    if (
        user['role'] == config.ROLE_ADMIN
        and status in (
            config.STATUS_PENDING_ADMIN,
            config.STATUS_INACTIVE_PENDING_ADMIN,
            config.STATUS_TRANSFER_PENDING_ADMIN,
        )
        and row.get('Head Office Decision') != 'APPROVED'
    ):
        raise ApiError('BAD_REQUEST')

    now = now_iso_()
    update = {'Status': status}
    if status in (
        config.STATUS_PENDING_ADMIN,
        config.STATUS_INACTIVE_PENDING_ADMIN,
        config.STATUS_TRANSFER_PENDING_ADMIN,
    ):
        if user['role'] == config.ROLE_HEAD_OFFICE:
            update.update({
                'Head Office Decision': 'APPROVED',
                'Head Office Name': user['name'],
                'Head Office Date': now,
            })
        update.update({
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
        })
    else:
        update.update({
            'Head Office Decision': '',
            'Head Office Name': '',
            'Head Office Date': '',
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
        })
    if old_status == config.STATUS_PENDING_CORRECTION and status != config.STATUS_PENDING_CORRECTION:
        update['Rejected Roles'] = ''

    update_row_fields_(sheet_name, row['__row'], update)
    old_label = config.STATUS_LABELS.get(old_status, old_status or 'Unknown')
    new_label = config.STATUS_LABELS.get(status, status)
    log_audit_(
        user['email'],
        'STATUS_OVERRIDE',
        f"{user['role']} changed {workflow} MID {normalized_mid} status: {old_label} -> {new_label}",
        row.get('Branch'),
        browser,
    )
    invalidate_cache_(['dashboard_' + str(row.get('Branch') or ''), 'dashboard_ALL'])
    return {'success': True, 'status': status}
