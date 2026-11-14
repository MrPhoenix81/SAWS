import unittest
from datetime import datetime
from unittest.mock import patch

import config
import dashboard


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 14, 12, 0, 0)


class DashboardMonthlyBranchCountTests(unittest.TestCase):
    def setUp(self):
        self.sheets = {
            config.SHEET_RESPONSE: [
                {'Branch': 'ALPHA', 'Status': config.STATUS_PENDING_HOF_MANAGER, 'Entry Date': '2026-11-02'},
                {'Branch': 'ALPHA', 'Status': config.STATUS_PENDING_HOF_MANAGER, 'Entry Date': '2026-11-14'},
                {'Branch': 'ALPHA', 'Status': config.STATUS_PENDING_HOF_MANAGER, 'Entry Date': '2026-10-31'},
            ],
            config.SHEET_COMPLETED: [
                {'Branch': 'ALPHA', 'Status': config.STATUS_APPROVED, 'Entry Date': '2026-11-05'},
                {'Branch': 'BETA', 'Status': config.STATUS_APPROVED, 'Entry Date': '2026-11-07'},
            ],
            config.SHEET_INACTIVE_RESPONSE: [
                {'Branch': 'BETA', 'Status': config.STATUS_INACTIVE_PENDING_HEAD_OFFICE, 'Entry Date': '2026-11-08'},
                {'Branch': 'ALPHA', 'Status': config.STATUS_INACTIVE_CONVERTED, 'Entry Date': '2026-11-09'},
            ],
            config.SHEET_INACTIVE_COMPLETED: [
                {'Branch': 'BETA', 'Status': config.STATUS_INACTIVE_APPROVED, 'Entry Date': '2026-11-10'},
            ],
            config.SHEET_TRANSFER_RESPONSE: [
                {'Branch': 'ALPHA', 'Status': config.STATUS_TRANSFER_PENDING_HEAD_OFFICE, 'Entry Date': '2026-11-11'},
                {'Branch': 'BETA', 'Status': config.STATUS_TRANSFER_PENDING_HEAD_OFFICE, 'Entry Date': '2026-11-14'},
            ],
            config.SHEET_TRANSFER_COMPLETED: [],
        }

    def _get_dashboard(self, user, params=None):
        with (
            patch.object(dashboard, 'datetime', FixedDateTime),
            patch.object(
                dashboard,
                'read_sheet_as_objects_',
                side_effect=lambda sheet_name: self.sheets[sheet_name],
            ),
            patch.object(dashboard, 'list_branches_', return_value=[
                {'name': 'ALPHA', 'active': True},
                {'name': 'BETA', 'active': True},
                {'name': 'EMPTY', 'active': True},
            ]),
            patch.object(dashboard, 'get_cached_', side_effect=lambda _key, _ttl, producer: producer()),
        ):
            return dashboard.get_dashboard_data_(user, params)

    def test_admin_sees_current_month_entry_counts_for_each_branch(self):
        result = self._get_dashboard({'role': config.ROLE_ADMIN, 'branch': ''})

        self.assertEqual(
            result['charts']['monthlyBranchCount'],
            [
                {'branch': 'ALPHA', 'count': 4},
                {'branch': 'BETA', 'count': 4},
            ],
        )
        self.assertEqual(
            result['charts']['dailyBranchCount'],
            [
                {'branch': 'ALPHA', 'count': 1},
                {'branch': 'BETA', 'count': 1},
            ],
        )

    def test_branch_user_only_sees_their_own_branch_count(self):
        result = self._get_dashboard({'role': config.ROLE_SCM, 'branch': 'ALPHA'})

        self.assertEqual(result['charts']['monthlyBranchCount'], [{'branch': 'ALPHA', 'count': 4}])
        self.assertEqual(result['charts']['dailyBranchCount'], [{'branch': 'ALPHA', 'count': 1}])

    def test_global_branch_filter_and_workflow_filter_are_applied(self):
        result = self._get_dashboard(
            {'role': config.ROLE_HEAD_OFFICE, 'branch': ''},
            {'branch': 'BETA', 'workflow': 'Inactive'},
        )

        self.assertEqual(result['charts']['monthlyBranchCount'], [{'branch': 'BETA', 'count': 2}])
        self.assertEqual(result['charts']['dailyBranchCount'], [])


if __name__ == '__main__':
    unittest.main()
