"""Dashboard aggregation for all three SDMS workflows."""
from collections import defaultdict
from datetime import datetime, timedelta

import config
from auth import ApiError, require_role_
from branches import list_branches_
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


def _short_status_label(workflow_name, status):
    label = config.STATUS_LABELS.get(status, status)
    prefix = f'{workflow_name} - '
    if isinstance(label, str) and label.startswith(prefix):
        return label[len(prefix):]
    return label


def get_dashboard_data_(user, params=None):
    params = params or {}
    is_global = user['role'] in config.GLOBAL_VISIBILITY_ROLES
    requested_branch = str(params.get('branch') or '').strip() if is_global else str(user.get('branch') or '').strip()
    date_from = params.get('dateFrom')
    date_to = params.get('dateTo')
    available_workflows = ('Discontinue', 'Inactive', 'Transfer')
    requested_workflow = str(params.get('workflow') or '').strip()
    if requested_workflow and requested_workflow not in available_workflows:
        raise ApiError('BAD_REQUEST')
    selected_workflows = (requested_workflow,) if requested_workflow else available_workflows
    cache_key = None if date_from or date_to or requested_workflow or (is_global and requested_branch) else ('dashboard_ALL' if is_global else 'dashboard_' + requested_branch)

    def producer():
        sources = {
            'Discontinue': (read_sheet_as_objects_(config.SHEET_RESPONSE), read_sheet_as_objects_(config.SHEET_COMPLETED),
                            config.STATUS_APPROVED),
            'Inactive': ([r for r in read_sheet_as_objects_(config.SHEET_INACTIVE_RESPONSE)
                          if r.get('Status') != config.STATUS_INACTIVE_CONVERTED],
                         [r for r in read_sheet_as_objects_(config.SHEET_INACTIVE_COMPLETED)
                          if r.get('Status') != config.STATUS_INACTIVE_CONVERTED],
                         config.STATUS_INACTIVE_APPROVED),
            'Transfer': (read_sheet_as_objects_(config.SHEET_TRANSFER_RESPONSE), read_sheet_as_objects_(config.SHEET_TRANSFER_COMPLETED),
                         config.STATUS_TRANSFER_APPROVED),
        }

        def scoped(rows):
            rows = rows if is_global and not requested_branch else [r for r in rows if r.get('Branch') == requested_branch]
            return [r for r in rows if _in_date_range(r, date_from, date_to)]

        workflow_rows = {}
        for name in selected_workflows:
            active, completed, approved_status = sources[name]
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
            rows = workflow_rows.get(name)
            return len(rows[0]) if rows else 0

        def count_pending(name):
            rows = workflow_rows.get(name)
            return len([r for r in rows[0] if r.get('Status') in pending_statuses]) if rows else 0

        def count_approved(name):
            rows = workflow_rows.get(name)
            return len(rows[1]) if rows else 0

        cards = {
            'pending': len([r for r in active_all if r.get('Status') in pending_statuses]),
            'awaitingHeadOffice': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_HEAD_OFFICE, config.STATUS_INACTIVE_PENDING_HEAD_OFFICE, config.STATUS_TRANSFER_PENDING_HEAD_OFFICE)]),
            'awaitingAdminApproval': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_ADMIN, config.STATUS_INACTIVE_PENDING_ADMIN, config.STATUS_TRANSFER_PENDING_ADMIN)]),
            'approved': len(completed_all),
            'rejected': len([r for r in active_all if r.get('Status') in (config.STATUS_PENDING_SCM, config.STATUS_INACTIVE_PENDING_SCM, config.STATUS_TRANSFER_PENDING_SCM)]),
            'todaysEntries': 0,
            'monthlyEntries': 0,
            'discontinuePending': count_pending('Discontinue'),
            'discontinueApproved': count_approved('Discontinue'),
            'inactivePending': count_pending('Inactive'),
            'inactiveApproved': count_approved('Inactive'),
            'transferPending': count_pending('Transfer'),
            'transferApproved': count_approved('Transfer'),
        }

        today = datetime.now()
        for r in all_rows:
            d = _parse_dt(r.get('Entry Date') or r.get('SCM Updated Date'))
            if d and (d.year, d.month, d.day) == (today.year, today.month, today.day):
                cards['todaysEntries'] += 1
            if d and (d.year, d.month) == (today.year, today.month):
                cards['monthlyEntries'] += 1

        workflow_comparison = []
        for name in selected_workflows:
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
        for name in available_workflows:
            active, completed, _ = workflow_rows.get(name, ([], [], None))
            counts = defaultdict(int)
            counts['Approved'] = len(completed)
            for r in active:
                counts[_short_status_label(name, r.get('Status'))] += 1
            status_distribution[name] = sorted(
                ({'status': k, 'count': v} for k, v in counts.items() if v > 0),
                key=lambda item: item['count'],
                reverse=True,
            )

        branch_comparison = []
        if is_global:
            branch_counts = defaultdict(lambda: {'pending': 0, 'approved': 0, 'total': 0})
            for name in selected_workflows:
                active, completed, _ = sources[name]
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

        monthly_trend = build_date_trend_(all_rows, 'Entry Date', 12, 'month')
        monthly_branch_counts = defaultdict(int)
        daily_branch_counts = defaultdict(int)
        for name in selected_workflows:
            active, completed, _ = sources[name]
            for row in active + completed:
                branch = str(row.get('Branch') or 'Unknown').strip() or 'Unknown'
                if not is_global and branch != requested_branch:
                    continue
                if is_global and requested_branch and branch != requested_branch:
                    continue
                entry_date = _parse_dt(row.get('Entry Date'))
                if not entry_date:
                    continue
                if (entry_date.year, entry_date.month, entry_date.day) == (today.year, today.month, today.day):
                    daily_branch_counts[branch] += 1
                if (entry_date.year, entry_date.month) == (today.year, today.month):
                    monthly_branch_counts[branch] += 1

        branch_workflow_counts = defaultdict(
            lambda: defaultdict(lambda: {'active': 0, 'approved': 0, 'total': 0})
        )
        for name in selected_workflows:
            active, completed, _ = workflow_rows[name]
            for rows, state in ((active, 'active'), (completed, 'approved')):
                for row in rows:
                    branch = str(row.get('Branch') or 'Unknown').strip() or 'Unknown'
                    branch_workflow_count = branch_workflow_counts[branch][name]
                    branch_workflow_count[state] += 1
                    branch_workflow_count['total'] += 1

        branch_names = set(branch_workflow_counts)
        if is_global and not requested_branch:
            branch_names.update(
                str(branch.get('name') or '').strip()
                for branch in list_branches_(False)
                if str(branch.get('name') or '').strip()
            )
        elif requested_branch:
            branch_names.add(requested_branch)
        branch_workflow_count = [
            {'branch': branch, 'workflows': {
                name: branch_workflow_counts.get(branch, {}).get(
                    name, {'active': 0, 'approved': 0, 'total': 0}
                )
                for name in selected_workflows
            }}
            for branch in sorted(branch_names)
        ]

        daily_branch_count = [
            {'branch': branch, 'count': count}
            for branch, count in sorted(
                ((branch, count) for branch, count in daily_branch_counts.items() if count > 0),
                key=lambda item: (-item[1], item[0]),
            )
        ]
        monthly_branch_names = set(monthly_branch_counts)
        if is_global and not requested_branch:
            monthly_branch_names.update(
                str(branch.get('name') or '').strip()
                for branch in list_branches_(False)
                if str(branch.get('name') or '').strip()
            )
        elif requested_branch:
            monthly_branch_names.add(requested_branch)
        monthly_branch_count = [
            {'branch': branch, 'count': monthly_branch_counts.get(branch, 0)}
            for branch in sorted(
                monthly_branch_names,
                key=lambda branch: (-monthly_branch_counts.get(branch, 0), branch),
            )
            if monthly_branch_counts.get(branch, 0) > 0
        ]

        return {
            'scope': {'branch': requested_branch or 'All branches', 'global': is_global},
            'cards': cards,
            'charts': {
                'monthlyTrend': monthly_trend,
                'dailyBranchCount': daily_branch_count,
                'branchWorkflowCount': branch_workflow_count,
                'monthlyBranchCount': monthly_branch_count,
                'branchComparison': branch_comparison,
                'statusDistribution': status_distribution,
                'workflowComparison': workflow_comparison,
            },
        }

    return get_cached_(cache_key, config.DASHBOARD_CACHE_TTL_SECONDS, producer) if cache_key else producer()


