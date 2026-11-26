# sendit

A browser game about planning interplanetary flybys with real N-body physics.
Mission replays must give bit-identical results in every browser, so the physics
uses only exactly-rounded floating-point operations.

The site has two pages:

- `index.html`: the 3D solar-system viewer (future mission-planning map view). Physics
  runs in a Web Worker; see `src/app/` below.
- `check.html`: the cross-browser determinism diagnostic. It runs the canonical scenario
  (`src/fixtures/determinism.ts`) in a Web Worker and reports PASS only if all seven
  final state components match the stored Float64 bits.

## Viewer (`src/app/`)

- `physics.ts` is the only module that imports `src/physics`. It wraps
  `ChebyshevEphemeris` so the main thread can only evaluate installed chunks (never build).
- `worker.ts` builds ephemeris chunks one at a time, outward from the epoch (order from
  `schedule.ts`), transfers each to the main thread, and propagates the demo spacecraft
  (`mission.ts`: LEO parking orbit, finite TLI burn, ten-day coast).
- `frames.ts`: plotting frames (barycentric, body-centred inertial, body-centred rotating),
  pure and unit-tested. `paths.ts` turns body paths and trajectories into frame coordinates.
- `scene.ts` (three.js): positions in float64 on the CPU, rendered relative to the camera,
  logarithmic depth buffer. `labels.ts`: DOM labels and markers for small bodies.
- `store.ts` (UI state), `hud.ts` (plain-DOM controls), `camera.ts`, `time.ts` (TDB/UTC).

Dates are shown in TDB (the ephemeris time scale) with UTC alongside, derived via the
leap-second table in `time.ts` and marked as a prediction beyond it.

Keys: Space pauses, `,` and `.` change warp. The URL hash can set the initial view, e.g.
`#t=2027-01-14T18:00&frame=rot:earth:moon&focus=earth&dist=1.3e9&paused=1`
(`frame` is `bary`, `in:<body>` or `rot:<centre>:<fixed body>`; `focus=sc` is the spacecraft).

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
