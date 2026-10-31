# Plan: persistent user storage

Status: phases A and B done (2026-10-31); C and D proposed. Decisions made so far: sign-in by email + password + authenticator app (TOTP) (changed
from email links), data kept until the
user deletes it, and original files kept in cold storage.

## Problem

Data today belongs to an anonymous session:
- The session ID is a random value saved in one browser.
- Every object in the bucket is deleted 7 days after upload.

So each visit means re-uploading the full Garmin export, which takes a long time, and getting
newer activities means requesting a new full account export.

Goals:
1. Data that stays until the user deletes it, reachable from any device after signing in.
2. Re-uploading an export sends only files the server hasn't seen.
3. Adding a few new activities doesn't need a full export.
4. Dashboards and settings follow the account, not the browser.
5. A foundation that the Garmin and Strava API connections can attach to later.

## Design

### Identity: Firebase Authentication, password + authenticator app
- **Sign-in:** email (as the username) + password, then a 6-digit code from an authenticator app
  (TOTP second factor). New accounts verify their email once (Firebase requires it before
  enrolling a second factor) and then scan a QR code. Password reset is by Firebase's email.
- **Tokens:** the frontend sends a Firebase ID token as `Authorization: Bearer …`. The API
  verifies it with `firebase-admin` (`verify_id_token`), requires the second-factor claim, and a
  FastAPI dependency returns the user ID (`uid`).
- **The `uid` comes only from the verified token**, never from the URL or the request body.
- **Library:** the Firebase JS SDK (modular `firebase/auth`), loaded lazily so the first page
  load stays small.
- **Local development:** the Firebase Auth emulator (no Firebase project needed) covers
  everything except the authenticator step, which it can't do; see CLAUDE.md.

### Storage layout (one bucket, prefixes per owner)
```
users/{uid}/raw/{sha256}.{ext}            original files; Coldline after 30 days
users/{uid}/normalized/activities.parquet
users/{uid}/normalized/laps.parquet
users/{uid}/normalized/records/{activity}.parquet
users/{uid}/manifest.json                 sha256 -> outcome (stored / duplicate / rejected)
users/{uid}/dashboards.json               dashboards + settings, synced from the browser
sessions/{id}/...                         guest data, unchanged, still deleted after 7 days
```
- `SessionStore` becomes an owner-agnostic store that takes a prefix. Parsing, merging and
  querying are unchanged.
- **Lifecycle rules, scoped by prefix:**
  - `sessions/`: delete after 7 days.
  - `users/*/raw/`: move to Coldline after 30 days. Coldline has a 90-day minimum and a
    retrieval fee, which only matters when re-processing.
  - Nothing else under `users/` expires.
- **Must happen before any user data is written:** today's rule deletes everything in the
  bucket after 7 days. It must be narrowed to `sessions/` first.

### Upload only what's new (content-hash dedupe)
- **Browser:** after extracting a ZIP, the browser hashes each kept file with SHA-256 (Web
  Crypto). It then calls `POST /me/uploads/check {hashes}` and uploads only the unknown ones.
- **Server:** keeps a manifest of every hash it has seen, including files rejected as
  non-activities, so those aren't re-sent either. Raw files are named by their full SHA-256.
- **Progress text:** for example "2,950 already stored · uploading 50 new".
- **Effect:** re-uploading a full export costs a few seconds of hashing in the browser plus the
  new files.
- **Guests too:** this works for guest sessions as well, so it can ship before sign-in exists.

### Adding new activities without a full export (works today, needs UI guidance)
- The merge step already deduplicates: same sport, starting within 60 seconds, FIT preferred
  over CSV. So any subset of files can be added at any time.
- **Load Data tab guidance:**
  - Copy `.fit` files from the watch's `GARMIN/Activity` folder over USB.
  - Or use "Export Original" on individual activities in Garmin Connect.
  - Or use Strava's per-activity export.
- **Library summary on Load Data:** the latest stored activity date, total activities, and
  storage used, so the user knows what to add.

### API changes
- **Store dependency:** handlers get their store from a dependency. A verified bearer token
  resolves to `users/{uid}/`; the existing `/sessions/{id}/…` routes resolve to `sessions/{id}/`.
  Routes for signed-in users live under `/me/…`.
- **New endpoints:**

