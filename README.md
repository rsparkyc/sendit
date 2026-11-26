# sendit

A browser game about planning interplanetary flybys with real N-body physics.
Mission replays must give bit-identical results in every browser, so the physics
uses only exactly-rounded floating-point operations.

The site has two pages:

- `index.html`: the flight-plan editor on the 3D solar-system view. Physics runs in Web
  Workers; see `src/app/` below.
- `check.html`: the cross-browser determinism diagnostic. It runs the canonical scenario
  (`src/fixtures/determinism.ts`) in a Web Worker and reports PASS only if all seven
  final state components match the stored Float64 bits.

## Flight-plan editor (`src/app/`)

The main page is the game's core loop: an editable mission plan, replayed live.

- **The plan is the source of truth.** Editor state is a `MissionPlan` (src/mission/plan.ts)
  in the one store (`store.ts`). Every edit makes a new plan; `replay-client.ts` sends it
  (debounced, newest wins, a long run is cancelled by terminating the worker) to
  `replay-worker.ts`, which flies it with the mission layer's `replay` (the scoring path)
  using the canonical options in `replay-options.ts`, evaluates the mission's objectives,
  and returns trajectory samples taken from inside that same replay. Nothing else
  computes a displayed trajectory. Long flights get a preview first: the same replay cut
  short (an exact prefix of the flight), then the full one.
- **Adapters.** `physics.ts` is the only module that imports `src/physics`;
  `mission-layer.ts` is the only one that imports `src/mission`.
- **Nodes** (`nodes.ts`, pure): a maneuver node (time, prograde/normal/radial delta-v
  relative to a reference body, engine) is a view of a real finite `PlanBurn`: duration
  from the rocket equation with the mass at that point, centred on the node time.
  Edits keep earlier burns bit-identical and later nodes' requested delta-v.
- **Missions** (`missions.ts`): sandbox plus the sample missions, flown in the real
  ephemeris world with their objectives and limits, starting with no burns.
  `missions.test.ts` holds the author's solutions (the UI never shows them).
- **Sharing** (`share.ts`): `#m=<mission>&p=<plan>` with the plan encoder; the working
  plan is also kept in local storage. The replay digest is shown under the flight panel.
- Panels: `editor-ui.ts` (plain DOM, built once and updated in place from the store;
  helpers in `dom.ts`), events filtering in `events-view.ts`, editing actions in `editor.ts`.
- **Planner** (`planner-ui.ts`, a full-window mode opened from the nodes panel):
  porkchop heatmap (viridis, contours, Type I/II boundary, real-date axes; tap, drag or
  hover to read, release to select), launch opportunities into a plane containing the
  departure asymptote, an inserted departure node, refinement by the differential
  corrector, "Target flyby" on any burn, and a flyby-chain plausibility check. Work runs in
  `planner-worker.ts` (logic in `planner-core.ts`, pure helpers in `transfer.ts` and
  `porkchop-view.ts`); `planning-layer.ts` is the only module that imports `src/planning`.
  Everything it changes is an ordinary node; reported closest approaches come from the
  scoring replay.
- **Ephemeris scheduling**: a small pool of `worker.ts` workers (`chunk-pool.ts`, sized from
  `hardwareConcurrency`) builds chunks from the checkpoint asset, any date 1950-2100,
  in parallel; `schedule.ts` (pure) picks the view chunk, coverage requests from the
  planner, warp look-ahead, neighbours, the flight span and a small prefetch, and evicts
  the chunks farthest from the view under a memory budget (smaller on small devices).
- Missions: the campaign from `src/mission/campaign.ts` plus Sandbox; a mission fixes the
  spacecraft and start rules (`checkPlanConformance`); a loaded plan that does not conform
  opens in Sandbox with a notice.
- Viewer pieces: `frames.ts`, `paths.ts`, `scene.ts`, `labels.ts`, `hud.ts`, `camera.ts`, `time.ts`.

Keys: Space pauses, `,` and `.` change warp. With a node selected: W/S prograde, D/A
normal, E/Q radial (Shift x10, Alt x0.1 of the step), `[` `]` move it in time, Delete
removes it, N adds a node at the time cursor. Clicking the trajectory adds a node there.
The URL hash may also set the initial view, e.g. `#frame=rot:earth:moon&focus=earth&dist=1.3e9`.

