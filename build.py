#!/usr/bin/env python3
"""
build.py

One command to build the React frontend and drop the output straight
into this Flask app's static/ and templates/ folders - no manual
`npm run build` + copy-paste + editing index.html by hand.

Usage:
    python build.py

Then just run the app as normal:
    python app.py

What it does:
1. Runs `npm install` in frontend/ (only if node_modules is missing).
2. Runs `npm run build` in frontend/ with VITE_API_URL=/api/ so the
   built app calls the API on the same origin it's served from.
3. Wipes the old static/ folder and copies the new dist/assets/* and
   dist/logo.svg in.
4. Copies dist/index.html into templates/index.html, rewriting the
   asset paths Vite emits (/assets/..., /logo.svg) to include the
   /static prefix Flask needs - this was the manual step before.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
FRONTEND_DIR = ROOT / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"
STATIC_DIR = ROOT / "static"
TEMPLATES_DIR = ROOT / "templates"

ON_WINDOWS = os.name == "nt"


def run(cmd, cwd, env=None):
    print(f"$ {' '.join(cmd)}  (in {cwd})")
    result = subprocess.run(cmd, cwd=cwd, env=env, shell=ON_WINDOWS)
    if result.returncode != 0:
        sys.exit(f"Command failed: {' '.join(cmd)}")


def main():
    if not FRONTEND_DIR.exists():
        sys.exit(f"Frontend folder not found at {FRONTEND_DIR}")

    if not (FRONTEND_DIR / "node_modules").exists():
        run(["npm", "install"], cwd=FRONTEND_DIR)

    # Always build against the same-origin API path - this app serves
    # both the frontend and the API from one Flask process, so the
    # frontend should never hardcode http://localhost:5000.
    build_env = os.environ.copy()
    build_env["VITE_API_URL"] = "/api/"
    run(["npm", "run", "build"], cwd=FRONTEND_DIR, env=build_env)

    if not DIST_DIR.exists():
        sys.exit(f"Build finished but {DIST_DIR} was not created - check the Vite build output above.")

    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    STATIC_DIR.mkdir(parents=True)
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

    dist_assets = DIST_DIR / "assets"
    if dist_assets.exists():
        shutil.copytree(dist_assets, STATIC_DIR / "assets")

    logo_src = DIST_DIR / "logo.svg"
    if logo_src.exists():
        shutil.copy2(logo_src, STATIC_DIR / "logo.svg")

    redirects_src = DIST_DIR / "_redirects"
    if redirects_src.exists():
        shutil.copy2(redirects_src, STATIC_DIR / "_redirects")

    index_src = DIST_DIR / "index.html"
    html = index_src.read_text(encoding="utf-8")
    html = html.replace('src="/assets/', 'src="/static/assets/')
    html = html.replace('href="/assets/', 'href="/static/assets/')
    html = html.replace('href="/logo.svg"', 'href="/static/logo.svg"')
    (TEMPLATES_DIR / "index.html").write_text(html, encoding="utf-8")

    print("\nDone. static/ and templates/ now match the latest frontend build.")
    print("Run: python app.py   (or your gunicorn command) to serve it.")


if __name__ == "__main__":
    main()
