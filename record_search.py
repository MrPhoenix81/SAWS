"""Cross-workflow MID search for Admin and Head Office."""
import config
from auth import ApiError, require_role_
from db_utils import read_sheet_as_objects_
from filters import filter_student_row_for_role_
from inactive import _serialize_ as serialize_inactive_
from students import _attach_inactive_conversion_dates_
from transfer import _serialize_ as serialize_transfer_


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
            })

    return {'MID': normalized_mid, 'results': results}