## Develop

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm dev         # Vite dev server
pnpm build       # static site in dist/
pnpm preview     # serve dist/ locally
```

## Hosting

`infra/site.yaml` creates a private S3 bucket, a CloudFront distribution (Origin
Access Control, HTTPS only, HTTP/2 and HTTP/3), a DNS-validated ACM certificate and
alias records. It must be deployed in us-east-1, into an account that owns the
Route 53 hosted zone for the domain.

```sh
aws cloudformation deploy \
  --profile <profile> --region us-east-1 \
  --stack-name <stack-name> \
  --template-file infra/site.yaml \
  --parameter-overrides DomainName=<site.example.com> HostedZoneId=<hosted-zone-id>
```

Creation waits on certificate validation and CloudFront propagation (often 5 to 30 minutes).

Deploy the site:

```sh
AWS_PROFILE=<profile> scripts/deploy.sh <stack-name>
```

The script builds, uploads hashed files under `/assets/` with
`Cache-Control: public, max-age=31536000, immutable`, uploads everything else
(including `index.html` and `check.html`) with `max-age=0, must-revalidate`, deletes
files no longer in the build, and invalidates `/` and `/index.html`. Both HTML files are
revalidated on every request, so `check.html` needs no invalidation of its own unless an
older copy without revalidation headers is cached.

## Leaderboard (`server/leaderboard/`, `src/leaderboard/`, `infra/leaderboard.yaml`)

Per mission version, three boards: combined score, delta-v, time. The server never trusts a
result: it decodes the submitted plan strictly, checks it against the mission (the mission
layer's `checkPlanConformance` plus server limits), re-flies it with the real ephemeris and
scores it with the mission layer's quantised keys. API shapes: `src/leaderboard/api.ts`.
Browser client: `src/leaderboard/client.ts`; import it dynamically when needed.

Two Lambda functions run one bundle: `submit` (replays; low reserved concurrency) and
`read` (boards, own rank). Their function URLs accept only the site's CloudFront
distribution (origin access control), which serves them under `/api/*` on the site
origin, so the browser needs no CORS.

### First deployment

```sh
# 0. Once: a private bucket for Lambda bundles (any name), and a salt for IP hashing.
aws s3api create-bucket --profile <profile> --region us-east-1 --bucket <artifact-bucket>
aws s3api put-public-access-block --profile <profile> --bucket <artifact-bucket> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 1. Leaderboard stack (reads the distribution id from the site stack).
AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<artifact-bucket> \
  IP_HASH_SALT="$(openssl rand -hex 32)" scripts/deploy-leaderboard.sh <leaderboard-stack>

# 2. Route /api/* through the site's distribution (once): apply the reviewed change,
#    then update the site stack with the two origins the script printed.
git apply infra/site-leaderboard.patch
aws cloudformation deploy --profile <profile> --region us-east-1 \
  --stack-name <site-stack> --template-file infra/site.yaml \
  --parameter-overrides DomainName=<site.example.com> HostedZoneId=<hosted-zone-id> \
    LeaderboardSubmitOrigin=<submit-origin-domain> LeaderboardReadOrigin=<read-origin-domain>
```

Later code updates: step 1 only (the salt is kept). Leaving both origin parameters empty
deploys the site stack exactly as before.

### Operations

`pnpm build:leaderboard` also builds `dist-server/leaderboard/admin.mjs`, run locally with
the operator's credentials (`eval "$(aws configure export-credentials --profile <profile> --format env)"`
and `TABLE_NAME=<table>` from the stack outputs):

- `node dist-server/leaderboard/admin.mjs missions` lists mission versions and the physics version.
- `... show|hide|unhide --mission <id> --version <v> --pid <pid>` inspects or hides an entry
  (a hidden entry leaves every board and stays hidden when the player submits again).
- `... reverify --mission <id> [--from <old-version>] [--dry-run] [--force]` re-flies stored plans.

Re-verification. Boards show only entries verified under the server's current physics
version (`PHYSICS_MODEL` plus the world data fingerprint) and the current mission version,
because both are part of the board key. When a change alters replay results (the golden
digests in `test/mission-replay-api.test.ts` change, so `PHYSICS_MODEL` or the data
fingerprint changes) or a mission's `version` is bumped:

1. Deploy the new bundle (step 1). The affected boards are empty from that moment, and
   plans made with the old build are refused with `version-mismatch`.
2. With the same build, run `admin.mjs reverify --mission <id>` for every mission (for a
   new mission version, add `--from <old-version>`). Use `--dry-run` first to see what would change.
   Entries whose plans still succeed come back with recomputed values and their original
   submission times; the others are kept but marked invalid, with the reason.
3. Run it again until it reports `written: 0` (an entry that changed while it was being
   re-verified is retried on the next run).
