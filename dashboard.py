"""Dashboard aggregation for all three SDMS workflows."""
from collections import defaultdict
from datetime import datetime, timedelta

import config
from db_utils import read_sheet_as_objects_, get_cached_


def _parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:19])
    except Exception:
        return None


def _in_date_range(row, date_from=None, date_to=None):
    if not date_from and not date_to:
        return True
    raw = row.get('Entry Date') or row.get('SCM Updated Date') or row.get('Approval Date')
    d = _parse_dt(raw)
    if not d:
        return False
    if date_from and d.date() < datetime.fromisoformat(str(date_from)[:10]).date():
        return False
    if date_to and d.date() > datetime.fromisoformat(str(date_to)[:10]).date():
        return False
    return True


def get_dashboard_data_(user, params=None):
    params = params or {}
    is_global = user['role'] in config.GLOBAL_VISIBILITY_ROLES
    requested_branch = str(params.get('branch') or '').strip() if is_global else str(user.get('branch') or '').strip()
    date_from = params.get('dateFrom')
    date_to = params.get('dateTo')
    cache_key = None if date_from or date_to or (is_global and requested_branch) else ('dashboard_ALL' if is_global else 'dashboard_' + requested_branch)

    def producer():
        sources = {
            'Discontinue': (read_sheet_as_objects_(config.SHEET_RESPONSE), read_sheet_as_objects_(config.SHEET_COMPLETED),
                            config.STATUS_APPROVED),
            'Inactive': (read_sheet_as_objects_(config.SHEET_INACTIVE_RESPONSE), read_sheet_as_objects_(config.SHEET_INACTIVE_COMPLETED),
                         config.STATUS_INACTIVE_APPROVED),
            'Transfer': (read_sheet_as_objects_(config.SHEET_TRANSFER_RESPONSE), read_sheet_as_objects_(config.SHEET_TRANSFER_COMPLETED),
                         config.STATUS_TRANSFER_APPROVED),
        }

        def scoped(rows):
            rows = rows if is_global and not requested_branch else [r for r in rows if r.get('Branch') == requested_branch]
            return [r for r in rows if _in_date_range(r, date_from, date_to)]

        workflow_rows = {}
        for name, (active, completed, approved_status) in sources.items():
            workflow_rows[name] = (scoped(active), scoped(completed), approved_status)

        active_all = [r for pair in workflow_rows.values() for r in pair[0]]
        completed_all = [r for pair in workflow_rows.values() for r in pair[1]]
        all_rows = active_all + completed_all

        pending_statuses = {
            config.STATUS_PENDING_HOF_MANAGER, config.STATUS_WAITING_FOR_HOF, config.STATUS_WAITING_FOR_MANAGER,
            config.STATUS_PENDING_HEAD_OFFICE, config.STATUS_PENDING_ADMIN, config.STATUS_PENDING_CORRECTION,
            config.STATUS_PENDING_SCM,
            config.STATUS_INACTIVE_PENDING_HEAD_OFFICE, config.STATUS_INACTIVE_PENDING_ADMIN, config.STATUS_INACTIVE_PENDING_SCM,
            config.STATUS_TRANSFER_PENDING_HEAD_OFFICE, config.STATUS_TRANSFER_PENDING_ADMIN, config.STATUS_TRANSFER_PENDING_SCM,
        }

        def count_active(name):
            return len(workflow_rows[name][0])

        def count_pending(name):
            return len([r for r in workflow_rows[name][0] if r.get('Status') in pending_statuses])

        cards = {
            'pending': len([r for r in active_all if r.get('Status') in pending_statuses]),
            'awaitingHeadOffice': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_HEAD_OFFICE, config.STATUS_INACTIVE_PENDING_HEAD_OFFICE, config.STATUS_TRANSFER_PENDING_HEAD_OFFICE)]),
            'awaitingAdminApproval': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_ADMIN, config.STATUS_INACTIVE_PENDING_ADMIN, config.STATUS_TRANSFER_PENDING_ADMIN)]),
            'approved': len(completed_all),
            'rejected': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_SCM, config.STATUS_INACTIVE_PENDING_SCM, config.STATUS_TRANSFER_PENDING_SCM)]),
            'todaysEntries': 0,
            'monthlyEntries': 0,
            'discontinuePending': count_pending('Discontinue'),
            'discontinueApproved': len(workflow_rows['Discontinue'][1]),
            'inactivePending': count_pending('Inactive'),
            'inactiveApproved': len(workflow_rows['Inactive'][1]),
            'transferPending': count_pending('Transfer'),
            'transferApproved': len(workflow_rows['Transfer'][1]),
        }

        today = datetime.now()
        for r in all_rows:
            d = _parse_dt(r.get('Entry Date') or r.get('SCM Updated Date'))
            if d and (d.year, d.month, d.day) == (today.year, today.month, today.day):
                cards['todaysEntries'] += 1
            if d and (d.year, d.month) == (today.year, today.month):
                cards['monthlyEntries'] += 1

        workflow_comparison = []
        for name in ('Discontinue', 'Inactive', 'Transfer'):
            workflow_comparison.append({
                'workflow': name,
                'pending': count_pending(name),
                'approved': len(workflow_rows[name][1]),
                'total': count_active(name) + len(workflow_rows[name][1]),
            })

        # One breakdown per workflow (not a single mixed list): each
        # workflow's completed rows collapse into a single "Approved" bar,
        # and its active rows are grouped by status label with no workflow
        # prefix (the surrounding chart already says which workflow it is).
        # Sorted highest -> lowest so the frontend can shade bars by rank.
        status_distribution = {}
        for name, (active, completed, approved_status) in workflow_rows.items():
            counts = defaultdict(int)
            counts['Approved'] = len(completed)
            for r in active:
                counts[config.STATUS_LABELS.get(r.get('Status'), r.get('Status'))] += 1
            status_distribution[name] = sorted(
                ({'status': k, 'count': v} for k, v in counts.items() if v > 0),
                key=lambda item: item['count'],
                reverse=True,
            )

        branch_comparison = []
        if is_global:
            branch_counts = defaultdict(lambda: {'pending': 0, 'approved': 0, 'total': 0})
            for name, (active, completed, _) in sources.items():
                rows = active + completed
                if date_from or date_to:
                    rows = [r for r in rows if _in_date_range(r, date_from, date_to)]
                for r in rows:
                    b = r.get('Branch') or 'Unknown'
                    branch_counts[b]['total'] += 1
                    if r.get('Status') in pending_statuses:
                        branch_counts[b]['pending'] += 1
                    else:
                        branch_counts[b]['approved'] += 1
            branch_comparison = [{'branch': b, **v} for b, v in sorted(branch_counts.items())]

        daily_trend = build_date_trend_(all_rows, 'Entry Date', 14, 'day')
        monthly_trend = build_date_trend_(all_rows, 'Entry Date', 12, 'month')
        approval_trend = build_date_trend_(completed_all, 'Approval Date', 14, 'day')

        return {
            'scope': {'branch': requested_branch or 'All branches', 'global': is_global},
            'cards': cards,
            'charts': {
                'dailyTrend': daily_trend,
                'monthlyTrend': monthly_trend,
                'approvalTrend': approval_trend,
                'branchComparison': branch_comparison,
                'statusDistribution': status_distribution,
                'workflowComparison': workflow_comparison,
            },
        }

    return get_cached_(cache_key, config.DASHBOARD_CACHE_TTL_SECONDS, producer) if cache_key else producer()


def build_date_trend_(rows, date_field, num_buckets, granularity):
    buckets = defaultdict(int)
    def key_for(d):
        return d.strftime('%Y-%m-%d') if granularity == 'day' else d.strftime('%Y-%m')
    for r in rows:
        dd = _parse_dt(r.get(date_field))
        if dd:
            buckets[key_for(dd)] += 1
    out = []
    now = datetime.now()
    for i in range(num_buckets - 1, -1, -1):
        if granularity == 'day':
            d = now - timedelta(days=i)
        else:
            month = now.month - i
            year = now.year
            while month <= 0:
                month += 12
                year -= 1
            d = now.replace(year=year, month=month, day=1)
        key = key_for(d)
        out.append({'label': key, 'count': buckets.get(key, 0)})
    return out