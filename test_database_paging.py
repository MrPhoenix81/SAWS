import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import config
import cleanup
import db_utils
import students


class DatabasePagingTests(unittest.TestCase):
    def test_sheet_page_queries_filters_total_and_only_returns_the_requested_page(self):
        record = {'total': 42, 'id': 7, 'data': {'MID': 'M123'}}
        with patch.object(db_utils, 'fetch_all_', return_value=[record]) as fetch:
            result = db_utils.query_sheet_page_(
                config.SHEET_RESPONSE,
                filters=[
                    ('Branch', 'eq', 'TIRUR'),
                    ('MID', 'contains_case_sensitive', 'M1'),
                ],
                search='student',
                search_fields=('Student Name',),
                order_by=[('text', 'Student Name', 'DESC'), ('id', '', 'ASC')],
                page=2,
                page_size=10,
            )

        self.assertEqual(result, {
            'total': 42,
            'rows': [{'MID': 'M123', '__row': 7}],
        })
        query, params = fetch.call_args.args
        self.assertNotIn('COUNT(*) FILTER', query)
        self.assertIn('ROW_NUMBER() OVER', query)
        self.assertIn('page_order > %s AND page_order <= %s', query)
        self.assertEqual(params, (
            config.SHEET_RESPONSE,
            'Branch', 'TIRUR',
            'M1', 'MID',
            'student', 'Student Name',
            'Student Name',
            10, 20,
        ))

    def test_workflow_page_keeps_role_scope_and_admin_active_filter_in_sql(self):
        page = {
            'total': 1,
            'rows': [{'MID': 'MID1'}],
        }
        with patch.object(db_utils, 'query_sheet_page_', return_value=page) as query:
            result = db_utils.query_workflow_page_(
                config.SHEET_INACTIVE_RESPONSE,
                {'role': config.ROLE_ADMIN, 'branch': ''},
                {'page': 1, 'pageSize': 25, 'search': 'mid'},
                False,
                config.STATUS_INACTIVE_PENDING_ADMIN,
                {config.ROLE_ADMIN: config.STATUS_INACTIVE_PENDING_ADMIN},
                exclude_status=config.STATUS_INACTIVE_CONVERTED,
            )

        self.assertEqual(result['total'], 1)
        self.assertNotIn('pendingForMe', result)
        kwargs = query.call_args.kwargs
        self.assertIn(('Status', 'eq', config.STATUS_INACTIVE_PENDING_ADMIN), kwargs['filters'])
        self.assertIn(('Status', 'distinct', config.STATUS_INACTIVE_CONVERTED), kwargs['filters'])
        self.assertEqual(kwargs['search'], 'mid')
        self.assertEqual(kwargs['order_by'], [
            ('raw', 'Entry Date', 'DESC'),
            ('id', '', 'ASC'),
        ])

    def test_student_page_returns_role_filtered_rows_without_aggregate_pending_count(self):
        raw_row = {
            'MID': 'MID1',
            'Branch': 'TIRUR',
            'Student Name': 'Student One',
            'Status': config.STATUS_PENDING_SCM,
        }
        page = {'total': 1, 'rows': [raw_row]}
        user = {
            'role': config.ROLE_SCM,
            'branch': 'TIRUR',
            'email': 'scm@example.test',
            'name': 'SCM',
        }
        with (
            patch.object(students, 'query_sheet_page_', return_value=page) as query,
            patch.object(students, 'fetch_all_', return_value=[]),
        ):
            result = students.list_students_(user, config.SHEET_RESPONSE, {'page': 1})

        self.assertEqual(result['total'], 1)
        self.assertEqual(result['rows'][0]['MID'], 'MID1')
        self.assertTrue(result['rows'][0]['Awaiting My Action'])
        self.assertNotIn('pendingForMe', result)
        self.assertIn(('Branch', 'eq', 'TIRUR'), query.call_args.kwargs['filters'])

    def test_cleanup_candidate_query_selects_only_requested_fields(self):
        candidate = {'MID': 'MID1', 'Approval Date': '2025-01-01T10:00:00'}
        with patch.object(
            db_utils,
            'fetch_all_',
            return_value=[{'id': 9, 'data': candidate}],
        ) as fetch:
            rows = db_utils.query_cleanup_rows_(
                config.SHEET_COMPLETED,
                '2025-01-01',
                ['MID', 'Approval Date'],
                approved_only=True,
                screenshot_fields=[config.SCREENSHOT_FIELD_SCM],
            )

        self.assertEqual(rows, [{**candidate, '__row': 9}])
        query, params = fetch.call_args.args
        self.assertIn('jsonb_build_object', query)
        self.assertIn('SUBSTRING', query)
        self.assertIn("data->>'Admin Approval' = 'APPROVED'", query)
        self.assertIn('jsonb_array_length', query)
        self.assertNotIn('SELECT id, data FROM sheet_rows', query)
        self.assertEqual(params[:6], (
            'MID', 'MID',
            'Approval Date', 'Approval Date',
            config.SHEET_COMPLETED,
            '2025-01-01',
        ))
        self.assertEqual(params[-3:], (
            config.SCREENSHOT_FIELD_SCM,
            config.SCREENSHOT_FIELD_SCM,
            config.SCREENSHOT_FIELD_SCM,
        ))

    def test_retention_cleanup_still_requires_a_backup_after_approval(self):
        now = datetime(2026, 3, 19, 12, 0, 0)
        approval_date = now - timedelta(days=config.RECORD_RETENTION_DAYS + 2)
        candidate = {
            'MID': 'MID1',
            'Student Name': 'Student One',
            'Approval Date': approval_date.isoformat(),
            'Admin Approval': 'APPROVED',
            '__row': 8,
        }

        def candidate_rows(sheet_name, cutoff_date, fields, approved_only=False, screenshot_fields=()):
            if sheet_name == config.SHEET_COMPLETED:
                self.assertEqual(cutoff_date, (
                    now - timedelta(days=config.RECORD_RETENTION_DAYS)
                ).strftime('%Y-%m-%d'))
                self.assertTrue(approved_only)
                return [candidate]
            return []

        with (
            patch.object(cleanup, 'query_cleanup_rows_', side_effect=candidate_rows),
            patch.object(
                cleanup,
                '_last_successful_backup_at_',
                return_value=approval_date - timedelta(days=1),
            ),
            patch.object(cleanup, '_log_cleanup_') as log_cleanup,
            patch.object(cleanup, 'delete_row_') as delete_row,
        ):
            result = cleanup.run_cleanup_(now)

        self.assertEqual(result, {'deleted': 0, 'skipped': 1})
        delete_row.assert_not_called()
        self.assertEqual(log_cleanup.call_args.args[5], 'SKIPPED')


if __name__ == '__main__':
    unittest.main()
