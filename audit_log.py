"""
audit_log.py
Append-only log of security-relevant actions. Direct port of AuditLog.gs.
"""
import config
from db_utils import append_row_, read_sheet_as_objects_, now_iso_


def log_audit_(user_email, action, details, branch, browser):
    append_row_(config.SHEET_AUDITLOGS, {
        'Timestamp': now_iso_(),
        'User Email': user_email or '',
        'Action': action or '',
        'Details': details or '',
        'Branch': branch or '',
        'Browser': browser or '',
    })


def get_audit_logs_(branch_filter):
    """
    Returns audit log rows, optionally filtered by branch (non-Admins
    should only ever be passed their own branch by the router).
    """
    rows = read_sheet_as_objects_(config.SHEET_AUDITLOGS)
    filtered = [r for r in rows if r.get('Branch') == branch_filter] if branch_filter else rows
    filtered.sort(key=lambda r: r.get('Timestamp') or '', reverse=True)
    return [
        {
            'timestamp': r.get('Timestamp'),
            'userEmail': r.get('User Email'),
            'action': r.get('Action'),
            'details': r.get('Details'),
            'branch': r.get('Branch'),
            'browser': r.get('Browser'),
        }
        for r in filtered
    ]
