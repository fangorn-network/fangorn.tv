set -euo pipefail

PROJECT=$(gcloud config get-value project)
IMG=us-central1-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/sond3r:publisher

# Where the attestation log lives, because the container filesystem does not
# survive a cold start and losing it re-asks every publisher to sign the terms.
# Bucket names are globally unique, hence the project prefix. Idempotent: an
# existing bucket is kept.
STATE_BUCKET=${STATE_BUCKET:-$PROJECT-sond3r-state}
gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$STATE_BUCKET" --location us-central1 --uniform-bucket-level-access

# The mount is done by the runtime service account, not by you — without this the
# revision fails to start rather than starting without the volume.
SA=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null

pnpm build                      # dist/ first — the Dockerfile does not build it
docker build -t $IMG .
gcloud auth configure-docker us-central1-docker.pkg.dev -q
docker push $IMG

# The service key is a real secret: Secret Manager, not --set-env-vars.
# printf '%s' "$YOUR_KEY" | gcloud secrets create sond3r-service-key --data-file=-

# printf '%s' "0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb" | gcloud secrets create sond3r-service-key --data-file=-
# gcloud secrets add-iam-policy-binding sond3r-service-key \
#   --member="serviceAccount:$(gcloud projects describe $(gcloud config get-value project) \
#     --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
#   --role=roles/secretmanager.secretAccessor

# The one access worker every publisher on this relay uploads to. Deploy it from
# ../webworker/fangorn-access-worker and give it UPLOAD_HMAC_SECRET =
# keccak256(utf8("sond3r:upload-token:" + <the service key above>)) — without
# that secret it refuses every upload, and with the wrong one every publish 401s.
WORKER_URL="https://fangorn-access-worker.fangorn-0be.workers.dev"

gcloud run deploy sond3r \
  --image $IMG --region us-central1 --allow-unauthenticated --port 8787 \
  --memory 512Mi --cpu 1 --max-instances 1 \
  --set-secrets ETH_PRIVATE_KEY=sond3r-service-key:latest \
  --add-volume=name=state,type=cloud-storage,bucket=$STATE_BUCKET \
  --add-volume-mount=volume=state,mount-path=/state \
  --set-env-vars ATTESTATION_LOG=/state/attestations.jsonl,READ_ONLY=0,WORKER_URL=https://fangorn-access-worker.fangorn-0be.workers.dev,FACILITATOR_URL=https://facilitator.fangorn.network,PUBLIC_FACILITATOR_URL=https://facilitator.fangorn.network,SETTLEMENT_REGISTRY_ADDR=0x480d54411d77820701fd80f42b81fb6e20176d12,PINATA_GATEWAY=green-reasonable-heron-957.mypinata.cloud,APP=sond3r.test.1,QUICKBEAM_URL=https://quickbeam-registry.quickbeam.workers.dev/q/qb_7a784923_sond3r-test-1-dev/stream,CHAIN_RPC_URL=https://arbitrum-sepolia.gateway.tenderly.co,FANGORN_LOG_WINDOW=1000000000
