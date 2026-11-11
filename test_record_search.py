import unittest
from unittest.mock import patch

import config
import record_search
import students
from auth import ApiError


class GlobalRecordSearchTests(unittest.TestCase):
    def setUp(self):
        self.user = {'role': config.ROLE_ADMIN, 'branch': ''}
        self.workflow_rows = {
            config.SHEET_RESPONSE: [{
                '__row': 1,
                'MID': 'MID123',
                'Student Name': 'Discontinue Student',
                'Branch': 'TIRUR',
                'Status': config.STATUS_PENDING_HOF_MANAGER,
            }],
            config.SHEET_COMPLETED: [],
            config.SHEET_INACTIVE_RESPONSE: [{
                '__row': 2,
                'MID': 'MID123',
                'Student Name': 'Inactive Student',
                'Branch': 'MANJERI',
                'Status': config.STATUS_INACTIVE_PENDING_ADMIN,
            }],
            config.SHEET_INACTIVE_COMPLETED: [{
                '__row': 3,
                'MID': 'MID123',
                'Student Name': 'Approved Inactive Student',
                'Branch': 'KOLLAM',
                'Status': config.STATUS_INACTIVE_APPROVED,
            }],
            config.SHEET_TRANSFER_RESPONSE: [{
                '__row': 4,
                'MID': 'MID123',
                'Student Name': 'Transfer Student',
                'Branch': 'KOZHIKODE',
                'Status': config.STATUS_TRANSFER_PENDING_ADMIN,
            }],
            config.SHEET_TRANSFER_COMPLETED: [],
        }

    def _read_workflow_rows(self, sheet_name):
        return self.workflow_rows[sheet_name]

    def test_search_returns_matching_records_from_all_workflows_and_tabs(self):
        with (
            patch.object(record_search, 'read_sheet_as_objects_', side_effect=self._read_workflow_rows),
            patch.object(
                students,
                'read_sheet_as_objects_',
                return_value=self.workflow_rows[config.SHEET_INACTIVE_COMPLETED],
            ),
        ):
            result = record_search.search_records_by_mid_(self.user, ' MID123 ')

        self.assertEqual(result['MID'], 'MID123')
        self.assertEqual(
            [(item['workflow'], item['tab']) for item in result['results']],
            [
                ('Discontinue', 'active'),
                ('Inactive', 'active'),
                ('Inactive', 'completed'),
                ('Transfer', 'active'),
            ],
        )
        self.assertTrue(all('__row' not in item['record'] for item in result['results']))

    def test_search_is_restricted_to_admin_and_head_office(self):
        with self.assertRaises(ApiError) as raised:
            record_search.search_records_by_mid_(
                {'role': config.ROLE_SCM, 'branch': 'TIRUR'}, 'MID123'
            )
        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')

    def test_search_requires_a_mid(self):
        with self.assertRaises(ApiError) as raised:
            record_search.search_records_by_mid_(self.user, '  ')
        self.assertEqual(raised.exception.code, 'BAD_REQUEST')


if __name__ == '__main__':
    unittest.main()
