"""
scheduler.py
Optional: runs the Google Sheets backup once every 24 hours from
inside the running web app, so you don't have to set up a separate
Render Cron Job to get started. Started from app.py.

NOTE ON RELIABILITY: a free/starter Render web service can spin down
when idle and only wakes up on the next incoming request. If that
happens right at backup time, this in-process scheduler simply won't
run that day - it only runs while the app is awake. For a backup you
can really rely on, use a Render Cron Job instead (see README.md) and
leave START_INPROCESS_BACKUP_SCHEDULER unset/false. Both can safely
run at once if you want belt-and-suspenders.
"""
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import config


def _seconds_until_next_run_(hour_utc):
    now = datetime.now(timezone.utc)
    target = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
    if target <= now:
        target = target.replace(day=target.day) + __import__('datetime').timedelta(days=1)
    return (target - now).total_seconds()


def _seconds_until_next_clock_slot_(anchor_hour, interval_hours, tz_name):
    """
    Seconds to sleep until the next clock-aligned slot in `tz_name`
    (IST by default), starting at `anchor_hour` and repeating every
    `interval_hours` after that - e.g. anchor=2, interval=2 gives
    slots at 2:00, 4:00, 6:00 ... 24:00 IST, every day. Unlike a plain
    time.sleep(N), this is anchored to the real clock, so it doesn't
    drift based on when the process happened to start/restart.
    """
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = timezone.utc  # fallback if zoneinfo data is unavailable

    now = datetime.now(tz)
    slot = now.replace(hour=anchor_hour, minute=0, second=0, microsecond=0)
    if slot <= now:
        elapsed_intervals = int((now - slot).total_seconds() // 3600 // interval_hours) + 1
        slot = slot + timedelta(hours=interval_hours * elapsed_intervals)
    return (slot - now).total_seconds()


def _run_loop_():
    from backup_to_sheets import run_backup_

    while True:
        sleep_seconds = _seconds_until_next_run_(config.BACKUP_HOUR_UTC)
        time.sleep(max(sleep_seconds, 60))
        try:
            print('Running scheduled daily backup...')
            run_backup_()
        except Exception as exc:  # noqa: BLE001
            # Never let a backup failure crash the web process.
            print(f'Scheduled backup failed: {exc}')


def start_if_enabled_():
    """
    Item 5 requires the daily Google Sheet backup to "run automatically
    every day at 1:00 AM" without any extra setup step, so this now
    defaults to ON whenever BACKUP_SPREADSHEET_ID is configured - set
    START_INPROCESS_BACKUP_SCHEDULER=false explicitly if you'd rather
    rely solely on an external Render Cron Job (see README.md; both
    can safely run at once if you want belt-and-suspenders).
    """
    flag = os.environ.get('START_INPROCESS_BACKUP_SCHEDULER', '').lower()
    if flag in ('0', 'false', 'no'):
        print('START_INPROCESS_BACKUP_SCHEDULER is explicitly disabled - skipping in-process backup scheduler.')
        return
    if not config.BACKUP_SPREADSHEET_ID:
        print('BACKUP_SPREADSHEET_ID is not set - skipping in-process backup scheduler.')
        return
    thread = threading.Thread(target=_run_loop_, daemon=True)
    thread.start()
    print(f'In-process backup scheduler started (runs daily at {config.BACKUP_HOUR_UTC}:00 UTC, '
          f'= {config.BACKUP_LOCAL_HOUR}:00 {config.BACKUP_TIMEZONE}).')


def _run_supabase_keepalive_loop_():
    """
    Independently keeps the Supabase project active by fetching the
    permanent system/keepalive-logo.png anchor file every
    KEEPALIVE_INTERVAL_HOURS, clock-aligned to KEEPALIVE_ANCHOR_HOUR_IST
    in SCHEDULER_TIMEZONE (defaults: every 2 hours starting 2:00 AM
    IST -> 2,4,6...24) - no dependency on UptimeRobot or any other
    external pinger. Just a read: nothing is uploaded, nothing is
    deleted, the file itself is untouched. The fetch alone counts as
    real API activity against the project, which is what prevents the
    free-tier auto-pause.

    Runs for as long as this web process is up - same caveat as every
    other in-process loop here: if the process itself is fully
    stopped, nothing is running to fire this, but as long as the
    process is alive, this pulse happens on its own schedule.
    """
    from storage import keepalive_touch_

    while True:
        sleep_seconds = _seconds_until_next_clock_slot_(
            config.KEEPALIVE_ANCHOR_HOUR_IST, config.KEEPALIVE_INTERVAL_HOURS, config.SCHEDULER_TIMEZONE)
        time.sleep(max(sleep_seconds, 60))
        try:
            keepalive_touch_()
            print('Supabase keepalive pulse OK.')
        except Exception as exc:  # noqa: BLE001
            print(f'Supabase keepalive pulse failed: {exc}')


def start_supabase_keepalive_():
    thread = threading.Thread(target=_run_supabase_keepalive_loop_, daemon=True)
    thread.start()
    print(f'Supabase keepalive scheduler started (fetches system/keepalive-logo.png every '
          f'{config.KEEPALIVE_INTERVAL_HOURS}h, clock-aligned from {config.KEEPALIVE_ANCHOR_HOUR_IST}:00 '
          f'{config.SCHEDULER_TIMEZONE}, independent of external pings).')


def _run_screenshot_cleanup_loop_():
    from datetime import timedelta
    from db_utils import read_sheet_as_objects_, update_row_fields_, screenshot_keys_
    from storage import delete_screenshots_

    # (sheet, [screenshot fields to clear on that sheet]) - the
    # discontinuation Completed sheet has three per-role fields; the
    # Transfer/Inactive Completed sheets each have a single optional
    # supporting-image field.
    sheet_fields = [
        (config.SHEET_COMPLETED,
         [config.SCREENSHOT_FIELD_SCM, config.SCREENSHOT_FIELD_HOF, config.SCREENSHOT_FIELD_MANAGER]),
        (config.SHEET_TRANSFER_COMPLETED, [config.SCREENSHOT_FIELD_TRANSFER]),
        (config.SHEET_INACTIVE_COMPLETED, [config.SCREENSHOT_FIELD_INACTIVE]),
    ]
    while True:
        sleep_seconds = _seconds_until_next_clock_slot_(
            config.CLEANUP_ANCHOR_HOUR_IST, config.CLEANUP_INTERVAL_HOURS, config.SCHEDULER_TIMEZONE)
        time.sleep(max(sleep_seconds, 60))
        try:
            cutoff = datetime.now() - timedelta(hours=config.SCREENSHOT_RETENTION_HOURS)
            for sheet_name, fields in sheet_fields:
                rows = read_sheet_as_objects_(sheet_name)
                print(f'Fetch complete: {sheet_name} ({len(rows)} row(s)).')
                for row in rows:
                    approval_date = row.get('Approval Date')
                    if not approval_date:
                        continue
                    try:
                        approved_at = datetime.fromisoformat(str(approval_date)[:19])
                    except Exception:
                        continue
                    if approved_at > cutoff:
                        continue
                    to_clear = {}
                    for field in fields:
                        keys = screenshot_keys_(row.get(field))
                        if keys:
                            try:
                                delete_screenshots_(keys)
                            except Exception as exc:
                                print(f'Failed to delete screenshot(s) {keys}: {exc}')
                            to_clear[field] = ''
                    if to_clear:
                        update_row_fields_(sheet_name, row['__row'], to_clear)
        except Exception as exc:
            print(f'Screenshot cleanup sweep failed: {exc}')


def start_screenshot_cleanup_():
    thread = threading.Thread(target=_run_screenshot_cleanup_loop_, daemon=True)
    thread.start()
    print(f'Screenshot cleanup scheduler started (runs every {config.CLEANUP_INTERVAL_HOURS}h, clock-aligned '
          f'from {config.CLEANUP_ANCHOR_HOUR_IST}:00 {config.SCHEDULER_TIMEZONE}; retention: '
          f'{config.SCREENSHOT_RETENTION_HOURS}h after Admin approval).')