#!/usr/bin/env bash
# Run in Cloud Shell. Creates a billed GPU service and a model storage bucket.
set +x
set -euo pipefail

project="sfsu-hackathon-2026"
region="us-central1"
service="sfhacksxgdg2026-gemma"
app_service="sfhacksxgdg2026-git"
app_region="us-west2"
model="google/gemma-4-31B-it"
bucket="$project-gemma-models-$region"
network="sfhacksxgdg2026-gemma"
subnet="sfhacksxgdg2026-gemma-us-central1"
subnet_range="10.90.0.0/24"
runtime_account="sfhacks-gemma@$project.iam.gserviceaccount.com"
copy_account="sfhacks-gemma-copy@$project.iam.gserviceaccount.com"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

command -v gcloud >/dev/null
command -v node >/dev/null

gcloud services enable run.googleapis.com compute.googleapis.com iam.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
    --project="$project" --quiet

app_account=$(gcloud run services describe "$app_service" --project="$project" \
    --region="$app_region" --format='value(spec.template.spec.serviceAccountName)')
if [[ -z "$app_account" ]]; then
    project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
    app_account="${project_number}-compute@developer.gserviceaccount.com"
fi

for account_name in sfhacks-gemma sfhacks-gemma-copy; do
    existing_account=$(gcloud iam service-accounts list --project="$project" \
        --filter="email=$account_name@$project.iam.gserviceaccount.com" --format='value(email)')
    if [[ -z "$existing_account" ]]; then
        gcloud iam service-accounts create "$account_name" --project="$project" \
            --display-name="$account_name" --quiet
    fi
done

existing_bucket=$(gcloud storage buckets list --project="$project" \
    --filter="name=$bucket" --format='value(name)')
if [[ -z "$existing_bucket" ]]; then
    gcloud storage buckets create "gs://$bucket" --project="$project" --location="$region" \
        --uniform-bucket-level-access --public-access-prevention --quiet
fi
bucket_region=$(gcloud storage buckets describe "gs://$bucket" --project="$project" \
    --format='value(location)' | tr '[:upper:]' '[:lower:]')
if [[ "$bucket_region" != "$region" ]]; then
    echo "The model bucket must be in $region for this deployment." >&2
    exit 1
fi

gcloud storage buckets add-iam-policy-binding "gs://$bucket" --project="$project" \
    --member="serviceAccount:$runtime_account" --role=roles/storage.objectViewer --quiet --format=none
gcloud storage buckets add-iam-policy-binding "gs://$bucket" --project="$project" \
    --member="serviceAccount:$copy_account" --role=roles/storage.objectAdmin --quiet --format=none
gcloud projects add-iam-policy-binding "$project" \
    --member="serviceAccount:$copy_account" --role=roles/logging.logWriter \
    --condition=None --quiet --format=none

existing_network=$(gcloud compute networks list --project="$project" \
    --filter="name=$network" --format='value(name)')
if [[ -z "$existing_network" ]]; then
    gcloud compute networks create "$network" --project="$project" --subnet-mode=custom --quiet
fi
existing_subnet=$(gcloud compute networks subnets list --project="$project" \
    --regions="$region" --filter="name=$subnet" --format='value(name)')
if [[ -z "$existing_subnet" ]]; then
    gcloud compute networks subnets create "$subnet" --project="$project" --region="$region" \
        --network="$network" --range="$subnet_range" --enable-private-ip-google-access --quiet
fi
actual_network=$(gcloud compute networks subnets describe "$subnet" --project="$project" \
    --region="$region" --format='value(network.basename())')
actual_range=$(gcloud compute networks subnets describe "$subnet" --project="$project" \
    --region="$region" --format='value(ipCidrRange)')
if [[ "$actual_network" != "$network" || "$actual_range" != "$subnet_range" ]]; then
    echo "Existing Gemma subnet does not match this setup." >&2
    exit 1
fi
gcloud compute networks subnets update "$subnet" --project="$project" --region="$region" \
    --enable-private-ip-google-access --quiet

echo "Caching Gemma 4 31B weights in Cloud Storage. This can take several minutes."
gcloud builds submit --project="$project" --region="$region" --no-source \
    --service-account="projects/$project/serviceAccounts/$copy_account" \
    --config="$script_directory/../cloudbuild.gemma-model.yaml" \
    --substitutions="_MODEL_BUCKET=$bucket" --quiet

container_args=(
    "serve" "gs://$bucket/gemma-4-31B-it"
    "--served-model-name=$model"
    "--load-format=runai_streamer"
    "--dtype=bfloat16" "--quantization=fp8" "--kv-cache-dtype=fp8"
    "--max-model-len=16384" "--max-num-seqs=4"
    "--gpu-memory-utilization=0.90" "--tensor-parallel-size=1"
    "--enable-chunked-prefill" "--enable-prefix-caching"
    "--reasoning-parser=gemma4" "--generation-config=auto"
    "--host=0.0.0.0" "--port=8080"
)
container_args_csv=$(IFS=,; printf '%s' "${container_args[*]}")

echo "Deploying a private Gemma service with one RTX PRO 6000 GPU, 20 CPUs, and 80 GiB RAM."
gcloud beta run deploy "$service" --project="$project" --region="$region" \
    --image=us-docker.pkg.dev/vertex-ai/vertex-vision-model-garden-dockers/pytorch-vllm-serve:gemma4 \
    --service-account="$runtime_account" --execution-environment=gen2 \
    --no-allow-unauthenticated --invoker-iam-check \
    --cpu=20 --memory=80Gi --gpu=1 --gpu-type=nvidia-rtx-pro-6000 \
    --no-gpu-zonal-redundancy --no-cpu-throttling \
    --min=0 --min-instances=0 --max=1 --max-instances=1 --concurrency=4 \
    --network="$network" --subnet="$subnet" --vpc-egress=all-traffic \
    --update-env-vars="GOOGLE_CLOUD_PROJECT=$project,GOOGLE_CLOUD_REGION=$region" \
    --port=8080 --timeout=900 \
    --startup-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=120 \
    --command=vllm --args="$container_args_csv" --quiet

gcloud run services add-iam-policy-binding "$service" --project="$project" --region="$region" \
    --member="serviceAccount:$app_account" --role=roles/run.invoker --quiet --format=none

service_url=$(gcloud run services describe "$service" --project="$project" \
    --region="$region" --format='value(status.url)')

# Test the same JavaScript adapter used by the backend before changing its URL.
# The short-lived identity token stays in the child environment, not source or logs.
echo "Checking authenticated inference and the five-bullet response format."
identity_token=$(gcloud auth print-identity-token)
GEMMA_URL="$service_url" GEMMA_MODEL="$model" \
    GEMMA_ID_TOKEN="$identity_token" \
    node "$script_directory/check-gemma.js"
unset identity_token

gcloud run services update "$app_service" --project="$project" --region="$app_region" \
    --update-env-vars="GEMMA_URL=$service_url,GEMMA_MODEL=$model" --quiet

echo "Gemma is ready: $service_url"
echo "The SFHACKS service can invoke it with its service identity."
echo "Inference scales to zero when idle. Model storage remains billed."
