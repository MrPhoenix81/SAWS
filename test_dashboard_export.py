import unittest
from unittest.mock import patch

import config
import dashboard
from auth import ApiError


class DashboardExportTests(unittest.TestCase):
    def setUp(self):
        self.sheets = {
            config.SHEET_RESPONSE: [
                {
                    'Branch': 'ALPHA',
                    'MID': 'D-1',
                    'Student Name': 'Student One',
                    'Status': config.STATUS_PENDING_ADMIN,
                    'Phone Number 1': '1234567890',
                    'Total Billed': 1000,
                    'Total Paid': 700,
                    'Arrear': 300,
                    'Reason (SCM)': 'Private SCM reason',
                    'SCM Updated Date': '2026-11-15',
                    'Approval Date': '',
                },
                {
                    'Branch': 'BETA',
                    'MID': 'D-2',
                    'Student Name': 'Other Branch',
                    'Status': config.STATUS_PENDING_ADMIN,
                    'Reason (SCM)': 'Other private reason',
                },
            ],
            config.SHEET_COMPLETED: [],
            config.SHEET_INACTIVE_RESPONSE: [
                {
                    'Branch': 'ALPHA',
                    'MID': 'I-1',
                    'Student Name': 'Inactive Student',
                    'Status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE,
                    'Reason': 'Inactive reason',
                },
            ],
            config.SHEET_INACTIVE_COMPLETED: [
                {
                    'Status': config.STATUS_INACTIVE_CONVERTED,
                    'Converted To Discontinue MID': 'D-1',
                    'Converted Date': '2026-11-16',
                    'Last Present Day': '2026-10-01',
                    'Approval Date': '2026-10-12',
                },
            ],
            config.SHEET_TRANSFER_RESPONSE: [],
            config.SHEET_TRANSFER_COMPLETED: [],
        }

    def _export(self, user, params=None):
        with patch.object(
            dashboard,
            'read_sheet_as_objects_',
            side_effect=lambda sheet_name: self.sheets[sheet_name],
        ):
            return dashboard.get_dashboard_export_data_(user, params)

    def test_scm_export_is_branch_scoped_and_contains_no_reason_fields_or_values(self):
        result = self._export({'role': config.ROLE_SCM, 'branch': 'ALPHA'})

        self.assertEqual([row['MID'] for row in result['rows']], ['D-1', 'I-1'])
        self.assertFalse(any('reason' in column.lower() for column in result['columns']))
        self.assertNotIn('Private SCM reason', str(result['rows']))
        discontinue_row = result['rows'][0]
        self.assertEqual(discontinue_row['Total Billed'], 1000)
        self.assertEqual(discontinue_row['Total Paid'], 700)
        self.assertEqual(discontinue_row['Arrear'], 300)
        self.assertEqual(discontinue_row['Discontinue Converted Date'], '2026-11-16')

    def test_head_office_export_includes_reason_values_and_workflow_filter(self):
        result = self._export(
            {'role': config.ROLE_HEAD_OFFICE, 'branch': ''},
            {'workflow': 'Discontinue'},
        )

        self.assertIn('Reason (SCM)', result['columns'])
        self.assertEqual(result['rows'][0]['Reason (SCM)'], 'Private SCM reason')
        self.assertEqual({row['Workflow'] for row in result['rows']}, {'Discontinue'})

    def test_manager_cannot_use_dashboard_data_export(self):
        with self.assertRaises(ApiError):
            self._export({'role': config.ROLE_MANAGER, 'branch': 'ALPHA'})


if __name__ == '__main__':
    unittest.main()