| Endpoint | Purpose |
|---|---|
| `POST /me/uploads/check` | Which of these hashes are already stored |
| `GET /me/library` | Activity count, date range, latest activity, bytes stored |
| `GET` / `PUT /me/dashboards` | Dashboards + settings as JSON (capped at 1 MB; PUT uses a GCS generation precondition) |
| `DELETE /me/activities/{id}` | Remove an activity's row, laps, records, and raw file |
| `DELETE /me` | Delete all the user's data and their Firebase account |
| `POST /me/claim-session` | Move a guest session's data into the account (merge with dedupe) |

- **Per-account limits** replace the 5,000-files-per-session cap: for example 20,000 files and
  10 GB, both configurable.

### Frontend changes
- **Header:** a "Sign in" button. The email form handles the link landing, including asking for
  the email again when the link is opened in another browser.
- **API client:** attaches the ID token. The Firebase SDK refreshes it automatically.
- **Guest mode stays as it is:** try the app without signing in. On sign-in, the user is offered
  "Keep this data in your account", which claims the guest session.
- **Dashboards:**
  - Signed-in users' dashboards load from `/me/dashboards`, with localStorage as an offline
    cache.
  - Saves are debounced, last write wins, and a conflict message appears if another device saved
    in between.
  - Existing local dashboards are uploaded on first sign-in.
- **Load Data tab:** the library summary, hash-skip progress, the "adding new activities" guide,
  and "Delete all my data".

### Infrastructure
- **Firebase:** add it to the existing GCP project, and enable Authentication with
  Email/Password plus TOTP multi-factor.
- **Frontend hosting:** move to **Firebase Hosting**.
  - Sign-in needs an authorized domain (for the verification and reset emails' return links),
    and `storage.googleapis.com` is a poor fit.
  - It also provides the CDN and custom domain from the readiness review.
  - The API's allowed origin (`DASHBOARDER_CORS_ORIGINS`) changes to the Hosting domain.
- **`deploy.sh`:** add the prefix-scoped lifecycle rules, Firebase config injection
  (`VITE_FIREBASE_*`), and `firebase deploy --only hosting`.
- **Before deploying:** upgrade the project to Identity Platform, enable Email/Password, and
  enable TOTP multi-factor (done with the API or gcloud, not the console). Set a password policy
  to match the app's 10-character minimum.

### Security and privacy
- Data is isolated by the `uid` prefix taken from the verified token, and tests cover every
  `/me` route with another user's token.
- Logs carry `uid`, counts and sizes, never email addresses or file contents.
- Storage is encrypted at rest by default (Google-managed keys).
- Add a short privacy note in the app: what's stored (including GPS inside original files), and
  that "Delete all my data" removes it.
- Per-user upload rate limits, and the budget alert from the cost review.

### Cost impact
- **Storage:** about 0.5–1 GB per heavy user, mostly raw files. At 1,000 such users, that's
  about 300 GB Standard ($6) plus 700 GB Coldline ($2.80) per month.
- **Firebase Auth:** no charge at this scale. The free tier covers tens of thousands of monthly
  active users; confirm against current pricing.
- **Re-processing:** reads from Coldline cost about $0.02/GB.

## Phases

| Phase | Scope | Value on its own |
|---|---|---|
| **A. Faster uploads** (no sign-in) | Prefix-scoped lifecycle rule; SHA-256 manifest + `uploads/check`; browser hashing and skip; library summary; "adding new activities" guide | Re-uploading the full ZIP sends only new files |
| **B. Accounts** | Firebase email + password + authenticator (emulator in dev); token-verifying dependency; owner-agnostic store; `/me` routes; guest claim; per-account limits | Data persists and follows the user |
| **C. Sync and control** | Dashboards/settings sync; delete activity / delete all; privacy note | Same dashboards on every device; user controls their data |
| **D. Deploy** | Firebase Hosting; deploy.sh updates; Coldline rule; quota and deliverability check | Running in GCP |

Each phase ends with tests passing and a decision-log entry. The Garmin and Strava API
connections come after D: their OAuth tokens attach to the account, and their activities reuse
the same manifest and merge.

## Testing
- **API:**
  - Dependency override for token verification (fake `uid`s).
  - Isolation tests: user A can't read or delete user B's data.
  - Manifest and hash-check tests.
  - Claim-session merge tests.
  - Delete tests: no objects left under the prefix.
  - Lifecycle JSON shape test.
- **Web:**
  - Sign-in flow against mocked Firebase.
  - Hash-skip upload counts.
  - Dashboard sync and conflict handling.
- **End to end, locally:**
  - Auth emulator + local storage.
  - Sign in, upload the private fixtures, re-upload (expect all skipped).
  - Sign in from a second browser context: data and dashboards present.
  - Delete all: library is empty.
