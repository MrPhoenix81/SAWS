import unittest
from unittest.mock import patch

import config
import dashboard
from auth import ApiError


class DashboardStatusDistributionRowsTests(unittest.TestCase):
    def setUp(self):
        self.sheets = {
            config.SHEET_RESPONSE: [
                {'Sl No': 1, 'MID': 'D-1', 'Student Name': 'Discontinue Pending', 'Branch': 'ALPHA',
                 'Status': config.STATUS_PENDING_ADMIN},
                {'Sl No': 2, 'MID': 'D-2', 'Student Name': 'Other Branch', 'Branch': 'BETA',
                 'Status': config.STATUS_PENDING_ADMIN},
            ],
            config.SHEET_COMPLETED: [
                {'Sl No': 3, 'MID': 'D-3', 'Student Name': 'Discontinue Approved', 'Branch': 'ALPHA',
                 'Status': config.STATUS_APPROVED},
            ],
            config.SHEET_INACTIVE_RESPONSE: [
                {'Sl No': 4, 'MID': 'I-1', 'Student Name': 'Inactive Pending', 'Branch': 'ALPHA',
                 'Status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE},
                {'Sl No': 5, 'MID': 'I-2', 'Student Name': 'Converted', 'Branch': 'ALPHA',
                 'Status': config.STATUS_INACTIVE_CONVERTED},
            ],
            config.SHEET_INACTIVE_COMPLETED: [
                {'Sl No': 6, 'MID': 'I-3', 'Student Name': 'Inactive Approved', 'Branch': 'ALPHA',
                 'Status': config.STATUS_INACTIVE_APPROVED},
            ],
            config.SHEET_TRANSFER_RESPONSE: [],
            config.SHEET_TRANSFER_COMPLETED: [],
        }

    def _get_rows(self, params):
        with patch.object(
            dashboard,
            'read_sheet_as_objects_',
            side_effect=lambda sheet_name: self.sheets[sheet_name],
        ):
            return dashboard.get_dashboard_rows_(
                {'role': config.ROLE_ADMIN, 'branch': ''}, params,
            )

    def test_selects_active_rows_for_the_clicked_workflow_and_status(self):
        result = self._get_rows({
            'metric': 'statusDistribution',
            'workflow': 'Inactive',
            'status': 'Pending Head Office',
        })

        self.assertEqual(result['total'], 1)
        self.assertEqual(result['rows'][0]['mid'], 'I-1')
        self.assertEqual(result['rows'][0]['currentStatus'], 'Inactive - Pending Head Office')

    def test_approved_status_selects_completed_rows(self):
        result = self._get_rows({
            'metric': 'statusDistribution',
            'workflow': 'Inactive',
            'status': 'Approved',
        })

        self.assertEqual(result['total'], 1)
        self.assertEqual(result['rows'][0]['mid'], 'I-3')
        self.assertEqual(result['rows'][0]['tab'], 'completed')

    def test_requires_workflow_for_status_distribution(self):
        with self.assertRaises(ApiError):
            self._get_rows({'metric': 'statusDistribution', 'status': 'Approved'})


if __name__ == '__main__':
    unittest.main()
