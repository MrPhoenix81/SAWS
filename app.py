"""
app.py
Single Flask entry point serving BOTH the built React frontend and
the JSON API from one process.

- Frontend (Dashboard, Students, Users, Branches, Audit Log, Login,
  etc.) is served from templates/index.html + static/assets/*, at
  any path that isn't /api/... (so React Router's client-side routes
  work on refresh too).
- API (everything the old standalone backend app.py used to do at
  "/") now lives at /api/ - see api.py, which was converted into a
  Blueprint for this. The frontend was rebuilt with
  VITE_API_URL=/api/ so it calls same-origin, no CORS needed.

Run:
    pip install -r requirements.txt
    cp .env.example .env        # fill in DATABASE_URL etc.
    python setup_script.py init
    python setup_script.py create-admin you@example.com "Your Name"
    python app.py

Then open http://localhost:5000/
"""
from flask import Flask, render_template, send_from_directory

from api import api_bp
from db_utils import ensure_sheets_exist_, start_cache_warmup_
import scheduler
import cleanup

# Create the Postgres tables on boot if they don't exist yet, so a
# brand-new Neon database "just works" the first time this app runs
# (you can still run setup_script.py separately for seeding branches
# and creating the first admin - see README.md).
ensure_sheets_exist_()

# Preload the busiest tables into the in-memory cache in the background
# so the first user after a restart doesn't wait on the database.
start_cache_warmup_()

# Optional: see scheduler.py / README.md for why this is off by
# default in favor of a Render Cron Job.
scheduler.start_if_enabled_()

# Always on: sweeps call-log screenshots older than the retention
# window (see config.SCREENSHOT_RETENTION_HOURS).
scheduler.start_screenshot_cleanup_()
scheduler.start_supabase_keepalive_()

# Always on: permanently removes fully (Admin) approved records from
# the production database 60 days after their Admin Final Approval
# Date - never from the Google Sheet backup. See cleanup.py.
cleanup.start_()

app = Flask(
    __name__,
    static_folder="static",
    static_url_path="/static",
    template_folder="templates",
)

app.register_blueprint(api_bp, url_prefix="/api")


@app.route("/health")
def health_check():
    """
    Pinged by UptimeRobot every 5 minutes to keep Render awake. Also
    touches Supabase Storage (screenshot bucket) AND runs a trivial
    query against the Neon Postgres database on every hit, so neither
    the free Supabase project nor the Neon database auto-suspends
    from inactivity.

    Both touches are best-effort and swallow their own exceptions so
    a transient Storage/DB hiccup never breaks this route - which
    would make UptimeRobot think the whole app is down.

    IMPORTANT CAVEAT: this only runs while the Flask process itself
    is up and reachable, since it's just a route handler - it cannot
    fire on its own if the app is fully stopped/not deployed (e.g.
    the Render service is suspended, deleted, or was never started).
    In that case nothing is running to answer this request in the
    first place, so nothing here can wake the database; only a
    genuinely running deployment, pinged from outside (UptimeRobot or
    similar), keeps both Supabase and Neon warm.
    """
    try:
        from storage import keepalive_touch_
        keepalive_touch_()
    except Exception:
        pass
    try:
        from db import check_connection_
        check_connection_()
    except Exception:
        pass
    return "ok", 200


@app.route("/logo.svg")
def logo():
    """
    The compiled JS bundle references /logo.svg directly (not
    /static/logo.svg), so this route serves it from that exact path.
    """
    return send_from_directory(app.static_folder, "logo.svg")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    """
    Catch-all for the frontend. Flask's own static route (and the
    /api and /logo.svg routes above) are matched first since they're
    more specific, so this only ever handles frontend page paths -
    including client-side ones like /dashboard/students that don't
    correspond to a real file, which is why they fall through to
    index.html and let React Router take over.
    """
    return render_template("index.html")


if __name__ == "__main__":
    # Development server only. For production use gunicorn/uwsgi/waitress -
    # see README.md and the Dockerfile.
    app.run(host="0.0.0.0", port=5000, debug=True)