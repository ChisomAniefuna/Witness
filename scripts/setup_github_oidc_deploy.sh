#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PROJECT_ID=witness-489710 GITHUB_REPO=owner/repo ./scripts/setup_github_oidc_deploy.sh
# Optional env vars:
#   REGION=us-central1
#   SERVICE_ACCOUNT_NAME=github-deployer
#   WIF_POOL_ID=github-pool
#   WIF_PROVIDER_ID=github-provider

PROJECT_ID="${PROJECT_ID:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
REGION="${REGION:-us-central1}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-github-deployer}"
WIF_POOL_ID="${WIF_POOL_ID:-github-pool}"
WIF_PROVIDER_ID="${WIF_PROVIDER_ID:-github-provider}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: PROJECT_ID is required"
  exit 1
fi

if [[ -z "$GITHUB_REPO" ]]; then
  echo "ERROR: GITHUB_REPO is required (format: owner/repo)"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI is not installed"
  exit 1
fi

if ! gcloud config get-value account >/dev/null 2>&1; then
  echo "ERROR: gcloud is not authenticated. Run: gcloud auth login"
  exit 1
fi

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project: $PROJECT_ID ($PROJECT_NUMBER)"
echo "Repo: $GITHUB_REPO"

# Create deploy service account if missing.
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --display-name="GitHub Deploy SA"
fi

# Grant deploy permissions.
ROLES=(
  "roles/cloudbuild.builds.editor"
  "roles/run.admin"
  "roles/iam.serviceAccountUser"
  "roles/artifactregistry.writer"
  "roles/firebasehosting.admin"
  "roles/serviceusage.serviceUsageConsumer"
)

for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="$role" \
    --quiet >/dev/null
done

# Create WIF pool if missing.
if ! gcloud iam workload-identity-pools describe "$WIF_POOL_ID" \
  --project="$PROJECT_ID" --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --display-name="GitHub Actions Pool"
fi

# Create WIF provider if missing.
if ! gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project="$PROJECT_ID" --location="global" --workload-identity-pool="$WIF_POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$WIF_POOL_ID" \
    --display-name="GitHub Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}' && assertion.ref=='refs/heads/main'"
fi

# Allow repo identities to impersonate deploy service account.
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}" \
  --quiet >/dev/null

WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"

echo ""
echo "Setup complete. Add these GitHub repository secrets:"
echo "GCP_PROJECT_ID=${PROJECT_ID}"
echo "GCP_WIF_PROVIDER=${WIF_PROVIDER_RESOURCE}"
echo "GCP_DEPLOY_SERVICE_ACCOUNT=${SERVICE_ACCOUNT_EMAIL}"
echo ""
echo "Workflow file: .github/workflows/deploy-main.yml"
echo "Region in workflow is currently: ${REGION}"
