# Builds the React frontend (needs Node) and then serves the whole
# app (Flask + built frontend) from one Python image, so nothing has
# to be pre-built or committed to the repo - Render (or any other
# Docker host) builds this from source every deploy.

FROM python:3.13-slim

# --- Node.js, needed only to run `npm run build` during this image
# build. It's not needed at runtime, but keeping it in the final
# image is simplest and costs little - splitting into a multi-stage
# build is a fine later optimization, not needed to ship this.
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first so this layer is cached unless requirements.txt
# changes (avoids re-installing on every frontend-only change).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Frontend deps next, same caching reasoning.
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

# Now the rest of the source, then build the frontend into
# static/ + templates/ exactly like running `python build.py` locally.
COPY . .
RUN python build.py

# waitress: multi-threaded, single-process WSGI server. Data now
# lives in Postgres (Neon), so - unlike the old Google Sheets
# version - it's safe to scale this to multiple worker processes if
# you ever need to; waitress's threads are plenty for most usage.
#
# This same image is also used for the daily backup Render Cron Job
# (see README.md) - that service overrides this CMD with:
#   python backup_to_sheets.py
ENV PORT=8000
CMD waitress-serve --host=0.0.0.0 --port=${PORT} --threads=8 app:app
