"""
db.py
Owns the single connection pool to the Postgres (Neon) database.
Every other module goes through get_conn_()/put_conn_() (or, more
commonly, through db_utils.py) rather than opening its own
connections.

Reads DATABASE_URL from the environment. Get this value from your
Neon project (Dashboard -> Connection Details -> "Connection
string"). It looks like:

    postgresql://USER:PASSWORD@ep-something.neon.tech/dbname?sslmode=require

Set it as an environment variable named DATABASE_URL, either in a
local .env file (for your own machine) or in Render -> Environment
(for the deployed app). See README.md for the full walkthrough.
"""
import os
import time
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pg_pool

_DATABASE_URL = os.environ.get('DATABASE_URL', '')

_pool = None


def _build_dsn():
    if not _DATABASE_URL:
        raise RuntimeError(
            'DATABASE_URL environment variable is not set. Copy your Neon '
            'connection string into DATABASE_URL (see README.md).'
        )
    dsn = _DATABASE_URL
    # Neon requires TLS. If the person copied the connection string without
    # ?sslmode=require, add it automatically so this doesn't silently fail.
    if 'sslmode=' not in dsn:
        dsn += ('&' if '?' in dsn else '?') + 'sslmode=require'
    return dsn


def _get_pool():
    global _pool
    if _pool is None:
        # Small pool: Render's free/starter web services and Neon's free
        # tier both have modest connection limits. minconn=1 keeps this
        # cheap when idle; maxconn=10 comfortably covers waitress's
        # --threads=8 (see Dockerfile) plus the daily backup job.
        _pool = pg_pool.ThreadedConnectionPool(1, 10, dsn=_build_dsn())
    return _pool


def _checked_out_conn_(pool):
    """Get a connection from the pool and make sure it's actually alive
    before handing it back.

    Neon (and the pooler/proxy in front of it) can drop an individual
    idle connection - or suspend the whole compute endpoint - while it
    sits unused in our pool (e.g. between hourly cleanup-sweep runs).
    psycopg2's pool has no idea this happened, so it will happily hand
    out a connection object that looks fine locally but immediately
    fails with "connection already closed" on first use. A cheap
    'SELECT 1' here catches that up front instead of letting it blow
    up deep inside whatever query the caller was about to run.

    A dead connection is discarded (closed=True) rather than returned
    to the pool, so the pool replaces it with a fresh one instead of
    handing the same broken connection to the next caller too.

    This also covers the case where pool.getconn() itself fails while
    opening a brand-new physical connection - e.g. a transient local
    DNS resolution blip ("could not translate host name ..."). That's
    a different failure point than a stale pooled connection (it
    happens before we ever get a connection object to test), so it
    needs its own short retry-with-backoff rather than being missed
    entirely.
    """
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            conn = pool.getconn()
        except psycopg2.OperationalError:
            # Couldn't even open a new connection (e.g. DNS blip).
            # Give the network a moment and try again rather than
            # failing a live user request over something that
            # typically clears up in a second or two.
            if attempt == max_attempts:
                raise
            time.sleep(1.5)
            continue

        if conn.closed:
            pool.putconn(conn, close=True)
            continue
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
        except Exception:
            pool.putconn(conn, close=True)
            if attempt == max_attempts:
                raise
            continue
        else:
            return conn
    # Should be unreachable, but keeps the type checker (and us) honest.
    raise psycopg2.OperationalError('Could not obtain a live database connection.')


@contextmanager
def get_conn_():
    """Context manager yielding a pooled connection. Commits on success,
    rolls back on exception, always returns the connection to the pool
    (or discards it, if it turned out to be broken)."""
    pool = _get_pool()
    conn = _checked_out_conn_(pool)
    broken = False
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            # The connection died mid-transaction (e.g. Neon dropped it
            # under us). Nothing to roll back on a dead connection -
            # just make sure we don't hand this one out again.
            broken = True
        raise
    finally:
        pool.putconn(conn, close=broken)


@contextmanager
def get_cursor_(dict_cursor=True):
    """Context manager yielding a cursor (dict-like rows by default)."""
    with get_conn_() as conn:
        cursor_factory = psycopg2.extras.RealDictCursor if dict_cursor else None
        cur = conn.cursor(cursor_factory=cursor_factory)
        try:
            yield cur
        finally:
            cur.close()


def check_connection_():
    """Used by the /api/ health check and setup script to fail fast with a
    clear error instead of a confusing traceback if DATABASE_URL is wrong."""
    with get_cursor_() as cur:
        cur.execute('SELECT 1')
        cur.fetchone()
    return True