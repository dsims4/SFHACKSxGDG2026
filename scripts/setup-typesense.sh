#!/usr/bin/env bash
# Run from Google Cloud Shell. This creates a billed VM, disks, and external IP.
set +x
set -euo pipefail

project="sfsu-hackathon-2026"
region="us-west2"
zone="us-west2-c"
service="sfhacksxgdg2026-git"
instance="sfhacksxgdg2026-typesense"
network="sfhacksxgdg2026-search"
subnet="sfhacksxgdg2026-search-us-west2"
subnet_range="10.89.0.0/24"
address="10.89.0.10"
disk="sfhacksxgdg2026-typesense-data"
api_key_secret="sfhacksxgdg2026-typesense-key"
vm_account="sfhacks-typesense@$project.iam.gserviceaccount.com"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

command -v gcloud >/dev/null
command -v openssl >/dev/null
[[ -f "$script_directory/typesense-startup.sh" ]]

gcloud services enable compute.googleapis.com secretmanager.googleapis.com \
    iam.googleapis.com iap.googleapis.com run.googleapis.com --project="$project" --quiet

# Read the existing app identity before creating resources.
runtime_account=$(gcloud run services describe "$service" --project="$project" \
    --region="$region" --format='value(spec.template.spec.serviceAccountName)')
if [[ -z "$runtime_account" ]]; then
    project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
    runtime_account="${project_number}-compute@developer.gserviceaccount.com"
fi

existing_account=$(gcloud iam service-accounts list --project="$project" \
    --filter="email=$vm_account" --format='value(email)')
if [[ -z "$existing_account" ]]; then
    gcloud iam service-accounts create sfhacks-typesense --project="$project" \
        --display-name="SFHACKS Typesense secret access" --quiet
fi

existing_secret=$(gcloud secrets list --project="$project" \
    --filter="name~'/$api_key_secret$'" --format='value(name)')
if [[ -z "$existing_secret" ]]; then
    # Never print the key, store it in Git, or include it in VM metadata.
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$api_key_secret" \
        --project="$project" --replication-policy=automatic --data-file=- --quiet
fi
for account in "$vm_account" "$runtime_account"; do
    gcloud secrets add-iam-policy-binding "$api_key_secret" --project="$project" \
        --member="serviceAccount:$account" --role=roles/secretmanager.secretAccessor \
        --quiet --format=none
done

existing_network=$(gcloud compute networks list --project="$project" \
    --filter="name=$network" --format='value(name)')
if [[ -z "$existing_network" ]]; then
    gcloud compute networks create "$network" --project="$project" \
        --subnet-mode=custom --quiet
fi
existing_subnet=$(gcloud compute networks subnets list --project="$project" \
    --regions="$region" --filter="name=$subnet" --format='value(name)')
if [[ -z "$existing_subnet" ]]; then
    gcloud compute networks subnets create "$subnet" --project="$project" \
        --network="$network" --region="$region" --range="$subnet_range" \
        --enable-private-ip-google-access --quiet
fi
actual_range=$(gcloud compute networks subnets describe "$subnet" --project="$project" \
    --region="$region" --format='value(ipCidrRange)')
actual_network=$(gcloud compute networks subnets describe "$subnet" --project="$project" \
    --region="$region" --format='value(network.basename())')
if [[ "$actual_range" != "$subnet_range" || "$actual_network" != "$network" ]]; then
    echo "Existing search subnet does not match the expected network and range." >&2
    exit 1
fi

# Direct VPC egress uses this subnet as its source. No public search ingress.
search_rule="sfhacksxgdg2026-typesense-private"
existing_rule=$(gcloud compute firewall-rules list --project="$project" \
    --filter="name=$search_rule" --format='value(name)')
if [[ -z "$existing_rule" ]]; then
    gcloud compute firewall-rules create "$search_rule" --project="$project" \
        --network="$network" --allow=tcp:8108 --source-ranges="$subnet_range" \
        --target-tags=sfhacks-typesense --quiet
