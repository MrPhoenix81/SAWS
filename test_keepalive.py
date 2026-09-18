"""
test_keepalive.py
Manual, one-off check that the Supabase keepalive fetch actually
works - run this directly instead of waiting for the real 2/4/6...
AM/PM IST schedule.

Usage (from the app/ folder, with your virtualenv active):
    python test_keepalive.py

Unlike storage.keepalive_touch_() (which swallows its own errors so
a transient hiccup never crashes the /health route), this script
does NOT swallow errors - so a real failure will show you the actual
exception instead of hiding it.
"""
import time

from storage import _client, BUCKET, KEEPALIVE_KEY


def main():
    print(f'Fetching {KEEPALIVE_KEY!r} from bucket {BUCKET!r} ...')
    started = time.monotonic()
    try:
        obj = _client.get_object(Bucket=BUCKET, Key=KEEPALIVE_KEY)
        data = obj['Body'].read()
    except Exception as exc:
        elapsed = time.monotonic() - started
        print(f'FAILED after {elapsed:.2f}s: {exc}')
        raise
    else:
        elapsed = time.monotonic() - started
        print(f'Fetch complete: {len(data)} bytes in {elapsed:.2f}s. Keepalive is working.')


if __name__ == '__main__':
    main()
    