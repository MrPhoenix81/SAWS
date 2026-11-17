import unittest
from unittest.mock import patch

import config
import record_search
from auth import ApiError


class RecordStatusOverrideTests(unittest.TestCase):
    def setUp(self):
        self.user = {
            'email': 'office@example.com',
            'name': 'Head Office User',
            'role': config.ROLE_HEAD_OFFICE,
        }
        self.row = {
            '__row': 42,
            'MID': 'MID-42',
            'Branch': 'ALPHA',
            'Status': config.STATUS_PENDING_ADMIN,
            'Head Office Decision': 'APPROVED',
            'Head Office Name': 'Head Office User',
            'Head Office Date': '2025-01-01',
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
        }
        self.updates = []
        self.read_rows = patch.object(record_search, 'read_sheet_as_objects_')
        self.write_rows = patch.object(
            record_search, 'update_row_fields_', side_effect=self._capture_update,
        )
        self.invalidate_cache = patch.object(record_search, 'invalidate_cache_')
        self.now = patch.object(record_search, 'now_iso_', return_value='2025-02-01T00:00:00')
        self.audit = patch.object(record_search, 'log_audit_')
        self.read_rows_mock = self.read_rows.start()
        self.write_rows.start()
        self.invalidate_cache.start()
        self.now.start()
        self.audit.start()
        self.addCleanup(patch.stopall)
        self.read_rows_mock.return_value = [self.row]

    def _capture_update(self, sheet, row_id, fields):
        self.updates.append((sheet, row_id, fields))

    def test_head_office_can_move_to_pending_admin_but_not_final_approval(self):
        self.row['Status'] = config.STATUS_PENDING_HEAD_OFFICE
        result = record_search.update_record_status_(
            self.user, 'MID-42', 'Discontinue', config.STATUS_PENDING_ADMIN, None,
        )

        self.assertEqual(result, {'success': True, 'status': config.STATUS_PENDING_ADMIN})
        self.assertEqual(self.updates[0][2], {
            'Status': config.STATUS_PENDING_ADMIN,
            'Head Office Decision': 'APPROVED',
            'Head Office Name': 'Head Office User',
            'Head Office Date': '2025-02-01T00:00:00',
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
        })

    def test_admin_can_use_pending_status_editor_without_overwriting_head_office_approval(self):
        self.row['Status'] = config.STATUS_PENDING_HEAD_OFFICE
        admin = {
            'email': 'admin@example.com',
            'name': 'Admin User',
            'role': config.ROLE_ADMIN,
        }

        result = record_search.update_record_status_(
            admin, 'MID-42', 'Discontinue', config.STATUS_PENDING_ADMIN, None,
        )

        self.assertEqual(result['status'], config.STATUS_PENDING_ADMIN)
        self.assertNotIn('Head Office Decision', self.updates[0][2])
        self.assertNotIn('Head Office Name', self.updates[0][2])

    def test_admin_cannot_promote_to_pending_admin_without_head_office_approval(self):
        self.row['Status'] = config.STATUS_PENDING_HEAD_OFFICE
        self.row['Head Office Decision'] = ''
        admin = {
            'email': 'admin@example.com',
            'name': 'Admin User',
            'role': config.ROLE_ADMIN,
        }

        with self.assertRaises(ApiError) as raised:
            record_search.update_record_status_(
                admin, 'MID-42', 'Discontinue', config.STATUS_PENDING_ADMIN, None,
            )

        self.assertEqual(raised.exception.code, 'BAD_REQUEST')
        self.assertEqual(self.updates, [])

    def test_pending_stage_change_clears_approval_fields(self):
        result = record_search.update_record_status_(
            self.user, 'MID-42', 'Discontinue', config.STATUS_PENDING_HEAD_OFFICE, None,
        )

        self.assertEqual(result['status'], config.STATUS_PENDING_HEAD_OFFICE)
        self.assertEqual(self.updates[0][0:2], (config.SHEET_RESPONSE, 42))
        self.assertEqual(self.updates[0][2], {
            'Status': config.STATUS_PENDING_HEAD_OFFICE,
            'Head Office Decision': '',
            'Head Office Name': '',
            'Head Office Date': '',
            'Admin Approval': '',
            'Admin Name': '',
            'Approval Date': '',
        })

    def test_final_approved_status_is_rejected(self):
        with self.assertRaises(ApiError) as raised:
            record_search.update_record_status_(
                self.user, 'MID-42', 'Discontinue', config.STATUS_APPROVED, None,
            )

        self.assertEqual(raised.exception.code, 'BAD_REQUEST')

    def test_final_approved_statuses_are_rejected_for_every_workflow(self):
        workflows = (
            ('Discontinue', config.STATUS_PENDING_ADMIN, config.STATUS_APPROVED),
            ('Inactive', config.STATUS_INACTIVE_PENDING_ADMIN, config.STATUS_INACTIVE_APPROVED),
            ('Transfer', config.STATUS_TRANSFER_PENDING_ADMIN, config.STATUS_TRANSFER_APPROVED),
        )
        for workflow, current_status, final_status in workflows:
            with self.subTest(workflow=workflow):
                self.row['Status'] = current_status
                with self.assertRaises(ApiError) as raised:
                    record_search.update_record_status_(
                        self.user, 'MID-42', workflow, final_status, None,
                    )
                self.assertEqual(raised.exception.code, 'BAD_REQUEST')

    def test_admin_cannot_use_status_editor_to_skip_final_approval(self):
        self.row['Status'] = config.STATUS_PENDING_ADMIN
        admin = {
            'email': 'admin@example.com',
            'name': 'Admin User',
            'role': config.ROLE_ADMIN,
        }

        with self.assertRaises(ApiError) as raised:
            record_search.update_record_status_(
                admin, 'MID-42', 'Discontinue', config.STATUS_APPROVED, None,
            )

        self.assertEqual(raised.exception.code, 'BAD_REQUEST')

    def test_completed_rows_cannot_be_changed_by_head_office(self):
        self.read_rows_mock.side_effect = lambda sheet: (
            [] if sheet == config.SHEET_RESPONSE else [self.row]
        )
        self.row['Status'] = config.STATUS_APPROVED

        with self.assertRaises(ApiError) as raised:
            record_search.update_record_status_(
                self.user, 'MID-42', 'Discontinue', config.STATUS_PENDING_ADMIN, None,
            )

        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')

    def test_non_head_office_role_cannot_change_status(self):
        with self.assertRaises(ApiError) as raised:
            record_search.update_record_status_(
                {'role': config.ROLE_MANAGER},
                'MID-42',
                'Discontinue',
                config.STATUS_PENDING_HEAD_OFFICE,
                None,
            )

        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')


if __name__ == '__main__':
    unittest.main()