def get_dashboard_rows_(user, params=None):
    """Return rows represented by a dashboard KPI or status distribution."""
    params = params or {}
    metric = str(params.get('metric') or '')
    supported_metrics = {
        'pending', 'awaitingHeadOffice', 'awaitingAdminApproval', 'approved',
        'rejected', 'todaysEntries', 'monthlyEntries', 'statusDistribution',
    }
    if metric not in supported_metrics:
        raise ApiError('BAD_REQUEST')

    is_global = user['role'] in config.GLOBAL_VISIBILITY_ROLES
    requested_branch = str(params.get('branch') or '').strip() if is_global else str(user.get('branch') or '').strip()
    requested_workflow = str(params.get('workflow') or '').strip()
    available_workflows = ('Discontinue', 'Inactive', 'Transfer')
    if requested_workflow and requested_workflow not in available_workflows:
        raise ApiError('BAD_REQUEST')
    requested_status = str(params.get('status') or '').strip()
    if metric == 'statusDistribution' and (not requested_workflow or not requested_status):
        raise ApiError('BAD_REQUEST')

    pending_statuses = {
        config.STATUS_PENDING_HOF_MANAGER, config.STATUS_WAITING_FOR_HOF, config.STATUS_WAITING_FOR_MANAGER,
        config.STATUS_PENDING_HEAD_OFFICE, config.STATUS_PENDING_ADMIN, config.STATUS_PENDING_CORRECTION,
        config.STATUS_PENDING_SCM,
        config.STATUS_INACTIVE_PENDING_HEAD_OFFICE, config.STATUS_INACTIVE_PENDING_ADMIN, config.STATUS_INACTIVE_PENDING_SCM,
        config.STATUS_TRANSFER_PENDING_HEAD_OFFICE, config.STATUS_TRANSFER_PENDING_ADMIN, config.STATUS_TRANSFER_PENDING_SCM,
    }
    head_office_statuses = {
        config.STATUS_PENDING_HEAD_OFFICE,
        config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
        config.STATUS_TRANSFER_PENDING_HEAD_OFFICE,
    }
    admin_statuses = {
        config.STATUS_PENDING_ADMIN,
        config.STATUS_INACTIVE_PENDING_ADMIN,
        config.STATUS_TRANSFER_PENDING_ADMIN,
    }
    rejected_statuses = {
        config.STATUS_PENDING_SCM,
        config.STATUS_INACTIVE_PENDING_SCM,
        config.STATUS_TRANSFER_PENDING_SCM,
    }
    today = datetime.now()
    rows = []
    sources = {
        'Discontinue': (config.SHEET_RESPONSE, config.SHEET_COMPLETED),
        'Inactive': (config.SHEET_INACTIVE_RESPONSE, config.SHEET_INACTIVE_COMPLETED),
        'Transfer': (config.SHEET_TRANSFER_RESPONSE, config.SHEET_TRANSFER_COMPLETED),
    }
    for workflow in ((requested_workflow,) if requested_workflow else available_workflows):
        active_sheet, completed_sheet = sources[workflow]
        active = read_sheet_as_objects_(active_sheet)
        completed = read_sheet_as_objects_(completed_sheet)
        if workflow == 'Inactive':
            active = [row for row in active if row.get('Status') != config.STATUS_INACTIVE_CONVERTED]
            completed = [row for row in completed if row.get('Status') != config.STATUS_INACTIVE_CONVERTED]
        scoped_rows = []
        if metric == 'approved':
            scoped_rows = [(row, 'completed') for row in completed]
        elif metric == 'statusDistribution':
            source_rows = completed if requested_status == 'Approved' else active
            sheet = 'completed' if requested_status == 'Approved' else 'active'
            scoped_rows = [(row, sheet) for row in source_rows]
        elif metric in ('todaysEntries', 'monthlyEntries'):
            scoped_rows = [(row, 'active') for row in active] + [(row, 'completed') for row in completed]
        else:
            scoped_rows = [(row, 'active') for row in active]

        for row, sheet in scoped_rows:
            if not is_global and row.get('Branch') != requested_branch:
                continue
            if is_global and requested_branch and row.get('Branch') != requested_branch:
                continue
            if not _in_date_range(row, params.get('dateFrom'), params.get('dateTo')):
                continue

            status = row.get('Status')
            if metric == 'statusDistribution':
                chart_status = 'Approved' if sheet == 'completed' else _short_status_label(workflow, status)
                if chart_status != requested_status:
                    continue
            if metric == 'pending' and status not in pending_statuses:
                continue
            if metric == 'awaitingHeadOffice' and status not in head_office_statuses:
                continue
            if metric == 'awaitingAdminApproval' and status not in admin_statuses:
                continue
            if metric == 'rejected' and status not in rejected_statuses:
                continue
            if metric in ('todaysEntries', 'monthlyEntries'):
                entry_date = _parse_dt(row.get('Entry Date') or row.get('SCM Updated Date'))
                if not entry_date:
                    continue
                if metric == 'todaysEntries' and (entry_date.year, entry_date.month, entry_date.day) != (today.year, today.month, today.day):
                    continue
                if metric == 'monthlyEntries' and (entry_date.year, entry_date.month) != (today.year, today.month):
                    continue

            rows.append({
                'slNo': row.get('Sl No', ''),
                'mid': row.get('MID', ''),
                'studentName': row.get('Student Name', ''),
                'branch': row.get('Branch') or 'Unknown',
                'workflow': workflow,
                'currentStatus': config.STATUS_LABELS.get(status, status or ''),
                'tab': sheet,
            })

    return {'total': len(rows), 'rows': rows}


