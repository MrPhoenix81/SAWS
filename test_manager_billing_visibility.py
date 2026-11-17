import unittest

import config
from filters import filter_student_row_for_role_


class ManagerBillingVisibilityTests(unittest.TestCase):
    def test_manager_can_see_billing_values_without_changing_hof_view(self):
        row = {
            'Branch': 'ALPHA',
            'MID': 'M-1',
            'Student Name': 'Student',
            'Status': config.STATUS_PENDING_HOF_MANAGER,
            'Total Billed': 1200,
            'Total Paid': 800,
            'Arrear': 400,
        }

        manager_row = filter_student_row_for_role_(
            row, {'role': config.ROLE_MANAGER, 'branch': 'ALPHA'},
        )
        hof_row = filter_student_row_for_role_(
            row, {'role': config.ROLE_HOF, 'branch': 'ALPHA'},
        )

        self.assertEqual(
            (manager_row['Total Billed'], manager_row['Total Paid'], manager_row['Arrear']),
            (1200, 800, 400),
        )
        self.assertNotIn('Total Billed', hof_row)


if __name__ == '__main__':
    unittest.main()
