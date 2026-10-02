#!/usr/bin/env bash
# Compute Engine startup script for a Container-Optimized OS VM.
set +x
set -euo pipefail
umask 077

device="/dev/disk/by-id/google-typesense-data"
data_directory="/mnt/disks/typesense"

for attempt in {1..30}; do
    [[ -b "$device" ]] && break
    sleep 2
done
[[ -b "$device" ]]
mkdir -p "$data_directory" /var/lib/typesense /run/typesense

if ! mountpoint -q "$data_directory"; then
    # Format only an empty disk. Preserve an existing ext4 filesystem on reruns.
    set +e
    signature=$(blkid -p -o export "$device" 2>/dev/null)
    signature_status=$?
    set -e
    if [[ "$signature_status" == 2 && -z "$signature" ]]; then
        mkfs.ext4 -F "$device"
    elif [[ "$signature_status" != 0 || "$signature" != *"TYPE=ext4"* ]]; then
        echo "Typesense disk is not empty or ext4; refusing to format it." >&2
        exit 1
    fi
    mount -o defaults,discard "$device" "$data_directory"
fi

cat > /var/lib/typesense/start.sh <<'START_SCRIPT'
#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

project=$(curl -fsS --retry 5 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/project/project-id)
mkdir -p /run/typesense

# The SDK uses the VM's attached service account. No credential is in metadata.
# Keep the key in /run (memory), outside the persistent search data directory.
docker run --rm --network=host --user=0 \
    --volume=/run/typesense:/secrets \
    --entrypoint=bash gcr.io/google.com/cloudsdktool/google-cloud-cli:slim \
    -c 'set +x; set -euo pipefail; umask 077
        key=$(gcloud secrets versions access latest --project="$1" \
            --secret=sfhacksxgdg2026-typesense-key)
        [[ "$key" =~ ^[[:xdigit:]]{64}$ ]]
        printf "TYPESENSE_API_KEY=%s\n" "$key" > /secrets/typesense.env' \
    typesense-secret "$project"

exec docker run --rm --name=sfhacks-typesense --network=host \
    --env-file=/run/typesense/typesense.env \
    --volume=/mnt/disks/typesense:/data \
    typesense/typesense:27.1 --data-dir=/data --api-port=8108
START_SCRIPT
chmod 700 /var/lib/typesense/start.sh

cat > /etc/systemd/system/sfhacks-typesense.service <<'UNIT'
[Unit]
Description=SFHACKS Typesense search server
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/bin/bash /var/lib/typesense/start.sh
ExecStop=-/usr/bin/docker stop -t 30 sfhacks-typesense
Restart=always
RestartSec=15
TimeoutStartSec=0
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable sfhacks-typesense.service
systemctl restart sfhacks-typesense.service
