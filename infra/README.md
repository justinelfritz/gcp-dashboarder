# Infrastructure

`deploy.sh` stands up one environment with `gcloud`. It is idempotent, so re-run it to redeploy.

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install), then `gcloud auth login`
- A GCP project with billing enabled
- Node 20+ (to build the frontend)

## Deploy

```bash
PROJECT_ID=your-project ENV=dev ./infra/deploy.sh
```

Optional variables: `REGION` (default `us-central1`), `RETENTION_DAYS` (default `7`).

## What it creates

| Resource | Name | Notes |
|---|---|---|
| Cloud Run service | `dashboarder-api-${ENV}` | Built from `api/` via Cloud Build. Min instances 0, max 5, 1 GiB, 4 concurrent requests per instance. Health check: `/health`. |
| GCS bucket (private) | `${PROJECT_ID}-dashboarder-sessions-${ENV}` | Session data. Objects deleted after `RETENTION_DAYS`. |
| GCS bucket (public) | `${PROJECT_ID}-dashboarder-web-${ENV}` | Static frontend build. |

## Known limitations

- The lifecycle rule deletes objects by **age since upload**, not inactivity. True inactivity-based
  expiry needs the API to rewrite a marker object on each visit, or a scheduled cleanup job.
- The frontend is served directly from `storage.googleapis.com` with no CDN or custom domain.
  Move to Firebase Hosting, or a load balancer + Cloud CDN, before launch.
