import unittest
from unittest.mock import patch

import api
import config
from auth import ApiError


class HeadOfficeDataPermissionTests(unittest.TestCase):
    def setUp(self):
        self.head_office = {
            'email': 'office@example.com',
            'name': 'Head Office User',
            'branch': 'HEAD OFFICE',
            'role': config.ROLE_HEAD_OFFICE,
        }

    def test_head_office_can_open_branch_management(self):
        with patch.object(api, 'list_branches_', return_value=[{'name': 'ALPHA', 'active': True}]):
            result = api.route_action_('branches.listAll', self.head_office, {})

        self.assertEqual(result, [{'name': 'ALPHA', 'active': True}])

    def test_manager_cannot_open_branch_management(self):
        with self.assertRaises(ApiError) as raised:
            api.route_action_(
                'branches.listAll',
                {'role': config.ROLE_MANAGER},
                {},
            )

        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')

    def test_head_office_receives_only_the_backup_sheet_system_link(self):
        with patch.multiple(
            config,
            SYSTEM_LINK_DATABASE='https://database.example',
            SYSTEM_LINK_IMAGE_STORAGE='https://images.example',
            SYSTEM_LINK_BACKUP_SHEET='https://sheet.example',
            SYSTEM_LINK_HOSTING='https://hosting.example',
            SYSTEM_LINK_UPTIME_MONITOR='https://uptime.example',
        ):
            result = api.route_action_('admin.systemLinks', self.head_office, {})

        self.assertEqual(result['links'], [{
            'key': 'backupSheet',
            'label': 'Backup Google Sheet',
            'url': 'https://sheet.example',
        }])

    def test_head_office_cannot_run_manual_backup(self):
        with self.assertRaises(ApiError) as raised:
            api.route_action_('admin.runBackupNow', self.head_office, {})

        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')


if __name__ == '__main__':
    unittest.main()
