import unittest
from unittest.mock import patch

import config
import inactive
import students
from auth import ApiError


class InactiveConversionTests(unittest.TestCase):
    def setUp(self):
        self.user = {
            'role': config.ROLE_SCM,
            'branch': 'TIRUR',
            'email': 'scm@example.test',
            'name': 'Branch SCM',
        }
        self.row = {
            '__row': 42,
            'MID': 'MID123',
            'Branch': 'TIRUR',
            'Student Name': 'Test Student',
            'Status': config.STATUS_INACTIVE_APPROVED,
            'Reason': 'Old inactive reason',
            'Last Present Day': '2026-01-02',
            'Approval Date': '2026-01-10T09:30:00',
            'Batch Name': 'Batch A',
            'Faculty Name': 'Faculty A',
            'Phone Number 1': '1234567890',
        }
        self.fields = {
            'studentName': 'Edited Student',
            'batchName': 'Batch B',
            'facultyName': 'Faculty B',
            'phone1': '1234567890',
            'phone2': '0987654321',
            'phone3': '',
            'totalBilled': '2500',
            'totalPaid': '1250',
            'lastPresentDay': '2026-02-03',
            'reason': 'New discontinue reason',
        }

    def test_search_only_returns_approved_students_in_the_scm_branch(self):
        rows = [
            self.row,
            {**self.row, 'MID': 'OTHER123', 'Branch': 'OTHER'},
            {**self.row, 'MID': 'PENDING123', 'Status': config.STATUS_INACTIVE_PENDING_ADMIN},
        ]
        with patch.object(inactive, 'read_sheet_as_objects_', return_value=rows):
            results = inactive.search_convertible_inactive_(self.user, 'mid')

        self.assertEqual([result['MID'] for result in results], ['MID123'])
        self.assertNotIn('Reason', results[0])

    def test_converted_records_are_hidden_from_inactive_lists_and_lookups(self):
        converted = {**self.row, 'Status': config.STATUS_INACTIVE_CONVERTED, 'Reason': ''}
        with patch.object(
            inactive,
            'query_workflow_page_',
            return_value={
                'total': 0,
                'page': 1,
                'pageSize': 25,
                'rows': [],
            },
        ) as query:
            result = inactive.list_inactive_(self.user, completed=True)

        self.assertEqual(query.call_args.kwargs['exclude_status'], config.STATUS_INACTIVE_CONVERTED)
        self.assertEqual(result['total'], 0)
        with patch.object(inactive, '_find_row_', return_value=converted):
            with self.assertRaises(ApiError) as raised:
                inactive._find_any_('MID123', 'completed')
        self.assertEqual(raised.exception.code, 'STUDENT_NOT_FOUND')

    def test_conversion_requires_exact_mid_confirmation(self):
        with self.assertRaises(ApiError) as raised:
            inactive.convert_inactive_to_discontinue_(
                self.user, 'MID123', 'MID12', self.fields, [], ''
            )

        self.assertEqual(raised.exception.code, 'MID_CONFIRMATION_MISMATCH')

    def test_conversion_rejects_another_branch(self):
        other_branch_row = {**self.row, 'Branch': 'OTHER'}
        with patch.object(inactive, '_find_row_', return_value=other_branch_row):
            with self.assertRaises(ApiError) as raised:
                inactive.convert_inactive_to_discontinue_(
                    self.user, 'MID123', 'MID123', self.fields, [], ''
                )

        self.assertEqual(raised.exception.code, 'AUTH_FORBIDDEN')

    def test_conversion_requires_valid_student_and_parent_phone_numbers(self):
        invalid_fields = {**self.fields, 'phone2': '123'}
        with self.assertRaises(ApiError) as raised:
            inactive.convert_inactive_to_discontinue_(
                self.user, 'MID123', 'MID123', invalid_fields, [], ''
            )

        self.assertEqual(raised.exception.code, 'BAD_REQUEST')

    def test_conversion_clears_inactive_reason_and_starts_normal_workflow(self):
        def read_rows(sheet_name):
            if sheet_name == config.SHEET_INACTIVE_COMPLETED:
                return [self.row]
            return []

        with (
            patch.object(inactive, 'read_sheet_as_objects_', side_effect=read_rows),
            patch.object(inactive, 'mid_exists_anywhere_', return_value=False),
            patch.object(inactive, 'now_iso_', return_value='2026-11-05T12:00:00'),
            patch.object(inactive, 'convert_inactive_row_to_discontinue_', return_value=True) as persist,
            patch.object(inactive, 'log_audit_'),
            patch.object(inactive, 'invalidate_cache_'),
            patch('students._upload_reason_screenshots_', return_value=['scm-image-key']),
        ):
            result = inactive.convert_inactive_to_discontinue_(
                self.user, 'MID123', 'MID123', self.fields, [], 'test browser'
            )

        self.assertEqual(result, {'success': True})
        _, inactive_updates, discontinue_row = persist.call_args.args
        self.assertEqual(inactive_updates['Status'], config.STATUS_INACTIVE_CONVERTED)
        self.assertEqual(inactive_updates['MID'], '')
        self.assertEqual(inactive_updates['Reason'], '')
        self.assertEqual(discontinue_row['Status'], config.STATUS_PENDING_HOF_MANAGER)
        self.assertEqual(discontinue_row['Inactive From'], '2026-01-02')
        self.assertEqual(discontinue_row['Inactive To'], '2026-01-10T09:30:00')
        self.assertEqual(discontinue_row['Discontinue Converted Date'], '2026-11-05T12:00:00')
        self.assertEqual(discontinue_row['Reason (SCM)'], 'New discontinue reason')
        self.assertEqual(discontinue_row['Student Name'], 'Edited Student')
        self.assertEqual(discontinue_row['Batch Name'], 'Batch B')
        self.assertEqual(discontinue_row['Faculty Name'], 'Faculty B')
        self.assertEqual(discontinue_row['Phone Number 2'], '0987654321')
        self.assertEqual(discontinue_row['Total Billed'], 2500)
        self.assertEqual(discontinue_row['Total Paid'], 1250)
        self.assertEqual(discontinue_row['Arrear'], 1250)
        self.assertEqual(discontinue_row['Last Present Day'], '2026-02-03')
        self.assertEqual(discontinue_row[config.SCREENSHOT_FIELD_SCM], ['scm-image-key'])
        self.assertEqual(discontinue_row['Reason (HOF)'], '')
        self.assertEqual(discontinue_row['Reason (Manager)'], '')

    def test_existing_conversions_include_dates_from_the_inactive_record(self):
        student_rows = [{'MID': 'MID123'}]
        converted_inactive_row = {
            'Status': config.STATUS_INACTIVE_CONVERTED,
            'Last Present Day': '2026-01-02',
            'Approval Date': '2026-01-10T09:30:00',
            'Converted Date': '2026-11-05T12:00:00',
            'Converted To Discontinue MID': 'MID123',
        }
        with patch.object(
            students,
            'fetch_all_',
            return_value=[{'data': converted_inactive_row}],
        ):
            result = students._attach_inactive_conversion_dates_(student_rows)

        self.assertEqual(result[0]['Inactive From'], '2026-01-02')
        self.assertEqual(result[0]['Inactive To'], '2026-01-10T09:30:00')
        self.assertEqual(
            result[0]['Discontinue Converted Date'],
            '2026-11-05T12:00:00',
        )
        self.assertNotIn('Inactive From', student_rows[0])


if __name__ == '__main__':
    unittest.main()
