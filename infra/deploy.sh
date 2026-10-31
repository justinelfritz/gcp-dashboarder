#!/usr/bin/env bash
# Deploy Custom Dashboarder to GCP: data bucket, Cloud Run API, Firebase Auth settings, and the
# frontend on Firebase Hosting. Idempotent: safe to re-run.
# Requires gcloud (authenticated), npm, and a one-time `npx firebase-tools@15.33.0 login`.
#
# Usage: PROJECT_ID=my-project ENV=dev ./infra/deploy.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
ENV="${ENV:-dev}"
REGION="${REGION:-us-east1}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
# Days before original uploads in accounts move to Coldline (kept, cheaper, slower to read).
COLDLINE_DAYS="${COLDLINE_DAYS:-30}"
# Authenticator-app codes at sign-in. Needs the project upgraded to Identity Platform with TOTP
# enabled. One switch drives both the API and the web build, so they can't disagree.
REQUIRE_SECOND_FACTOR="${REQUIRE_SECOND_FACTOR:-false}"
FIREBASE_TOOLS="npx --yes firebase-tools@15.33.0"

SERVICE="dashboarder-api-${ENV}"
DATA_BUCKET="${PROJECT_ID}-dashboarder-data-${ENV}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$REQUIRE_SECOND_FACTOR" != "true" && "$REQUIRE_SECOND_FACTOR" != "false" ]]; then
  echo "REQUIRE_SECOND_FACTOR must be true or false" >&2
  exit 1
fi
if [[ "$ENV" == "prod" && "$REQUIRE_SECOND_FACTOR" != "true" && "${ALLOW_PASSWORD_ONLY:-}" != "1" ]]; then
  echo "Refusing to deploy prod without authenticator codes (see docs/decisions.md)." >&2
  echo "Set REQUIRE_SECOND_FACTOR=true, or ALLOW_PASSWORD_ONLY=1 to deploy password-only anyway." >&2
  exit 1
fi

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com \
  identitytoolkit.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com

# Firebase REST calls below use the gcloud login.
TOKEN="$(gcloud auth print-access-token)"
firebase_api() { # method url [json body]
  curl -sS --fail-with-body -X "$1" "$2" -H "Authorization: Bearer ${TOKEN}" \
    -H "x-goog-user-project: ${PROJECT_ID}" -H "Content-Type: application/json" ${3:+-d "$3"}
}

echo "==> Firebase Auth: 10-character password minimum"
# Matches the web app's sign-up check, so the public API key can't be used to set a shorter one.
firebase_api PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config?updateMask=passwordPolicyConfig" \
  '{"passwordPolicyConfig": {"passwordPolicyEnforcementState": "ENFORCE",
    "passwordPolicyVersions": [{"customStrengthOptions": {"minPasswordLength": 10}}]}}' >/dev/null \
  || echo "    WARNING: couldn't set the password policy; only the web app enforces 10 characters." >&2

echo "==> Firebase web app config"
if [[ -z "${VITE_FIREBASE_API_KEY:-}" ]]; then
  APP_ID="$(firebase_api GET "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps" \
    | python3 -c 'import json,sys; apps=json.load(sys.stdin).get("apps", []); print(apps[0]["appId"] if apps else "")')"
  if [[ -z "$APP_ID" ]]; then
    echo "No Firebase web app in ${PROJECT_ID}. Register one in the Firebase console first." >&2
    exit 1
  fi
  VITE_FIREBASE_API_KEY="$(firebase_api GET \
    "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps/${APP_ID}/config" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')"
fi
SITE_ORIGINS="https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com"

echo "==> Data bucket gs://${DATA_BUCKET} (private)"
if ! gcloud storage buckets describe "gs://${DATA_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${DATA_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
# Guest data (sessions/) expires after RETENTION_DAYS. Account data (users/) is kept until the user
# deletes it; its original uploads move to Coldline. Only uploads end in these suffixes.
LIFECYCLE="$(mktemp)"
cat >"$LIFECYCLE" <<EOF
{"rule": [
  {"action": {"type": "Delete"},
   "condition": {"age": ${RETENTION_DAYS}, "matchesPrefix": ["sessions/"]}},
  {"action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
   "condition": {"age": ${COLDLINE_DAYS}, "matchesPrefix": ["users/"],
                 "matchesSuffix": [".fit", ".fit.gz", ".csv"],
                 "matchesStorageClass": ["STANDARD"]}}
]}
EOF
gcloud storage buckets update "gs://${DATA_BUCKET}" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"

echo "==> Deploying Cloud Run service ${SERVICE}"
gcloud run deploy "$SERVICE" --source "$ROOT/api" --region "$REGION" \
  --allow-unauthenticated --min-instances=0 --max-instances=5 --memory=1Gi --concurrency=4 \
  --set-env-vars="^@^DASHBOARDER_SESSION_BUCKET=${DATA_BUCKET}@DASHBOARDER_CORS_ORIGINS=${SITE_ORIGINS}@DASHBOARDER_FIREBASE_PROJECT_ID=${PROJECT_ID}@DASHBOARDER_REQUIRE_SECOND_FACTOR=${REQUIRE_SECOND_FACTOR}"

# The service's runtime identity reads/writes data and deletes Firebase accounts ("Delete all my
# data"). Verifying sign-in tokens needs no role.
RUNTIME_SA="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.spec.serviceAccountName)')"
if [[ -z "$RUNTIME_SA" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
gcloud storage buckets add-iam-policy-binding "gs://${DATA_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/firebaseauth.admin >/dev/null

API_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "    API: ${API_URL}"

echo "==> Building the frontend"
(cd "$ROOT/web" && npm ci && \
  VITE_API_BASE_URL="$API_URL" \
  VITE_FIREBASE_API_KEY="$VITE_FIREBASE_API_KEY" \
  VITE_FIREBASE_AUTH_DOMAIN="${PROJECT_ID}.firebaseapp.com" \
  VITE_FIREBASE_PROJECT_ID="$PROJECT_ID" \
  VITE_REQUIRE_SECOND_FACTOR="$REQUIRE_SECOND_FACTOR" \
  npm run build)

echo "==> Deploying to Firebase Hosting"
(cd "$ROOT" && $FIREBASE_TOOLS deploy --only hosting --project "$PROJECT_ID" --non-interactive)

echo
echo "Done."
echo "  API:      ${API_URL}/health"
echo "  Frontend: https://${PROJECT_ID}.web.app"
