#!/usr/bin/env bash
# Build the leaderboard Lambda bundle, upload it, and deploy infra/leaderboard.yaml.
#
# Usage:
#   AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<bucket> \
#     [IP_HASH_SALT=<secret>] [EXPOSE_PLANS=false|true] \
#     scripts/deploy-leaderboard.sh <leaderboard-stack>
#
# Nothing account-specific lives here: the distribution id comes from the site
# stack's outputs, the bucket and salt from the environment. IP_HASH_SALT is
# required on the first deploy; later deploys keep the stored value unless it
# is set again. The site stack itself is not changed (see README.md for the
# one-time /api/* change to infra/site.yaml).
set -euo pipefail

STACK="${1:-${LEADERBOARD_STACK:-}}"
if [[ -z "$STACK" ]]; then
  echo "usage: AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<bucket> $0 <leaderboard-stack>" >&2
  exit 2
fi
for v in SITE_STACK ARTIFACT_BUCKET; do
  if [[ -z "${!v:-}" ]]; then echo "$v is not set" >&2; exit 2; fi
done
# Credentials: a named profile, or (CI, GitHub OIDC) temporary keys already in the environment.
if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_SESSION_TOKEN:-}" ]]; then
  echo "AWS_PROFILE is not set (and no temporary credentials in the environment)" >&2
  exit 2
fi
export AWS_REGION=us-east-1

cd "$(dirname "$0")/.."

output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
DISTRIBUTION="$(output "$SITE_STACK" DistributionId)"
if [[ -z "$DISTRIBUTION" || "$DISTRIBUTION" == None ]]; then
  echo "could not read DistributionId from stack $SITE_STACK" >&2
  exit 1
fi

# SKIP_TESTS=1: the caller vouches that the unit tests already passed on this exact commit (CI does,
# before an automatic deploy) or accepts deploying without them (the workflow's skip_tests input).
if [[ "${SKIP_TESTS:-0}" != 1 ]]; then pnpm test; fi
pnpm build:leaderboard

# Zip handler + its chunks + checkpoint asset (no bench / admin entry points). Fixed mtimes: same build, same zip, same key.
OUT=dist-server/leaderboard
ZIP="$(pwd)/dist-server/leaderboard.zip"
rm -f "$ZIP"
FILES=(checkpoints.bin)
for f in "$OUT"/*.mjs "$OUT"/*.mjs.map; do
  f="$(basename "$f")"
  case "$f" in bench.mjs | admin.mjs | bench.mjs.map | admin.mjs.map) ;; *) FILES+=("$f") ;; esac
done
(cd "$OUT" && touch -t 200001010000 "${FILES[@]}" && zip -q -X "$ZIP" "${FILES[@]}")
HASH="$(shasum -a 256 "$ZIP" | cut -c1-16)"
KEY="leaderboard/$HASH.zip"
if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$KEY" >/dev/null 2>&1; then
  aws s3 cp "$ZIP" "s3://$ARTIFACT_BUCKET/$KEY"
fi

PARAMS=(DistributionId="$DISTRIBUTION" ArtifactBucket="$ARTIFACT_BUCKET" ArtifactKey="$KEY")
if [[ -n "${IP_HASH_SALT:-}" ]]; then PARAMS+=(IpHashSalt="$IP_HASH_SALT"); fi
if [[ -n "${EXPOSE_PLANS:-}" ]]; then PARAMS+=(ExposePlans="$EXPOSE_PLANS"); fi

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/leaderboard.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMS[@]}"

echo "Leaderboard stack $STACK deployed with bundle s3://$ARTIFACT_BUCKET/$KEY"
echo "Site stack origins (first time only, after applying infra/site-leaderboard.patch):"
echo "  LeaderboardSubmitOrigin=$(output "$STACK" SubmitOriginDomain)"
echo "  LeaderboardReadOrigin=$(output "$STACK" ReadOriginDomain)"
