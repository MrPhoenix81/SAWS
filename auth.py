"""
auth.py
Email + password authentication. Direct port of Auth.gs.

Password hashing (SHA-256 hex) and the session-token format
(base64url(json payload) + '.' + hex HMAC-SHA256 signature) are
kept byte-for-byte identical to the original, so a Users sheet
migrated straight over from the Apps Script version keeps working
without anyone needing to reset their password, and any old tokens
your frontend already understands still validate the same way.
"""
import base64
import hashlib
import hmac as hmac_lib
import json
import smtplib
import time
import uuid
from email.mime.text import MIMEText

import config
from db_utils import (
    read_sheet_as_objects_, append_row_, update_row_fields_,
    now_iso_, format_datetime_, get_setting_, set_setting_,
)
from audit_log import log_audit_


class ApiError(Exception):
    """Raised with a known error `code` the router translates to a response."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------

def hash_password_(plain_password):
    return hashlib.sha256(str(plain_password).encode('utf-8')).hexdigest()


def _hmac_hex(input_str, secret):
    return hmac_lib.new(str(secret).encode('utf-8'), input_str.encode('utf-8'), hashlib.sha256).hexdigest()


def _b64url_encode(s):
    return base64.urlsafe_b64encode(s.encode('utf-8')).rstrip(b'=').decode('ascii')


def _b64url_decode(s):
    padded = s + '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8')


# ---------------------------------------------------------------
# Settings (key/value store; see get_setting_/set_setting_ in db_utils.py)
# ---------------------------------------------------------------

# ---------------------------------------------------------------
# User lookup
# ---------------------------------------------------------------

def find_user_record_by_email_(email):
    """Internal use only - includes the password hash. Never expose outside auth.py."""
    if not email:
        return None
    users = read_sheet_as_objects_(config.SHEET_USERS)
    for u in users:
        if str(u.get('Email', '')).lower() == str(email).lower():
            return u
    return None


def find_user_by_email_(email):
    """Public-facing user lookup (no password hash included)."""
    match = find_user_record_by_email_(email)
    if not match:
        return None
    return {
        'email': match['Email'],
        'name': match['Name'],
        'branch': match['Branch'],
        'role': match['Role'],
    }


# ---------------------------------------------------------------
# Session tokens
# ---------------------------------------------------------------

def create_session_token_(email):
    secret = get_setting_('SESSION_SECRET')
    if not secret:
        raise ApiError('SERVER_ERROR')
    payload = json.dumps({
        'email': email,
        'exp': int(time.time() * 1000) + config.SESSION_TIMEOUT_MINUTES * 60 * 1000,
    })
    payload_b64 = _b64url_encode(payload)
    signature = _hmac_hex(payload_b64, secret)
    return payload_b64 + '.' + signature


def verify_session_token_(token):
    if not token or not isinstance(token, str):
        return None
    if '.' not in token:
        return None
    payload_b64, signature = token.split('.', 1)

    secret = get_setting_('SESSION_SECRET')
    if not secret:
        return None

    expected_signature = _hmac_hex(payload_b64, secret)
    if not hmac_lib.compare_digest(expected_signature, signature):
        return None  # tampered or wrong secret

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None

    if not payload.get('exp') or time.time() * 1000 > float(payload['exp']):
        return None  # expired
    if not payload.get('email'):
        return None
    return payload['email']


# ---------------------------------------------------------------
# Login / logout / change password
# ---------------------------------------------------------------

def login_with_password_(payload):
    email = str(payload.get('email') or '').strip().lower()
    password = str(payload.get('password') or '')
    if not email or not password:
        raise ApiError('AUTH_INVALID_CREDENTIALS')

    record = find_user_record_by_email_(email)
    if not record or not record.get('Password'):
        raise ApiError('AUTH_INVALID_CREDENTIALS')

    if hash_password_(password) != record['Password']:
        raise ApiError('AUTH_INVALID_CREDENTIALS')

    user = {
        'email': record['Email'],
        'name': record['Name'],
        'branch': record['Branch'],
        'role': record['Role'],
    }
    return {'token': create_session_token_(user['email']), 'user': user}


def change_password_(user, payload):
    current_password = str(payload.get('currentPassword') or '')
    new_password = str(payload.get('newPassword') or '')

    if not current_password or not new_password:
        raise ApiError('BAD_REQUEST')
    if len(new_password) < 6:
        raise ApiError('PASSWORD_TOO_SHORT')

    record = find_user_record_by_email_(user['email'])
    if not record:
        raise ApiError('BAD_REQUEST')

    if hash_password_(current_password) != record['Password']:
        raise ApiError('AUTH_INVALID_CREDENTIALS')

    update_row_fields_(config.SHEET_USERS, record['__row'], {'Password': hash_password_(new_password)})
    log_audit_(user['email'], 'UPDATE', 'Changed own password', user['branch'], payload.get('browser'))
    return {'success': True}


def authenticate_(token):
    """
    Main entry point every protected API handler calls first.
    Raises ApiError with a descriptive code on failure.
    """
    email = verify_session_token_(token)
    if not email:
        raise ApiError('AUTH_INVALID_TOKEN')
    user = find_user_by_email_(email)
    if not user:
        raise ApiError('AUTH_NOT_REGISTERED')
    return user


def require_role_(user, allowed_roles):
    if user['role'] not in allowed_roles:
        raise ApiError('AUTH_FORBIDDEN')


# ---------------------------------------------------------------
# Forgot password (self-service, emailed link)
# ---------------------------------------------------------------

def request_password_reset_(payload):
    """
    Always returns {success: True} regardless of whether the email is
    registered, so the endpoint can't be used to discover which
    emails exist. If registered, a reset link is emailed via SMTP
    (see send_password_reset_email_ below).
    """
    email = str(payload.get('email') or '').strip().lower()
    if email:
        record = find_user_record_by_email_(email)
        if record:
            token = uuid.uuid4().hex + uuid.uuid4().hex
            now = time.time()
            expires = now + config.RESET_TOKEN_EXPIRY_MINUTES * 60

            append_row_(config.SHEET_PASSWORD_RESETS, {
                'Token': token,
                'Email': record['Email'],
                'Created Date': now_iso_(),
                'Expires At': format_datetime_(__import__('datetime').datetime.fromtimestamp(expires)),
                'Used': False,
            })

            send_password_reset_email_(record['Email'], record['Name'], token)
            log_audit_(record['Email'], 'PASSWORD_RESET_REQUESTED', 'Reset link emailed',
                       record['Branch'], payload.get('browser'))
    return {'success': True}


def send_password_reset_email_(email, name, token):
    base_url = get_setting_('APP_BASE_URL') or config.DEFAULT_APP_BASE_URL
    reset_link = str(base_url).rstrip('/') + '/reset-password?token=' + token

    subject = 'Reset your Student Discontinuation Management System password'
    body = (
        f"Hi {name or ''},\n\n"
        "We received a request to reset your password. This link is valid for "
        f"{config.RESET_TOKEN_EXPIRY_MINUTES} minutes:\n\n"
        f"{reset_link}\n\n"
        "If you did not request this, you can safely ignore this email - your password will not change.\n\n"
        "- Student Discontinuation Management System"
    )

    if not config.SMTP_HOST:
        # No SMTP configured - log instead of failing the request, so
        # the endpoint keeps its "always success" behavior. Configure
        # SMTP_HOST/SMTP_USER/SMTP_PASSWORD in your environment to
        # actually deliver these emails.
        print(f"[auth] SMTP not configured - would have emailed {email}: {reset_link}")
        return

    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = config.SMTP_FROM or config.SMTP_USER
    msg['To'] = email

    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT) as server:
        server.starttls()
        if config.SMTP_USER:
            server.login(config.SMTP_USER, config.SMTP_PASSWORD)
        server.sendmail(msg['From'], [email], msg.as_string())


def reset_password_with_token_(payload):
    token = str(payload.get('token') or '')
    new_password = str(payload.get('newPassword') or '')

    if not token:
        raise ApiError('AUTH_INVALID_RESET_TOKEN')
    if not new_password or len(new_password) < 6:
        raise ApiError('PASSWORD_TOO_SHORT')

    resets = read_sheet_as_objects_(config.SHEET_PASSWORD_RESETS)
    match = next((r for r in resets if r.get('Token') == token), None)
    if not match:
        raise ApiError('AUTH_INVALID_RESET_TOKEN')
    if match.get('Used') in (True, 'TRUE', 'true'):
        raise ApiError('AUTH_INVALID_RESET_TOKEN')

    import datetime as _dt
    try:
        expires_at = _dt.datetime.fromisoformat(str(match.get('Expires At')))
    except Exception:
        raise ApiError('AUTH_INVALID_RESET_TOKEN')
    if expires_at < _dt.datetime.now():
        raise ApiError('AUTH_INVALID_RESET_TOKEN')

    user_record = find_user_record_by_email_(match['Email'])
    if not user_record:
        raise ApiError('AUTH_INVALID_RESET_TOKEN')

    update_row_fields_(config.SHEET_USERS, user_record['__row'], {'Password': hash_password_(new_password)})
    update_row_fields_(config.SHEET_PASSWORD_RESETS, match['__row'], {'Used': True})

    log_audit_(match['Email'], 'PASSWORD_RESET', 'Password reset via emailed link',
               user_record['Branch'], payload.get('browser'))
    return {'success': True}
