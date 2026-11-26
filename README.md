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
- Viewer pieces as before: `worker.ts` builds ephemeris chunks outward from J2000;
  `frames.ts`, `paths.ts`, `scene.ts`, `labels.ts`, `hud.ts`, `camera.ts`, `time.ts`.

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
