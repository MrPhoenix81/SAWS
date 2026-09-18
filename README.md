# SDMS — Setup Guide (Neon database + Render hosting + daily Google Sheets backup)

This app now stores its real data in a **Neon Postgres database**
instead of Google Sheets. Google Sheets is only used as a **daily
backup copy** — a safety net you can open and read, but the app
itself never reads from it.

This guide assumes you know nothing about coding or deployment yet.
Follow it top to bottom, in order.

---

## What you're setting up, in one picture

```
Your app (Render)  --reads & writes-->  Neon Postgres (the real database)
Your app (Render Cron Job, once/day) --writes only--> Google Sheet (backup copy)
```

If Neon ever goes down, your data is safe in Neon's own backups. The
Google Sheet is an *extra* copy for your own peace of mind — e.g. if
you want to eyeball the data without touching the database, or want
a copy outside of Neon entirely.

---

## Part 1 — Create your Neon database

1. Go to https://neon.tech and sign up (free tier is enough to start).
2. Click **Create a project**. Give it any name (e.g. `sdms`).
3. Once it's created, go to the project's **Dashboard**, and find the
   **Connection string** (sometimes under "Connect" or "Connection
   Details"). It looks like:

   ```
   postgresql://myuser:mypassword@ep-something-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

4. Copy that whole string — you'll need it in Part 3. Keep it secret;
   it's like a password to your entire database.

That's it — you don't need to create tables by hand. The app creates
them automatically the first time it runs (see Part 4).

---

## Part 2 — Create your backup Google Sheet (optional but recommended)

Skip this part if you don't want a backup yet — you can add it
later. The app works fully without it.

1. Go to https://sheets.google.com and create a new, blank
   spreadsheet. Name it something like "SDMS Backup". You don't need
   to set up any tabs or columns — the backup job creates them.
2. Copy the **Spreadsheet ID** from its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_LONG_ID_HERE`**`/edit`
3. Go to https://console.cloud.google.com and:
   - Create a new project (top-left project picker → "New Project").
   - In the search bar, search for **"Google Sheets API"** and click
     **Enable**.
   - Go to **APIs & Services → Credentials → Create Credentials →
     Service Account**. Give it any name and click through to Done.
   - Click on the service account you just created → **Keys** tab →
     **Add Key → Create new key → JSON**. This downloads a `.json`
     file to your computer. **Keep this file private — don't share
     it or upload it anywhere public.**
   - Open that JSON file with a text editor and copy its *entire*
     contents (starts with `{` and ends with `}`).
4. Back in your Google Sheet, click **Share**, and share it with the
   service account's email address (found inside the JSON file as
   `"client_email"`), giving it **Editor** access — exactly like
   sharing with a coworker.

You now have two things to save for Part 3:
- The **Spreadsheet ID** from step 2.
- The **entire JSON file contents** from step 3.

---

## Part 3 — Run the app on your own computer first (recommended)

Doing this once locally makes sure everything works before you put
it on the internet.

