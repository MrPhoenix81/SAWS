"""
api.py
Flask Blueprint for the backend API, mounted at /api by app.py.

Originally a standalone Flask entry point (app.py) that owned the
whole "/" route as a single POST endpoint - a direct port of Code.gs
/ the Apps Script web app's doPost. That's been converted into a
Blueprint here so it can be served from the same process as the
React frontend (which needs "/" for the page itself) - see app.py
in this same folder for how the two are combined.

ALL API requests - reads and writes - still go through this single
POST endpoint (now at /api/) as JSON: { action, token, payload }.

Auth is email + password based (see auth.py / users.py). 'token' is
the signed session token returned by 'auth.login', not a password.
"""
from flask import Blueprint, request, jsonify, current_app

import config
from db_utils import ensure_sheets_exist_, read_sheet_as_objects_
from auth import (
    ApiError, authenticate_, require_role_, login_with_password_,
    request_password_reset_, reset_password_with_token_, verify_session_token_,
    find_user_by_email_, change_password_,
)
from audit_log import log_audit_, get_audit_logs_
from branches import list_branches_, create_branch_, delete_branch_, reactivate_branch_
from users import create_user_, update_user_, delete_user_, reset_user_password_
from notifications import (
    get_notifications_for_user_, mark_notification_read_, mark_all_notifications_read_,
    mark_page_seen_, get_unseen_counts_,
)
from dashboard import get_dashboard_data_
from inactive import (
    submit_inactive_, list_inactive_, head_office_approve_inactive_, head_office_reject_inactive_,
    admin_approve_inactive_, admin_reject_inactive_, admin_update_inactive_, head_office_update_inactive_, delete_inactive_,
    submit_inactive_correction_, get_inactive_screenshot_url_,
)
from transfer import (
    submit_transfer_, list_transfer_, head_office_approve_transfer_, head_office_reject_transfer_, head_office_update_transfer_,
    admin_approve_transfer_, admin_reject_transfer_, delete_transfer_,
    submit_transfer_correction_, get_transfer_screenshot_url_,
)
from students import (
    list_students_, submit_student_entry_, submit_scm_reason_, submit_scm_student_details_,
    submit_hof_reason_, submit_manager_reason_, head_office_approve_, head_office_reject_,
    approve_student_entry_, reject_student_entry_, admin_update_student_entry_,
    delete_student_entry_, get_reason_screenshot_url_,
)
from bulk import bulk_template_, bulk_export_, bulk_import_, bulk_delete_

api_bp = Blueprint('api', __name__)

# Errors whose message string is returned to the client as `error`
# instead of being masked as SERVER_ERROR. Direct port of the `known`
# array in Code.gs's doPost/catch blocks.
KNOWN_ERROR_CODES = {
    'AUTH_FORBIDDEN', 'STUDENT_NOT_FOUND', 'NOTIFICATION_NOT_FOUND', 'BAD_REQUEST',
    'UNKNOWN_ACTION', 'AUTH_INVALID_CREDENTIALS', 'PASSWORD_TOO_SHORT',
    'AUTH_INVALID_RESET_TOKEN', 'MID_ALREADY_EXISTS', 'AUTH_INVALID_TOKEN', 'AUTH_NOT_REGISTERED',
    'REASON_UNCHANGED', 'PASSWORD_TOO_SHORT', 'PASSWORD_REQUIRED', 'SCREENSHOT_REQUIRED',
    'SCREENSHOT_UPLOAD_FAILED',
}


def json_response_(obj):
    """
    Matches the original jsonResponse_(obj) in Code.gs, which (like
    every Apps Script ContentService web app) always returns HTTP 200
    regardless of the logical error code - the frontend is expected
    to check the `ok` field in the body, not the HTTP status. Kept
    identical here for drop-in compatibility with an existing
    frontend. If you'd rather use real HTTP status codes, change the
    `200` below to accept a status kwarg.
    """
    return jsonify(obj), 200


@api_bp.route('/', methods=['GET'])
def do_get():
    """Health check - mirrors Code.gs's doGet."""
    return json_response_({'ok': True, 'message': 'Student Discontinuation Management System API is running.'})


