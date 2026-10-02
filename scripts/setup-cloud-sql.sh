#!/usr/bin/env bash
# Run from Google Cloud Shell. This creates billed Google Cloud resources.
set +x
set -euo pipefail

project="sfsu-hackathon-2026"
region="us-west2"
service="sfhacksxgdg2026-git"
instance="sfhacksxgdg2026-db"
database_name="timeline"
database_user="timeline"
password_secret="sfhacksxgdg2026-db-password"
artifact_region="us-west1"
artifact_repository="cloud-run-source-deploy"

command -v gcloud >/dev/null
command -v openssl >/dev/null

gcloud services enable sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
    --project="$project" --quiet

# Use the existing service's identity rather than granting access to a new one.
runtime_account=$(gcloud run services describe "$service" --project="$project" \
    --region="$region" --format='value(spec.template.spec.serviceAccountName)')
if [[ -z "$runtime_account" ]]; then
    project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
    runtime_account="${project_number}-compute@developer.gserviceaccount.com"
fi

existing_instance=$(gcloud sql instances list --project="$project" \
    --filter="name=$instance" --format='value(name)')
if [[ -z "$existing_instance" ]]; then
    gcloud sql instances create "$instance" --project="$project" \
        --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro \
        --region="$region" --availability-type=ZONAL \
        --storage-type=SSD --storage-size=10 --storage-auto-increase \
        --backup-start-time=03:00 --assign-ip --quiet
fi

instance_region=$(gcloud sql instances describe "$instance" --project="$project" \
    --format='value(region)')
instance_version=$(gcloud sql instances describe "$instance" --project="$project" \
    --format='value(databaseVersion)')
if [[ "$instance_region" != "$region" || "$instance_version" != POSTGRES_* ]]; then
    echo "Existing instance must be PostgreSQL in $region. No credentials were changed." >&2
    exit 1
fi

existing_database=$(gcloud sql databases list --project="$project" --instance="$instance" \
    --filter="name=$database_name" --format='value(name)')
if [[ -z "$existing_database" ]]; then
    gcloud sql databases create "$database_name" --project="$project" \
        --instance="$instance" --quiet
fi

existing_user=$(gcloud sql users list --project="$project" --instance="$instance" \
    --filter="name=$database_user" --format='value(name)')
existing_secret=$(gcloud secrets list --project="$project" \
    --filter="name~'/$password_secret$'" --format='value(name)')

if [[ -n "$existing_secret" ]]; then
    # Reuse the original password on reruns, including after interrupted setup.
    database_password=$(gcloud secrets versions access latest \
        --project="$project" --secret="$password_secret")
elif [[ -n "$existing_user" ]]; then
    echo "Database user already exists without its password secret. Setup stopped to preserve its credentials." >&2
    exit 1
else
    database_password=$(openssl rand -hex 32)
    printf '%s' "$database_password" | gcloud secrets create "$password_secret" \
        --project="$project" --replication-policy=automatic --data-file=- --quiet
fi

if [[ -z "$existing_user" ]]; then
    gcloud sql users create "$database_user" --project="$project" \
        --instance="$instance" --password="$database_password" --quiet
fi
unset database_password

gcloud projects add-iam-policy-binding "$project" \
    --member="serviceAccount:$runtime_account" --role=roles/cloudsql.client \
    --condition=None --quiet --format=none
gcloud secrets add-iam-policy-binding "$password_secret" --project="$project" \
    --member="serviceAccount:$runtime_account" --role=roles/secretmanager.secretAccessor \
    --quiet --format=none

# The original deployment failed because this image repository was missing.
existing_repository=$(gcloud artifacts repositories list --project="$project" \
    --location="$artifact_region" --filter="name~'/$artifact_repository$'" --format='value(name)')
if [[ -z "$existing_repository" ]]; then
    gcloud artifacts repositories create "$artifact_repository" --project="$project" \
        --location="$artifact_region" --repository-format=docker --quiet
fi

connection_name=$(gcloud sql instances describe "$instance" --project="$project" \
    --format='value(connectionName)')
echo "Cloud SQL ready: $connection_name"
echo "Database: $database_name; user: $database_user; password stored in Secret Manager."
echo "Deploy the updated repository through cloudbuild.yaml to initialize its tables."