1. Install [Python 3.11+](https://www.python.org/downloads/) if you
   don't have it. During install on Windows, tick **"Add Python to
   PATH"**.
2. Open a terminal (Command Prompt / PowerShell / Terminal) inside
   this project folder.
3. Create and activate a virtual environment, then install
   dependencies:

   ```
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   # Mac/Linux:
   source .venv/bin/activate

   pip install -r requirements.txt
   ```

4. Copy `.env.example` to `.env` (a plain copy/paste/rename in your
   file explorer is fine), then open `.env` in a text editor and
   fill in:
   - `DATABASE_URL` — the Neon connection string from Part 1.
   - `BACKUP_SPREADSHEET_ID` — the ID from Part 2 (leave blank to
     skip backups for now).
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the entire JSON contents
     from Part 2 as one line (leave blank to skip backups for now).

5. Create the database tables and your first login:

   ```
   python setup_script.py init
   python setup_script.py create-admin you@example.com "Your Name"
   ```

   The second command prints an email + generated password — write
   these down, you'll use them to log in.

6. (Optional) Try the backup manually:

   ```
   python backup_to_sheets.py
   ```

   Open your Google Sheet — you should see tabs like `Users`,
   `Branches`, `Response`, etc. with data in them.

7. Start the app:

   ```
   python app.py
   ```

   Open http://localhost:5000 in your browser and log in with the
   admin email/password from step 5.

If this all works, you're ready to deploy.

---

## Part 4 — Deploy the app itself on Render

1. Push this project to a GitHub repository (if you're not sure how,
   search "upload folder to GitHub" — GitHub Desktop is the easiest
   beginner tool for this).
2. Go to https://render.com, sign up, and click **New → Web Service**.
3. Connect your GitHub repo.
4. Render will detect the `Dockerfile` in this project automatically
   — leave the build settings as Docker.
5. Under **Environment**, add these environment variables (same
   values as your `.env` file):
   - `DATABASE_URL`
   - `BACKUP_SPREADSHEET_ID` (if using backups)
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (if using backups)
   - `APP_BASE_URL` — set this to your Render app's URL once you know
     it, e.g. `https://sdms.onrender.com` (used for "forgot password"
     links).
6. Click **Create Web Service**. Render will build and deploy it —
   this takes a few minutes the first time.
7. Once it's live, open its URL and confirm you can log in with the
   admin account you created in Part 3, step 5.

You only need to run `setup_script.py init` / `create-admin` **once**
— against the same Neon database — either from your own computer (as
in Part 3) or via Render's **Shell** tab on the deployed service.

---

## Part 5 — Set up the daily backup on Render (recommended)

The most reliable way to run the backup once a day is as its own
small Render **Cron Job**, separate from the web app, so it runs on
schedule even if the web app has been idle:

1. In Render, click **New → Cron Job**.
2. Connect the same GitHub repo (it reuses the same `Dockerfile`).
3. Set the **Command** to:
   ```
   python backup_to_sheets.py
   ```
4. Set the **Schedule** — e.g. `0 20 * * *` runs it daily at 20:00 UTC.
   (Use https://crontab.guru if you want a different time.)
5. Add the same environment variables as the web service:
   `DATABASE_URL`, `BACKUP_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`.
6. Save. Render will now run this once a day automatically.

**Alternative (simpler, less reliable):** instead of a separate Cron
Job, you can set `START_INPROCESS_BACKUP_SCHEDULER=true` and
`BACKUP_HOUR_UTC` on the web service itself, and it will run the
backup on a timer from inside the running app. This is fine to start
with, but a free/starter web service that goes to sleep when idle can
miss a scheduled run — the Cron Job in step 1-6 doesn't have that
problem. You can use both at once if you like extra safety.

---

## Everyday use after setup

- **Creating more users** (besides the first admin): once logged in
  as Admin, use the **Users** page in the app itself — you don't need
  to touch `setup_script.py` again.
- **Checking your backup**: just open the Google Sheet any time — the
  `_BackupInfo` tab shows when it last ran and how many rows it
  backed up.
- **If something breaks**: check Render's **Logs** tab for the web
  service (or the Cron Job) for the error message.

---

## What changed under the hood (for reference)

| Before | Now |
|---|---|
| Data lived in a Google Sheet, read/written on every request | Data lives in Neon Postgres, read/written on every request |
| `sheet_utils.py` talked to the Sheets API | `db_utils.py` talks to Postgres, with the exact same function names, so no other file's logic needed to change |
| No backup | `backup_to_sheets.py` writes a full daily snapshot to a separate Google Sheet (write-only, never read by the app) |
| Single-process only (in-memory lock/cache assumed one worker) | Real database transactions — safe to scale to multiple workers later if needed |

Every feature that existed before — student workflow (SCM → HOF →
Manager → Head Office → Admin), Inactive requests, Transfers, Users,
Branches, Notifications, Audit Log, login/forgot-password — works
exactly the same from the app's point of view. Only where the data is
stored changed.