fi
ssh_rule="sfhacksxgdg2026-typesense-iap"
existing_rule=$(gcloud compute firewall-rules list --project="$project" \
    --filter="name=$ssh_rule" --format='value(name)')
if [[ -z "$existing_rule" ]]; then
    gcloud compute firewall-rules create "$ssh_rule" --project="$project" \
        --network="$network" --allow=tcp:22 --source-ranges=35.235.240.0/20 \
        --target-tags=sfhacks-typesense --quiet
fi

existing_disk=$(gcloud compute disks list --project="$project" \
    --filter="name=$disk AND zone:$zone" --format='value(name)')
if [[ -z "$existing_disk" ]]; then
    gcloud compute disks create "$disk" --project="$project" --zone="$zone" \
        --type=pd-balanced --size=20GB --quiet
fi
existing_instance=$(gcloud compute instances list --project="$project" \
    --filter="name=$instance AND zone:$zone" --format='value(name)')
if [[ -z "$existing_instance" ]]; then
    # COS already provides Docker; no package installation is needed.
    gcloud compute instances create "$instance" --project="$project" --zone="$zone" \
        --machine-type=e2-standard-2 --image-family=cos-stable --image-project=cos-cloud \
        --boot-disk-size=10GB --boot-disk-type=pd-balanced \
        --network="$network" --subnet="$subnet" --private-network-ip="$address" \
        --tags=sfhacks-typesense --service-account="$vm_account" --scopes=cloud-platform \
        --disk="name=$disk,device-name=typesense-data,mode=rw,boot=no,auto-delete=no" \
        --metadata-from-file="startup-script=$script_directory/typesense-startup.sh" --quiet
else
    actual_address=$(gcloud compute instances describe "$instance" --project="$project" \
        --zone="$zone" --format='value(networkInterfaces[0].networkIP)')
    actual_account=$(gcloud compute instances describe "$instance" --project="$project" \
        --zone="$zone" --format='value(serviceAccounts[0].email)')
    attached_disk=$(gcloud compute instances describe "$instance" --project="$project" \
        --zone="$zone" --flatten=disks --filter='disks.deviceName=typesense-data' \
        --format='value(disks.source.basename())')
    if [[ "$actual_address" != "$address" || "$actual_account" != "$vm_account" || "$attached_disk" != "$disk" ]]; then
        echo "Existing Typesense VM does not match this setup. No VM settings were changed." >&2
        exit 1
    fi
    status=$(gcloud compute instances describe "$instance" --project="$project" \
        --zone="$zone" --format='value(status)')
    if [[ "$status" == TERMINATED ]]; then
        gcloud compute instances start "$instance" --project="$project" --zone="$zone" --quiet
    fi
fi

echo "Waiting for Typesense startup. The first image download can take several minutes."
healthy=false
for attempt in {1..20}; do
    if gcloud compute ssh "$instance" --project="$project" --zone="$zone" \
        --tunnel-through-iap --quiet --ssh-flag='-o ConnectTimeout=10' \
        --command='curl -fsS --max-time 5 http://127.0.0.1:8108/health' \
        2>/dev/null | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
        healthy=true
        break
    fi
    sleep 15
done
if [[ "$healthy" != true ]]; then
    echo "Typesense readiness could not be verified; Cloud Run settings were not changed." >&2
    echo "Check IAP SSH permissions and VM logs using the commands in README.md, then rerun this script." >&2
    exit 1
fi

gcloud run services update "$service" --project="$project" --region="$region" \
    --network="$network" --subnet="$subnet" --vpc-egress=private-ranges-only \
    --update-env-vars="TYPESENSE_URL=http://$address:8108,TYPESENSE_COLLECTION=timeline_entries,RSS_ENABLED=true" \
    --update-secrets="TYPESENSE_API_KEY=$api_key_secret:latest" --quiet

echo "Typesense is healthy at http://$address:8108 on the private search network."
echo "Cloud Run is configured to index RSS stories; cloudbuild.yaml preserves these settings on redeploy."
