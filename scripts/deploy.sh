#!/usr/bin/env bash
# Build and publish the site to the bucket/distribution created by infra/site.yaml.
#
# Usage: AWS_PROFILE=<profile> scripts/deploy.sh <stack-name>
#   (or set STACK_NAME instead of passing an argument)
# Nothing account-specific lives here: bucket and distribution come from the stack outputs.
set -euo pipefail

STACK_NAME="${1:-${STACK_NAME:-}}"
if [[ -z "$STACK_NAME" ]]; then
  echo "usage: AWS_PROFILE=<profile> $0 <stack-name>" >&2
  exit 2
fi
# Credentials: a named profile, or (CI, GitHub OIDC) temporary keys already in the environment.
if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_SESSION_TOKEN:-}" ]]; then
  echo "AWS_PROFILE is not set (and no temporary credentials in the environment)" >&2
  exit 2
fi
export AWS_REGION=us-east-1

cd "$(dirname "$0")/.."

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(output BucketName)"
DISTRIBUTION="$(output DistributionId)"
if [[ -z "$BUCKET" || "$BUCKET" == None || -z "$DISTRIBUTION" || "$DISTRIBUTION" == None ]]; then
  echo "could not read BucketName/DistributionId from stack $STACK_NAME" >&2
  exit 1
fi

pnpm build

IMMUTABLE="public, max-age=31536000, immutable"
REVALIDATE="public, max-age=0, must-revalidate"

# 1. Hashed assets first, so a new index.html never points at files not yet uploaded.
#    Content types are explicit rather than left to the CLI's guess (workers are .js;
#    WASM must be application/wasm for instantiateStreaming).
aws s3 sync dist/assets "s3://$BUCKET/assets" --exclude '*' --include '*.js' --include '*.mjs' \
  --content-type 'text/javascript; charset=utf-8' --cache-control "$IMMUTABLE"
aws s3 sync dist/assets "s3://$BUCKET/assets" --exclude '*' --include '*.wasm' \
  --content-type 'application/wasm' --cache-control "$IMMUTABLE"
# Planet textures (content-hashed by Vite): explicit image/webp, since the CLI's guess
# depends on the local mimetypes table and can fall back to binary/octet-stream.
aws s3 sync dist/assets "s3://$BUCKET/assets" --exclude '*' --include '*.webp' \
  --content-type 'image/webp' --cache-control "$IMMUTABLE"
aws s3 sync dist/assets "s3://$BUCKET/assets" --exclude '*.js' --exclude '*.mjs' --exclude '*.wasm' --exclude '*.webp' \
  --cache-control "$IMMUTABLE"

# 2. Everything else (index.html and any unhashed public/ files): always revalidate.
aws s3 sync dist "s3://$BUCKET" --exclude 'assets/*' --cache-control "$REVALIDATE"

# 3. Remove files no longer in the build. Old hashed assets are deleted too; a client
#    holding a stale index.html for longer than this window would 404, acceptable here.
aws s3 sync dist "s3://$BUCKET" --delete

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/' '/index.html' --query 'Invalidation.Id' --output text

echo "Deployed to s3://$BUCKET via distribution $DISTRIBUTION"