@api_bp.route('/', methods=['POST'])
def do_post():
    ensure_sheets_exist_()

    try:
        body = request.get_json(force=True, silent=False)
        if body is None:
            raise ValueError()
    except Exception:
        return json_response_({'ok': False, 'error': 'BAD_REQUEST', 'message': 'Invalid JSON body'})

    action = body.get('action')
    token = body.get('token')
    payload = body.get('payload') or {}

    # ---- Public actions that don't require a signed-in user yet ----
    if action == 'auth.login':
        return handle_login_(payload)
    if action == 'auth.whoami':
        return handle_who_am_i_(token)
    if action == 'auth.forgotPassword':
        return json_response_({'ok': True, 'data': request_password_reset_(payload)})
    if action == 'auth.resetPassword':
        try:
            return json_response_({'ok': True, 'data': reset_password_with_token_(payload)})
        except ApiError as err:
            code = err.code if err.code in ('AUTH_INVALID_RESET_TOKEN', 'PASSWORD_TOO_SHORT') else 'SERVER_ERROR'
            return json_response_({'ok': False, 'error': code, 'message': str(err.code)})

    try:
        user = authenticate_(token)
    except ApiError as err:
        return json_response_({'ok': False, 'error': err.code or 'AUTH_FAILED'})

    if action == 'auth.logout':
        log_audit_(user['email'], 'LOGOUT', 'User signed out', user['branch'], body.get('browser'))
        return json_response_({'ok': True, 'data': {'success': True}})

    try:
        result = route_action_(action, user, payload)
        return json_response_({'ok': True, 'data': result})
    except ApiError as err:
        code = err.code if err.code in KNOWN_ERROR_CODES else 'SERVER_ERROR'
        if code == 'SERVER_ERROR':
            current_app.logger.exception('Unexpected error handling action %s', action)
        return json_response_({'ok': False, 'error': code, 'message': str(err.code)})
    except Exception as err:  # noqa: BLE001 - mirrors the GAS catch-all -> SERVER_ERROR behavior
        current_app.logger.exception('Unexpected error handling action %s', action)
        return json_response_({'ok': False, 'error': 'SERVER_ERROR', 'message': str(err)})


def handle_login_(payload):
    """Verifies email+password, logs a LOGIN audit event on success."""
    try:
        result = login_with_password_(payload)
        log_audit_(result['user']['email'], 'LOGIN', 'User signed in', result['user']['branch'], payload.get('browser'))
        return json_response_({'ok': True, 'data': result})
    except ApiError as err:
        code = 'AUTH_INVALID_CREDENTIALS' if err.code == 'AUTH_INVALID_CREDENTIALS' else 'AUTH_FAILED'
        return json_response_({'ok': False, 'error': code, 'message': 'Incorrect email or password.'})


def handle_who_am_i_(token):
    """Verifies an existing session token to restore a session on page load."""
    email = verify_session_token_(token)
    if not email:
        return json_response_({'ok': False, 'error': 'AUTH_INVALID_TOKEN'})
    user = find_user_by_email_(email)
    if not user:
        return json_response_({'ok': False, 'error': 'AUTH_NOT_REGISTERED'})
    return json_response_({'ok': True, 'data': user})


