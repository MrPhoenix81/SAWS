"""
storage.py
Wraps Supabase Storage's S3-compatible API for the call-log screenshot
feature: upload, short-lived signed-URL generation, delete, and the
keep-alive heartbeat that stops the free Supabase project from being
auto-paused after 7 days of inactivity.
"""
import os
import time
import uuid
import boto3
from botocore.client import Config
from botocore.exceptions import EndpointConnectionError, ConnectTimeoutError

from auth import ApiError

# How many attempts to make (1 initial + retries) and how long to wait
# between them for transient network/DNS failures talking to Supabase.
UPLOAD_RETRY_ATTEMPTS = 3
UPLOAD_RETRY_DELAY_SECONDS = 1.5

_client = boto3.client(
    's3',
    endpoint_url=f"{os.environ['SUPABASE_URL']}/storage/v1/s3",
    aws_access_key_id=os.environ['SUPABASE_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['SUPABASE_SECRET_ACCESS_KEY'],
    config=Config(signature_version='s3v4'),
    region_name=os.environ.get('SUPABASE_REGION', 'us-east-1'),
)
BUCKET = 'call-log-screenshots'
KEEPALIVE_KEY = 'system/keepalive-logo.png'


def upload_screenshot_(file_bytes, content_type, mid, role):
    key = f"{mid}/{role}-{uuid.uuid4().hex}.jpg"
    last_err = None
    for attempt in range(1, UPLOAD_RETRY_ATTEMPTS + 1):
        try:
            _client.put_object(Bucket=BUCKET, Key=key, Body=file_bytes, ContentType=content_type)
            return key
        except (EndpointConnectionError, ConnectTimeoutError) as err:
            # Transient DNS/network blip talking to Supabase - worth a
            # couple of quick retries before giving up, rather than
            # failing the whole submission on a one-off hiccup.
            last_err = err
            if attempt < UPLOAD_RETRY_ATTEMPTS:
                time.sleep(UPLOAD_RETRY_DELAY_SECONDS)
    # All retries exhausted - surface a clean, non-technical message
    # instead of the raw boto3/endpoint-URL error (which becomes the
    # literal `message` shown to the user via api.py's SERVER_ERROR path).
    raise ApiError('SCREENSHOT_UPLOAD_FAILED') from last_err


def upload_screenshots_(files, mid, role):
    """
    Bulk version of upload_screenshot_ for the multi-image SCM upload
    feature. `files` is a list of (file_bytes, content_type) tuples,
    already validated by the caller. Returns the list of storage keys
    in the same order.
    """
    return [upload_screenshot_(file_bytes, content_type, mid, role) for file_bytes, content_type in files]


def get_signed_url_(key, expires_seconds=300):
    return _client.generate_presigned_url(
        'get_object', Params={'Bucket': BUCKET, 'Key': key}, ExpiresIn=expires_seconds)


def get_signed_urls_(keys, expires_seconds=300):
    return [get_signed_url_(key, expires_seconds) for key in keys]


def delete_screenshot_(key):
    _client.delete_object(Bucket=BUCKET, Key=key)


def delete_screenshots_(keys):
    for key in keys:
        try:
            delete_screenshot_(key)
        except Exception:
            pass


def keepalive_touch_():
    """
    Fetches the permanent logo anchor file and discards the bytes -
    purely an activity signal for Supabase Storage, never exposed
    anywhere. This project's real database is Neon (see DATABASE_URL
    in config.py) - Supabase is used ONLY for screenshot storage here,
    so there is intentionally no Postgres fallback against Supabase
    itself. If this fetch fails, the exception is swallowed so a
    transient Storage hiccup never crashes the /health route that
    UptimeRobot depends on.
    """
    try:
        obj = _client.get_object(Bucket=BUCKET, Key=KEEPALIVE_KEY)
        obj['Body'].read()
    except Exception:
        pass