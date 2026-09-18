"""
setup_script.py
Run this ONCE, after you've created your Neon database and set
DATABASE_URL (see README.md), to create the tables the app needs and
seed the default branch list. Then run the create-admin command to
create your very first login.

Commands:
    python setup_script.py init                       # create tables + seed branches
    python setup_script.py create-admin EMAIL "Name"   # create the first Admin user
"""
import sys
import uuid

import config
from db import check_connection_
from db_utils import ensure_sheets_exist_, read_sheet_as_objects_, append_row_, get_setting_, set_setting_
from auth import hash_password_, find_user_record_by_email_
from users import generate_password_


def run_initial_setup():
    print('Checking database connection...')
    check_connection_()
    print('Connected. Creating tables if needed...')
    ensure_sheets_exist_()
    seed_branches_if_empty_()

    if not get_setting_('SESSION_SECRET'):
        set_setting_('SESSION_SECRET', uuid.uuid4().hex + uuid.uuid4().hex)
        print('Generated a new SESSION_SECRET.')

    if not get_setting_('APP_BASE_URL'):
        set_setting_('APP_BASE_URL', config.DEFAULT_APP_BASE_URL)

    print('Setup complete. Your database is ready.')
    print('Next: python setup_script.py create-admin you@example.com "Your Name"')


def seed_branches_if_empty_():
    existing = read_sheet_as_objects_(config.SHEET_BRANCHES)
    if existing:
        return  # already has data, don't overwrite

    branches = [
        'MANJERI', 'KASARGOD', 'KANNUR', 'KUTTYADI', 'KOZHIKODE', 'TIRUR',
        'PALAKKAD', 'THRISSUR', 'ERANAKULAM', 'ALAPPUZHA', 'KOTTAYAM',
        'KOLLAM', 'TRIVANDRUM', 'MARTHANDAM', 'NAGPUR', 'HYDERABAD', 'BANGALORE',
    ]
    for b in branches:
        append_row_(config.SHEET_BRANCHES, {'Branch Name': b, 'Active': True})
    print(f'Seeded {len(branches)} branches.')


def create_first_admin_(email, name):
    """
    Bootstraps the very first Admin account. Every later user
    (including more Admins) should be created through the app's User
    Management screen - this is only here to break the
    chicken-and-egg problem of "you need an Admin to create users,
    but there are no users yet".
    """
    role = config.ROLE_ADMIN
    branch = 'HEAD OFFICE'

    ensure_sheets_exist_()
    if not get_setting_('SESSION_SECRET'):
        set_setting_('SESSION_SECRET', uuid.uuid4().hex + uuid.uuid4().hex)

    if find_user_record_by_email_(email):
        print('A user with that email already exists - nothing to do.')
        return

    generated_password = generate_password_(role, branch)
    append_row_(config.SHEET_USERS, {
        'Email': email.lower(),
        'Name': name,
        'Branch': branch,
        'Role': role,
        'Password': hash_password_(generated_password),
    })

    print(f'Admin created. Email: {email}  Password: {generated_password}')
    print('Share these with the Admin and have them sign in, then change the password.')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'init':
        run_initial_setup()
    elif cmd == 'create-admin':
        if len(sys.argv) < 4:
            print('Usage: python setup_script.py create-admin EMAIL "Full Name"')
            sys.exit(1)
        create_first_admin_(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(1)
