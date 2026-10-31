# Infrastructure

`deploy.sh` stands up one environment with `gcloud` and the Firebase CLI. It is idempotent, so
re-run it to redeploy.

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in (`gcloud init` or
  `gcloud auth login`).
- A GCP project with billing enabled, and Firebase added to it.
- In the Firebase console: **Authentication → Sign-in method → Email/Password** enabled, and a
  **web app** registered with Hosting. The script reads the web app's API key itself.
- Node 20+, and a one-time `npx firebase-tools@15.33.0 login` (for the Hosting upload).

## Deploy

```bash
PROJECT_ID=custom-dashboarder-dev ENV=dev ./infra/deploy.sh
```

Optional variables:

| Variable | Default | Meaning |
|---|---|---|
| `REGION` | `us-east1` | Cloud Run and bucket location (South Carolina). Change it before the first deploy: the bucket can't move later. |
| `RETENTION_DAYS` | `7` | Days before guest data (`sessions/`) is deleted. |
| `COLDLINE_DAYS` | `30` | Days before an account's original uploads move to Coldline. |
| `REQUIRE_SECOND_FACTOR` | `false` | `true` requires authenticator-app codes. Needs Identity Platform with TOTP enabled. Sets both the API and the web build. |
| `ALLOW_PASSWORD_ONLY` | unset | `1` lets `ENV=prod` deploy without authenticator codes; otherwise prod refuses to. |

## What it creates or updates

| Resource | Name | Notes |
|---|---|---|
| Cloud Run service | `dashboarder-api-${ENV}` | Built from `api/` via Cloud Build. Min instances 0, max 5, 1 GiB, 4 concurrent requests per instance. Health check: `/health`. |
| GCS bucket (private) | `${PROJECT_ID}-dashboarder-data-${ENV}` | Guest data under `sessions/` is deleted after `RETENTION_DAYS`. Account data under `users/` is kept; its original uploads move to Coldline after `COLDLINE_DAYS`. |
| Firebase Hosting | `https://${PROJECT_ID}.web.app` | The frontend (`web/dist`), configured in `/firebase.json`. Hashed assets are cached for a year; `index.html` is always revalidated. |
| Firebase Auth setting | password policy | 10-character minimum, matching the web app. |
| IAM | runtime service account | `storage.objectAdmin` on the bucket; `firebaseauth.admin` on the project (to delete accounts). |

## Known limitations

- The lifecycle rule deletes guest objects by **age since upload**, not inactivity.
- Coldline has a 90-day minimum: deleting an original sooner is billed as if it stayed 90 days.
  With activity files this is fractions of a cent.
- Firebase's verification and reset emails come from `noreply@${PROJECT_ID}.firebaseapp.com` and
  often land in spam. A custom sender domain fixes that later.