def get_dashboard_export_data_(user, params=None):
    """Return filtered workflow records for role-appropriate dashboard exports."""
    params = params or {}
    allowed_roles = (config.ROLE_SCM, config.ROLE_HEAD_OFFICE, config.ROLE_ADMIN)
    require_role_(user, allowed_roles)

    is_global = user['role'] in config.GLOBAL_VISIBILITY_ROLES
    requested_branch = str(params.get('branch') or '').strip() if is_global else str(user.get('branch') or '').strip()
    requested_workflow = str(params.get('workflow') or '').strip()
    available_workflows = ('Discontinue', 'Inactive', 'Transfer')
    if requested_workflow and requested_workflow not in available_workflows:
        raise ApiError('BAD_REQUEST')

    columns = [
        'Workflow', 'Record Set', 'Status', 'Sl No', 'Branch', 'MID', 'Student Name',
        'Batch Name', 'Faculty Name', 'Phone Number 1', 'Phone Number 2', 'Phone Number 3',
        'Total Billed', 'Total Paid', 'Arrear', 'Last Present Day', 'Days Since Present',
        'Entry Date', 'SCM Updated Date', 'HOF Updated Date', 'Manager Updated Date',
        'Head Office Decision', 'Head Office Name', 'Head Office Date',
        'Admin Approval', 'Admin Name', 'Approval Date',
        'Inactive From', 'Inactive To', 'Discontinue Converted Date', 'Transfer To Branch',
        'Last Rejected By', 'Last Rejected Stage', 'Last Rejected Date', 'Rejected Roles',
    ]
    if user['role'] in (config.ROLE_ADMIN, config.ROLE_HEAD_OFFICE):
        columns.extend([
            'Reason (SCM)', 'Reason (HOF)', 'Reason (Manager)', 'Reason', 'Last Rejection Reason',
        ])

    sources = {
        'Discontinue': (config.SHEET_RESPONSE, config.SHEET_COMPLETED),
        'Inactive': (config.SHEET_INACTIVE_RESPONSE, config.SHEET_INACTIVE_COMPLETED),
        'Transfer': (config.SHEET_TRANSFER_RESPONSE, config.SHEET_TRANSFER_COMPLETED),
    }
    conversion_dates = {}
    for inactive_row in read_sheet_as_objects_(config.SHEET_INACTIVE_COMPLETED):
        converted_mid = str(inactive_row.get('Converted To Discontinue MID') or '').strip()
        if converted_mid and inactive_row.get('Converted Date'):
            conversion_dates[converted_mid] = {
                'Inactive From': inactive_row.get('Last Present Day') or '',
                'Inactive To': inactive_row.get('Approval Date') or '',
                'Discontinue Converted Date': inactive_row.get('Converted Date') or '',
            }

    workflows = (requested_workflow,) if requested_workflow else available_workflows
    rows = []
    for workflow in workflows:
        active_sheet, completed_sheet = sources[workflow]
        active_rows = read_sheet_as_objects_(active_sheet)
        completed_rows = read_sheet_as_objects_(completed_sheet)
        if workflow == 'Inactive':
            active_rows = [row for row in active_rows if row.get('Status') != config.STATUS_INACTIVE_CONVERTED]
            completed_rows = [row for row in completed_rows if row.get('Status') != config.STATUS_INACTIVE_CONVERTED]

        for record_set, source_rows in (('Active', active_rows), ('Approved', completed_rows)):
            for record in source_rows:
                if not is_global and record.get('Branch') != requested_branch:
                    continue
                if is_global and requested_branch and record.get('Branch') != requested_branch:
                    continue
                if not _in_date_range(record, params.get('dateFrom'), params.get('dateTo')):
                    continue

                row = {
                    field: record.get(field, '')
                    for field in columns
                    if field not in ('Workflow', 'Record Set', 'Status')
                }
                row['Workflow'] = workflow
                row['Record Set'] = record_set
                status = record.get('Status')
                row['Status'] = config.STATUS_LABELS.get(status, status or '')
                if workflow == 'Discontinue':
                    conversion = conversion_dates.get(str(record.get('MID') or '').strip(), {})
                    for field, value in conversion.items():
                        if not row.get(field):
                            row[field] = value
                rows.append(row)

    return {'columns': columns, 'rows': rows}


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