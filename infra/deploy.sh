#!/usr/bin/env bash
# Deploy Dashboarder to GCP: session bucket, Cloud Run API, and static frontend bucket.
# Idempotent: safe to re-run. Requires gcloud (authenticated) and npm.
#
# Usage: PROJECT_ID=my-project ENV=dev ./infra/deploy.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
ENV="${ENV:-dev}"
REGION="${REGION:-us-central1}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

SERVICE="dashboarder-api-${ENV}"
SESSION_BUCKET="${PROJECT_ID}-dashboarder-sessions-${ENV}"
WEB_BUCKET="${PROJECT_ID}-dashboarder-web-${ENV}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com

echo "==> Session bucket gs://${SESSION_BUCKET} (private, ${RETENTION_DAYS}-day lifecycle)"
if ! gcloud storage buckets describe "gs://${SESSION_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${SESSION_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
LIFECYCLE="$(mktemp)"
cat >"$LIFECYCLE" <<EOF
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": ${RETENTION_DAYS}}}]}
EOF
gcloud storage buckets update "gs://${SESSION_BUCKET}" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"

echo "==> Web bucket gs://${WEB_BUCKET} (public)"
if ! gcloud storage buckets describe "gs://${WEB_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${WEB_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access
  gcloud storage buckets add-iam-policy-binding "gs://${WEB_BUCKET}" \
    --member=allUsers --role=roles/storage.objectViewer
  gcloud storage buckets update "gs://${WEB_BUCKET}" \
    --web-main-page-suffix=index.html --web-error-page=index.html
fi
WEB_ORIGIN="https://storage.googleapis.com"

echo "==> Deploying Cloud Run service ${SERVICE}"
gcloud run deploy "$SERVICE" --source "$ROOT/api" --region "$REGION" \
  --allow-unauthenticated --min-instances=0 --max-instances=5 --memory=1Gi \
  --set-env-vars="^@^DASHBOARDER_SESSION_BUCKET=${SESSION_BUCKET}@DASHBOARDER_CORS_ORIGINS=${WEB_ORIGIN}"

# Let the service's runtime identity read/write session data.
RUNTIME_SA="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.spec.serviceAccountName)')"
if [[ -z "$RUNTIME_SA" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
gcloud storage buckets add-iam-policy-binding "gs://${SESSION_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin >/dev/null

API_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "    API: ${API_URL}"

echo "==> Building and uploading frontend"
(cd "$ROOT/web" && npm ci && VITE_API_BASE_URL="$API_URL" npm run build -- --base="/${WEB_BUCKET}/")
gcloud storage rsync "$ROOT/web/dist" "gs://${WEB_BUCKET}" --recursive --delete-unmatched-destination-objects

echo
echo "Done."
echo "  API:      ${API_URL}/healthz"
echo "  Frontend: ${WEB_ORIGIN}/${WEB_BUCKET}/index.html"
