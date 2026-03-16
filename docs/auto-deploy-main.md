# Auto Deploy On Push To Main

This repo can auto-deploy all production services whenever code is pushed to `main`.

## Workflow file

- GitHub Actions workflow: `.github/workflows/deploy-main.yml`

## What it deploys

1. Node backend to Cloud Run using `cloudbuild.yaml`
2. Live backend to Cloud Run using `cloudbuild-live.yaml`
3. Frontend to Firebase Hosting after building with the latest deployed backend/live URLs

## Required GitHub repository secrets

- `GCP_PROJECT_ID`: GCP project id (example: `witness-489710`)
- `GCP_WIF_PROVIDER`: Workload Identity Provider resource name
  - format: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`
- `GCP_DEPLOY_SERVICE_ACCOUNT`: deploy service account email
  - example: `github-deployer@witness-489710.iam.gserviceaccount.com`

## Required IAM roles for deploy service account

- `roles/cloudbuild.builds.editor`
- `roles/run.admin`
- `roles/iam.serviceAccountUser`
- `roles/artifactregistry.writer` (or Container Registry write access if using gcr)
- `roles/firebasehosting.admin`
- `roles/serviceusage.serviceUsageConsumer`

## Enable the workflow

1. Push this workflow to `main`.
2. Add the required GitHub secrets in repository settings.
3. Ensure your GitHub repo is trusted by the configured Workload Identity Provider.
4. Push a new commit to `main` and watch the `Deploy On Main` workflow run.

## Bonus section link

Use this link in your submission as proof of deployment automation:

- `.github/workflows/deploy-main.yml`
