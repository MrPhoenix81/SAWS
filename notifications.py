"""
notifications.py
Purely in-app notifications - no email/SMS is sent from here (the
only outbound email in the whole system is the password-reset link,
handled in auth.py). Direct port of Notifications.gs.

Also owns the per-user/per-page "seen" tracking used for the sidebar
badge (see get_unseen_count_for_page_/mark_page_seen_): the badge is
intentionally decoupled from the "action needed" (pendingForMe) count
computed in students.py/inactive.py/transfer.py - it should disappear
as soon as the user opens the page (whether or not they act), and
only reappear once a *new* notification lands for them on that page.
"""
import uuid

import config
from db_utils import read_sheet_as_objects_, append_row_, update_row_fields_, now_iso_, get_setting_, set_setting_
from auth import ApiError


def create_notification_(to_email, message, notif_type, related_mid=None, page=None):
    append_row_(config.SHEET_NOTIFICATIONS, {
        'ID': str(uuid.uuid4()),
        'ToEmail': to_email,
        'Message': message,
        'Type': notif_type,
        'Related MID': related_mid or '',
        'Read': False,
        'Created Date': now_iso_(),
        'Page': page or '',
    })


def notify_branch_roles_(branch, roles, message, notif_type, related_mid=None, page=None):
    """
    Notify every user who holds one of the given roles: for a
    globally-visible role (Admin, Head Office) every user with that
    role is notified regardless of branch; for every other role only
    users in `branch` are notified.
    """
    users = read_sheet_as_objects_(config.SHEET_USERS)
    for u in users:
        if u.get('Role') in roles and (
            u.get('Role') in config.GLOBAL_VISIBILITY_ROLES or u.get('Branch') == branch
        ):
            create_notification_(u['Email'], message, notif_type, related_mid, page)


def get_notifications_for_user_(email):
    """Returns notifications for the logged-in user, most recent first."""
    rows = read_sheet_as_objects_(config.SHEET_NOTIFICATIONS)
    matches = [r for r in rows if str(r.get('ToEmail', '')).lower() == email.lower()]
    matches.sort(key=lambda r: str(r.get('Created Date') or ''), reverse=True)
    return [
        {
            'id': r.get('ID'),
            'message': r.get('Message'),
            'type': r.get('Type'),
            'relatedMid': r.get('Related MID'),
            'read': r.get('Read') in (True, 'TRUE', 'true'),
            'createdDate': r.get('Created Date'),
            'page': r.get('Page') or '',
            '__row': r['__row'],
        }
        for r in matches
    ]


def mark_notification_read_(notification_id):
    rows = read_sheet_as_objects_(config.SHEET_NOTIFICATIONS)
    match = next((r for r in rows if r.get('ID') == notification_id), None)
    if not match:
        raise ApiError('NOTIFICATION_NOT_FOUND')
    update_row_fields_(config.SHEET_NOTIFICATIONS, match['__row'], {'Read': True})


def mark_all_notifications_read_(email):
    rows = read_sheet_as_objects_(config.SHEET_NOTIFICATIONS)
    for r in rows:
        if str(r.get('ToEmail', '')).lower() == email.lower() and r.get('Read') not in (True, 'TRUE', 'true'):
            update_row_fields_(config.SHEET_NOTIFICATIONS, r['__row'], {'Read': True})


# ---------------------------------------------------------------
# Per-user / per-page "last seen" tracking for the sidebar badges.
# Backed by the generic Settings key/value store - no schema change
# needed. Key shape: "pageSeen:<email>:<page>" -> ISO timestamp.
# ---------------------------------------------------------------

def _seen_key_(email, page):
    return f"pageSeen:{str(email or '').lower()}:{page}"


def mark_page_seen_(email, page):
    """Called when the user opens a given sidebar page (Discontinue /
    Transfer / Inactive). Any notification created for them on that
    page BEFORE this moment stops counting toward the red badge."""
    if not page:
        raise ApiError('BAD_REQUEST')
    set_setting_(_seen_key_(email, page), now_iso_())
    return {'success': True}


def get_unseen_count_for_page_(email, page):
    """How many of this user's notifications on `page` were created
    after their last visit to that page. This is intentionally
    independent of the notification's Read/unread flag (which drives
    the bell dropdown) and independent of whether the underlying
    workflow row still needs this user's action - it only tracks
    "have they opened the page since this notification arrived"."""
    last_seen = get_setting_(_seen_key_(email, page))
    rows = read_sheet_as_objects_(config.SHEET_NOTIFICATIONS)
    count = 0
    for r in rows:
        if str(r.get('ToEmail', '')).lower() != str(email or '').lower():
            continue
        if (r.get('Page') or '') != page:
            continue
        created = str(r.get('Created Date') or '')
        if not last_seen or created > last_seen:
            count += 1
    return count


def get_unseen_counts_(email):
    return {
        'discontinue': get_unseen_count_for_page_(email, config.PAGE_DISCONTINUE),
        'transfer': get_unseen_count_for_page_(email, config.PAGE_TRANSFER),
        'inactive': get_unseen_count_for_page_(email, config.PAGE_INACTIVE),
    }