def route_action_(action, user, payload):
    """
    Central action dispatch table. Direct port of routeAction_ in
    Code.gs - keeping this as one big if/elif makes it easy to see
    the entire API surface at a glance and audit permissions.
    """
    # ---- Students / Workflow ----
    if action == 'students.list':
        return list_students_(user, config.SHEET_RESPONSE, payload)
    if action == 'students.listCompleted':
        return list_students_(user, config.SHEET_COMPLETED, payload)
    if action == 'students.submit':
        return submit_student_entry_(user, payload)
    if action == 'students.submitScmReason':
        return submit_scm_reason_(user, payload.get('mid'), payload.get('reason'),
                                   payload.get('screenshot'), payload.get('browser'),
                                   payload.get('screenshots'))
    if action == 'students.scmUpdateDetails':
        return submit_scm_student_details_(user, payload.get('mid'), payload.get('fields'), payload.get('browser'))
    if action == 'students.submitHofReason':
        return submit_hof_reason_(user, payload.get('mid'), payload.get('confirmedReason'),
                                   payload.get('screenshot'), payload.get('browser'))
    if action == 'students.submitManagerReason':
        return submit_manager_reason_(user, payload.get('mid'), payload.get('verifiedReason'),
                                       payload.get('screenshot'), payload.get('browser'))
    if action == 'students.getReasonScreenshotUrl':
        return get_reason_screenshot_url_(user, payload.get('mid'), payload.get('sheet'),
                                           payload.get('role'), payload.get('browser'))
    if action == 'students.headOfficeApprove':
        return head_office_approve_(user, payload.get('mid'), payload.get('browser'))
    if action == 'students.headOfficeReject':
        return head_office_reject_(user, payload.get('mid'), payload.get('rejectionReason'),
                                    payload.get('rejectedRoles'), payload.get('browser'))
    if action == 'students.approve':
        return approve_student_entry_(user, payload.get('mid'), payload.get('browser'))
    if action == 'students.reject':
        return reject_student_entry_(user, payload.get('mid'), payload.get('rejectionReason'), payload.get('browser'))
    if action == 'students.adminUpdate':
        return admin_update_student_entry_(user, payload.get('mid'), payload.get('sheet'),
                                            payload.get('fields'), payload.get('browser'))
    if action == 'students.delete':
        return delete_student_entry_(user, payload.get('mid'), payload.get('sheet'),
                                      payload.get('confirmMid'), payload.get('browser'))

    # ---- Inactive workflow ----
    if action == 'inactive.submit':
        return submit_inactive_(user, payload)
    if action == 'inactive.list':
        return list_inactive_(user, False, payload)
    if action == 'inactive.listCompleted':
        return list_inactive_(user, True, payload)
    if action == 'inactive.headOfficeApprove':
        return head_office_approve_inactive_(user, payload.get('mid'), payload.get('browser'))
    if action == 'inactive.headOfficeReject':
        return head_office_reject_inactive_(
            user, payload.get('mid'), payload.get('rejectionReason'), payload.get('browser')
        )
    if action == 'inactive.approve':
        return admin_approve_inactive_(user, payload.get('mid'), payload.get('browser'))
    if action == 'inactive.reject':
        return admin_reject_inactive_(
            user, payload.get('mid'), payload.get('rejectionReason'), payload.get('browser')
        )
    if action == 'inactive.headOfficeUpdate':
        return head_office_update_inactive_(
            user, payload.get('mid'), payload.get('fields'), payload.get('browser')
        )
    if action == 'inactive.adminUpdate':
        return admin_update_inactive_(
            user, payload.get('mid'), payload.get('fields'), payload.get('browser')
        )
    if action == 'inactive.delete':
        return delete_inactive_(
            user, payload.get('mid'), payload.get('sheet'), payload.get('confirmMid'), payload.get('browser')
        )
    if action == 'inactive.scmCorrect':
        return submit_inactive_correction_(
            user, payload.get('mid'), payload.get('fields'), payload.get('browser')
        )
    if action == 'inactive.getScreenshotUrl':
        return get_inactive_screenshot_url_(
            user, payload.get('mid'), payload.get('sheet'), payload.get('browser')
        )

    # ---- Transfer workflow ----
    if action == 'transfer.submit':
        return submit_transfer_(user, payload)
    if action == 'transfer.list':
        return list_transfer_(user, False, payload)
    if action == 'transfer.listCompleted':
        return list_transfer_(user, True, payload)
    if action == 'transfer.headOfficeUpdate':
        return head_office_update_transfer_(
            user, payload.get('mid'), payload.get('fields'), payload.get('browser')
        )
    if action == 'transfer.headOfficeApprove':
        return head_office_approve_transfer_(user, payload.get('mid'), payload.get('browser'))
    if action == 'transfer.headOfficeReject':
        return head_office_reject_transfer_(
            user, payload.get('mid'), payload.get('rejectionReason'), payload.get('browser')
        )
    if action == 'transfer.approve':
        return admin_approve_transfer_(user, payload.get('mid'), payload.get('browser'))
    if action == 'transfer.reject':
        return admin_reject_transfer_(
            user, payload.get('mid'), payload.get('rejectionReason'), payload.get('browser')
        )
    if action == 'transfer.delete':
        return delete_transfer_(
            user, payload.get('mid'), payload.get('sheet'), payload.get('confirmMid'), payload.get('browser')
        )
    if action == 'transfer.scmCorrect':
        return submit_transfer_correction_(
            user, payload.get('mid'), payload.get('fields'), payload.get('browser')
        )
    if action == 'transfer.getScreenshotUrl':
        return get_transfer_screenshot_url_(
            user, payload.get('mid'), payload.get('sheet'), payload.get('browser')
        )

    # ---- Admin: manually trigger the Google Sheet backup (item 5) ----
    if action == 'admin.runBackupNow':
        require_role_(user, [config.ROLE_ADMIN])
        from backup_to_sheets import run_backup_
        try:
            result = run_backup_()
            log_audit_(user['email'], 'BACKUP_RUN_MANUAL',
                       f'Manual backup run: {result.get("totalRows", 0)} row(s) appended',
                       user.get('branch'), payload.get('browser'))
            return result
        except Exception as exc:  # noqa: BLE001
            log_audit_(user['email'], 'BACKUP_RUN_MANUAL_FAILED', f'Manual backup run failed: {exc}',
                       user.get('branch'), payload.get('browser'))
            raise ApiError(f'Backup failed: {exc}') from exc

    # ---- Dashboard ----
    if action == 'dashboard.get':
        return get_dashboard_data_(user)

    # ---- Admin: System / Important Links (item 9) ----
    # Plain external URLs only - no credentials are ever stored or
    # returned here. Each linked service handles its own login.
    if action == 'admin.systemLinks':
        require_role_(user, [config.ROLE_ADMIN])
        links = [
            {'key': 'database', 'label': 'Data Storage / Database', 'url': config.SYSTEM_LINK_DATABASE},
            {'key': 'imageStorage', 'label': 'Image Storage / Image Database', 'url': config.SYSTEM_LINK_IMAGE_STORAGE},
            {'key': 'backupSheet', 'label': 'Backup Google Sheet', 'url': config.SYSTEM_LINK_BACKUP_SHEET},
            {'key': 'hosting', 'label': 'Hosting Platform', 'url': config.SYSTEM_LINK_HOSTING},
            {'key': 'uptimeMonitor', 'label': 'Uptime Monitoring Service', 'url': config.SYSTEM_LINK_UPTIME_MONITOR},
        ]
        return {'links': [l for l in links if l['url']]}

    # ---- Notifications ----
    if action == 'notifications.list':
        return get_notifications_for_user_(user['email'])
    if action == 'notifications.markRead':
        mark_notification_read_(payload.get('id'))
        return {'success': True}
    if action == 'notifications.markAllRead':
        mark_all_notifications_read_(user['email'])
        return {'success': True}

    # ---- Sidebar "unseen" badges (independent from pendingForMe - see
    # notifications.py) ----
    if action == 'pages.markSeen':
        return mark_page_seen_(user['email'], payload.get('page'))
    if action == 'pages.unseenCounts':
        return get_unseen_counts_(user['email'])

    # ---- Self-service ----
    if action == 'auth.changePassword':
        return change_password_(user, payload)

    # ---- Users (Admin + Head Office; users.py enforces the finer split) ----
    if action == 'users.list':
        require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
        return [
            {'email': u['Email'], 'name': u['Name'], 'branch': u['Branch'], 'role': u['Role']}
            for u in read_sheet_as_objects_(config.SHEET_USERS)
        ]
    if action == 'users.create':
        require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
        return create_user_(user, payload)
    if action == 'users.update':
        require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
        return update_user_(user, payload)
    if action == 'users.delete':
        require_role_(user, [config.ROLE_ADMIN])  # deletion stays Admin-only
        return delete_user_(user, payload.get('email'))
    if action == 'users.resetPassword':
        require_role_(user, [config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE])
        return reset_user_password_(user, payload.get('email'))

    # ---- Branches ----
    if action == 'branches.list':
        return [b['name'] for b in list_branches_(False)]
    if action == 'branches.listAll':
        require_role_(user, [config.ROLE_ADMIN])
        return list_branches_(True)
    if action == 'branches.create':
        require_role_(user, [config.ROLE_ADMIN])
        return create_branch_(user, payload)
    if action == 'branches.delete':
        require_role_(user, [config.ROLE_ADMIN])
        return delete_branch_(user, payload)
    if action == 'branches.reactivate':
        require_role_(user, [config.ROLE_ADMIN])
        return reactivate_branch_(user, payload)

    # ---- Audit Logs (Admin + Head Office see all branches, others see own) ----
    if action == 'auditlogs.list':
        return get_audit_logs_(payload.get('branch') if user['role'] in config.GLOBAL_VISIBILITY_ROLES else user['branch'])

    # ---- Exports (returns data; actual file generation happens client-side) ----
    if action == 'exports.students':
        sheet = config.SHEET_COMPLETED if payload.get('sheet') == 'completed' else config.SHEET_RESPONSE
        return list_students_(user, sheet, payload)

    # ---- Bulk data (Admin view: upload / download / delete across any
    # workflow and branch - bulk.py enforces Admin-only on every one) ----
    if action == 'bulk.template':
        return bulk_template_(user, payload)
    if action == 'bulk.export':
        return bulk_export_(user, payload)
    if action == 'bulk.import':
        return bulk_import_(user, payload)
    if action == 'bulk.delete':
        return bulk_delete_(user, payload)

    raise ApiError('UNKNOWN_ACTION')