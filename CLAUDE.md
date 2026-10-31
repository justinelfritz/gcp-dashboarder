# Dashboarder

Web app for uploading activity files (CSV, FIT) and building custom fitness dashboards.
The full plan is in `dashboarder-plan.md`; architecture decisions are logged in `docs/decisions.md`.

## Stack

- API: Python 3.12 + FastAPI in `api/`, managed with `uv`. Deployed to Cloud Run.
- Web: React + TypeScript + Vite in `web/`.
- Storage: Cloud Storage + Parquet. No database in v1.

## Commands

- API tests: `cd api && uv run pytest`
- API lint: `cd api && uv run ruff check .`
- API dev server: `cd api && uv run uvicorn app.main:app --reload --port 8080`
- Web tests: `cd web && npm test`
- Web dev server: `cd web && npm run dev` (expects the API on `localhost:8080`)
- Sign-in locally (optional; without it the app is guest-only): from the repo root (its
  `firebase.json` puts the Auth emulator on port 9099), run
  `npx firebase-tools@15.33.0 emulators:start --only auth --project demo-dashboarder`. Start the API
  with `DASHBOARDER_FIREBASE_PROJECT_ID=demo-dashboarder FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`,
  and the web app with the `VITE_FIREBASE_*` variables from `web/.env.example` (any API key; project
  `demo-dashboarder`). New accounts must verify their email: the verification and reset emails are
  listed at `http://127.0.0.1:9099/emulator/v1/projects/demo-dashboarder/oobCodes`.
- Sign-in is email + password. Authenticator (TOTP) codes are built but off until prod: turning
  them on needs Identity Platform plus `DASHBOARDER_REQUIRE_SECOND_FACTOR=true` and
  `VITE_REQUIRE_SECOND_FACTOR=true` together. The emulator can't do TOTP.
- Deploy: `PROJECT_ID=custom-dashboarder-dev ENV=dev ./infra/deploy.sh` (see `infra/README.md`;
  needs a one-time `npx firebase-tools@15.33.0 login`).

## Conventions

- Metrics must return null for missing inputs, never raise on sparse data.
- Units are metric internally (m, s, W, m/s). Convert only in the frontend.
- Never log uploaded file contents or email addresses. Log the session ID or user UID, file size,
  and parse counts only.
- Keep the dashboard JSON `schema_version` in sync with the frontend types.
- Keep `web/src/api/client.ts` types in sync with `api/app/models.py`.
- Panel query format: `docs/panel-queries.md`. Chart rendering is a pure function
  (`web/src/charts/buildFigure.ts`); test figures there rather than through Plotly.
- Chart colors come from the validated palette in `web/src/charts/palette.ts`; don't add hues.
