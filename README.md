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

## Force model (`src/physics/`, `PHYSICS_MODEL` 2)

Massive bodies (`nbody.ts`, Kahan-Li 8th-order symmetric composition, step 1/32 d):
the Sun, Mercury, Venus, Earth, the Moon, the Mars system barycenter, Jupiter, Saturn,
Uranus, Neptune, Pluto, and 18 moons: Io, Europa, Ganymede, Callisto; Tethys, Dione,
Rhea, Titan, Iapetus, Mimas, Enceladus; Ariel, Umbriel, Titania, Oberon, Miranda;
Triton; Charon. Bodies are looked up by id (`bodyIndex`), not by array position.
Initial states and GMs come from DE440/DE441 and the JPL satellite ephemerides, via
`scripts/fetch-horizons.py`. Forces:

- Newtonian point masses.
- The Sun's 1PN term, with its reaction.
- J2 (and J4) of selected bodies on selected others, with the reaction.
- Saturn J3..J8 and Jupiter J3..J6 on their moons.

The spacecraft (`spacecraft.ts`, DOP853) feels these fields:

| Body | Field | Source |
|---|---|---|
| Sun | J2 | DE440 |
| Earth | J2..J4, plus C/S through degree 4 | DE440 zonals; EGM2008 tide-free, rescaled to DE440 |
| Moon | J2..J4, plus C/S through degree 4 | DE440, principal-axis frame |
| Mars, Jupiter, Saturn | J2..J9 | mar099, jup365, sat441 |
| Uranus, Neptune | J2, J4, J6 | ura184, nep098 |

Uranus rotates retrograde, so only its even zonals are used.

- **Orientation.** Fields turn with each body's time-dependent IAU pole, taken from
  pck00011 (`orientation.ts`).
- **Body-fixed frames.** These use the IAU prime meridian, including the Moon's
  libration terms. Earth instead uses the Earth Rotation Angle with Delta-T
  (`earth-rotation.ts`); the launch code uses the same definition.
- **J2** acts at any distance.
- **Terms above J2** are multiplied by a taper: exactly 1 inside an inner radius, a C2
  quintic step, and exactly 0 (skipped) beyond an outer radius. The radii, in body
  radii, are Earth 114–143, Moon 136–170, Mars 55–69, Jupiter 66–83, Saturn 62–78,
  Uranus 35–44 and Neptune 36–45. The inner radius is where the largest discarded
  acceleration falls to 1e-12 m/s².

Left out on purpose:

- **Higher degrees for Earth and the Moon.** Degree 4 leaves 100–140 km after 30 days
  in LEO or low lunar orbit, compared with degree 8 (Earth) and degree 6 (Moon).
- **Earth J3/J4 and Earth's tesserals on the Moon, and Moon J3/J4 on Earth.** Each is
  under 50 m per century.
- **The Moon's C22 and higher terms between Earth and the Moon.** They move the Moon
  by 100–200 km per century. However, with the IAU libration model they made the Moon
  worse against DE441: shifting the prime meridian by 0.01° moves the Moon by 50–90 km.
- **Tides and asteroids.**

The measurements are in the header comments of `solar-system.ts` (`MASSIVE_BODY_FIELDS`)
and in `test/gravity-field.test.ts`.

## Launch vehicles and the ascent (`src/mission/plan.ts`, `ascent.ts`, `vehicles.ts`)

Not used by any mission yet. Part three switches the campaign over. Until then, every
mission, score, digest and leaderboard entry is unchanged.

**Plan format 2.** A plan can carry a staged vehicle: `lowerStages`, listed in firing
order, sit below `spacecraft`, which is the top stage. Every burn names its `stage` and
an engine of that stage. `separations` lists times at which the active stage is dropped,
along with whatever propellant it still holds. On the wire, burns and separations form
one time-ordered list of actions. At equal times a separation comes before a burn; any
other order is refused, so each plan has exactly one string. The format's limits are 6
stages, 8 engines per stage, 200 burns and 5 separations, and the decoder is fuzzed.

Plans are written in the format they carry. `makePlan` picks the lowest format that can
hold the plan (`requiredFormat`), so a one-stage plan is still format 1, byte for byte.
Every shared link and every stored leaderboard plan therefore keeps its exact string,
along with any key made from it, and an older build still opens it.

**Staging in the simulator.** The active stage is the lowest one remaining.

- A burn draws on the active stage and cuts off when that stage's tanks are empty, at
  mass = (stages above) + (its dry mass).
- At a separation the mass becomes exactly the wet mass of the stages above, which have
  never fired. The integrator restarts there, as it does at burn boundaries: there is one
  `propagate` call per stretch between separations.
- A plan without separations runs the very same single call it always did.
- A separated stage simply stops existing. It is not tracked.
- `ReplayResult.stages` reports, for each stage, the propellant used and left, the
  delta-v (rocket equation over its real mass change, with everything above it as
  payload) and the separation time.
- Validation codes: `burn-stage`, `burn-spans-separation`, `separation-last`,
  `separation-before-insertion`, `action-order`, `stages`.

**Start kinds.** A `launch` start with no `ascent` field is the free delivery to the
parking orbit, as before. `ascent: 'vehicle'` is a vehicle launch: the lower stages fly
the ascent analytically and the flight starts at insertion. The stage that reached orbit
keeps what it has left, and the spacecraft never fires during the ascent.

**Ascent model** (`ascent.ts`, header for details):

- *What it is.* A planar point-mass ascent: vertical rise, a pitch-over kick solved so
  that orbital speed is reached at the insertion altitude (at most 185 km; higher orbits
  coast up to apogee and circularise), then a gravity turn.
- *What it accounts for.*
  - Gravity, from the integrated g sin γ; the climb is reported separately.
  - Drag in an exponential atmosphere, with CdA scaling as liftoff mass^(2/3).
  - Nozzle back-pressure.
  - A steering loss where a low-thrust upper stage must hold level flight.
  - Earth's rotation. The target is |v d − v_pad|, so the along-track component helps
    and the cross-track component costs.
- *What the losses depend on.* Thrust-to-weight, target altitude and vehicle size.
- *Body data.* Constants are per body (`ASCENT_BODIES`; the Moon has no atmosphere).
- *Determinism.* It is deterministic: exact operations, `dmath`, `exactLn`, and a new
  `exactExp` built from + − × ÷ alone. Its outputs are pinned in `test/ascent.test.ts`.
  Changing the constants changes replays, so it needs a `PHYSICS_MODEL` bump.
- *Assumptions.* No winds, no throttling, no optimal steering, and one drag scale and
  one back-pressure fraction for every vehicle. Parallel boosters are given as their
  serial equivalent, and fairings are counted with stage 1.

**Validation** (`test/ascent-validation.test.ts`; cited data in
`test/fixtures/launch-performance.json`). The sources are Wikipedia figures, which are
secondary, and the stage data is approximate. The Electron's stage masses are estimated.

| Point | Published kg | Model kg | Model/published |
|---|---|---|---|
| Falcon 9 LEO 28.5° | 22 800 | 24 323 | 1.07 |
| Falcon 9 GTO | 8 300 | 9 778 | 1.18 |
| Atlas V 401 LEO 28.5° | 9 797 | 7 258 | 0.74 |
| Atlas V 401 GTO | 4 750 | 4 315 | 0.91 |
| Ariane 5 ECA GTO (Kourou) | 10 865 | 11 145 | 1.03 |
| Soyuz-2.1b Baikonur 51.6° | 8 670 | 10 730 | 1.24 |
| Soyuz-2.1b Baikonur 98° | 7 030 | 9 180 | 1.31 |
| Soyuz-2.1b Plesetsk 72° | 7 730 | 10 046 | 1.30 |
| Electron LEO / 500 km SSO | 300 / 200 | 286 / 195 | 0.95 / 0.97 |

**How well it fits.**

- *Absolute payloads.* Within −26 % to +31 %. Soyuz comes out optimistic; its fairing
  and the boosters' large sea-level thrust loss are not modelled per vehicle. Atlas comes
  out pessimistic in LEO, because its single-RL10 Centaur has very low thrust-to-weight.
- *Inclination and site trends.* Within 3–6 %:
  - Soyuz at 98° relative to 51.6°: published 0.81, model 0.86.
  - Vostochny relative to Baikonur at 51.6°: published 0.99, model 1.00.
- *Where it does not fit.*
  - The published few-percent advantage of higher-latitude sites for polar orbits is not
    reproduced.
  - The GTO/LEO ratios are off by 10–23 %. They depend on the upper stage, and possibly
    on LEO figures that are structural limits.

**Scoring quantity.** `ReplayResult.totalDeltaV` is the ascent's delivered delta-v plus
`deltaV`, the delta-v flown after insertion. The per-stage breakdown is in `stages` and
`ascent`. No mission is scored on it yet: `evaluate` still uses `deltaV`.

**Rules.** `rules.vehicle = vehicleLaunch(lowerStages, [lo, hi])` fixes the vehicle bit
for bit (`checkPlanConformance` code `vehicle`) and allows a band of parking altitudes.
The ascent time, downrange angle and circularisation stay at their defaults. A mission
without a vehicle refuses extra stages and vehicle launches. `rules.launch` /
`fixedLaunch` work as before.

**Catalogue** (`vehicles.ts`). All entries are approximations:

- Falcon 9 and Atlas V 401 (medium, two stages).
- Ariane 5 ECA (heavy, with a hydrogen upper stage).
- Soyuz-2.1b.
- Electron (small).

Use `withSpacecraft(vehicle, spacecraft)` to put a spacecraft on top. `SOLID_VEHICLES`
holds an all-solid example, Minotaur V (approximate), kept out of `VEHICLES` so the
pinned ascent cases and the payload calibration are unchanged.

### Direct injection (plan format 3, `ascent: 'direct'`)

No parking orbit: the vehicle burns from liftoff straight into the departure conic, as
a stack of solids must. It adds no constant and changes no existing code path's
arithmetic, so `PHYSICS_MODEL` is unchanged and every existing result (golden digests,
pinned fixtures, the ascent golden hash, the campaign suites) is bit-identical.

**Propulsion flags.** `Engine.restartable` and `Engine.throttleable` are optional
booleans, absent meaning true. `throttleable: false` means the engine cannot be shut down
once lit and burns to depletion (a solid). `restartable: false` means it fires once in the
whole flight, the ascent included. `SOLID` gives both flags. A plan that sets any flag to
false is format 3: format 2 plus one flag byte per engine. The rules they bring:

- A parking orbit refuses a stage that cannot shut down at orbital speed, and a
  circularisation burn (for targets above 185 km) by a stage that cannot restart.
- In flight, a non-restartable engine fires in at most one burn (`engine-restart`), and
  never again once its stage was lit in the ascent.
- A non-throttleable engine's burn must last at least the stage's full propellant divided
  by that engine's flow (`engine-throttle`).

**What the player specifies.** The start is `{ kind: 'launch', site, params, ascent:
'direct' }` with exactly five params, `[launchTime, azimuthDeg, c3, injectionAltitudeM,
flightStartS]`:

- the site, liftoff time and inertial azimuth, as for a parking orbit;
- the target C3 = v² − 2μ/r in m²/s². It is negative for an ellipse: about −2.04 km²/s²
  puts the apogee at lunar distance (`c3ForApoapsis`). It is positive for a hyperbola,
  with v∞ = √C3;
- the injection altitude, where powered flight ends (150-2 000 km);
- `flightStartS`, the declared start of the free flight. It is the earliest time of any
  burn or separation and must not come before the computed burnout (`launch-burnout`).
  It exists so that plan validation stays static. The flight itself is simulated from
  the actual burnout.

**The model** (`computeDirectAscent`). It uses the same vehicle model, atmosphere,
integrator and gravity-turn pitch program as the parking ascent. The pitch-over kick is
bisected so that powered flight ends at the injection altitude, within 5 km
(`burnout.altitudeM` reports what was reached). The stages burn in order:

- A liquid stage shuts down when the energy reaches the target (`cutoff: 'target'`).
- A solid stage passing the target burns out anyway: the energy overshoots and no later
  stage is lit.
- If every lower stage runs dry first, the flight starts from what was reached, with
  `shortfall` reporting the gap.

Above circular speed the gravity turn lifts the nose, so the vehicle injects climbing.
The flight-path angle is reported, and burnout is generally not the perigee. The time and
downrange angle at burnout come out of the integration, not the parking orbit's fixed
540 s and 13.5°. `directInjectionState` maps the burnout into ICRF with the same
`launchPlane` and Earth-orientation model as the parking orbit.

Assumptions beyond the parking model's:

- Staging is instantaneous, and there are no fixed coasts between stages.
- The pitch program has one parameter, so expect the losses to be 100-300 m/s
  pessimistic for high-energy injections.
- The burnout direction is the model's own, of order a degree from a real trajectory.
  The planning aids use this same model.

**Planning aids** (`direct-planning.ts`, advisory). `directInjectionWindows` returns the
liftoff times and azimuths at which a direct injection from a site points its apoapsis at
a body (for example the Moon at arrival) or its asymptote along a given direction, with
the aim-error growth rate. `departureGeometry` gives the conic: eccentricity, apsides,
asymptote, time to apoapsis. `directAimError`, `directAzimuthDeg`, `parkingAzimuthToward`
and `windowSpan` measure window widths.

**The trade-off** (`test/direct-comparison.test.ts`; 185 km; lunar C3 −2.04 km²/s², escape
C3 10 km²/s²; window = liftoff span with the departure within 1° of the target, or for
the parking orbit, a plane containing it with an in-corridor azimuth):

| vehicle, site | target | payload direct / parking | total Δv direct / parking | window direct / parking |
|---|---|---|---|---|
| Atlas V 401, Cape | Moon | 2 986 / 3 669 kg | 13 377 / 12 772 m/s | 9 min / 530 min |
| Atlas V 401, Cape | escape | 2 115 / 3 061 kg | 14 073 / 13 181 m/s | 10 min / 538 min |
| Falcon 9, Cape | Moon | 7 284 / 7 267 kg | 12 165 / 12 170 m/s | 10 min / 535 min |
| Minotaur V (solid), equator | Moon | 528 kg / impossible | 12 002 m/s / — | 8 min / — |
| Minotaur V (solid), equator | escape | 408 kg / impossible | 12 551 m/s / — | 12 min / — |

What the table shows:

- A low thrust-to-weight upper stage (Centaur) pays heavily for climbing while it burns:
  19-31 % less payload by direct injection. A parking orbit lets it burn horizontally at
  perigee.
- A high thrust-to-weight upper stage (Falcon 9) is indifferent: the model's parking
  route has no restart penalty.
- Solids cannot park at all.
- The direct window is minutes; the parking window is hours. This is because the
  departure direction is the site direction rotated by a fixed angle. For a short solid
  ascent that angle puts the lunar apogee almost antipodal to the site, so windows exist
  only on days when the Moon's declination is near minus the site's latitude: from Kourou,
  one in 60 days near this epoch.

Reality check:

- LADEE (Minotaur V, all solid, 2013) had daily windows of 4-15 minutes over a 5-day
  launch period.
- Surveyor 1 (1966) flew a single-burn direct ascent on Atlas-Centaur. Its window opened
  to the second, but the Surveyor direct-ascent windows were about 100 minutes (Surveyor
  B: 06:51-08:33 EDT), because the injection was retargeted (azimuth and flight time)
  through the window. The model's fixed-shape window is the lower bound of that.
- Apollo, through a parking orbit, had windows of about 4.5 h with a narrower 72-108°
  azimuth band.
- Minotaur V's published TLI capability is 342 kg; the model gives 528 kg from the
  equator (516 kg from the Cape), about 50 % high. The motor masses are approximate, and
  the published figure includes an adapter and a Wallops launch.

**Rules** (`objectives.ts`):

- `rules.launchModes` (`['parking-orbit']` when absent, so every existing mission refuses
  direct plans with `launch-mode`).
- `rules.nonRestartableVehicle` (`vehicle-restartable`).
- `VehicleLaunchRule.direct`, giving `injectionAltitude` and `c3` bands (`launch-altitude`,
  `launch-c3`).
- Vehicle and spacecraft comparisons now include the flags, so a liquid copy of a solid
  vehicle is a `vehicle` mismatch.

### Hand-off: direct injection

**UI**

- *Build.* `start: { kind: 'launch', site, params: directToParams({ mode: 'direct',
  siteId, launchTime, azimuthDeg, c3, injectionAltitudeM, flightStartS }), ascent:
  'direct' }`, then `makePlan` (it gives format 3). Test with `isDirectLaunch`; with
  `isFlownLaunch` for either vehicle launch. `isVehicleLaunch` stays parking-only, so
  `planAscent` returns null for direct plans. Add a direct branch beside it.
- *What the player edits.* Site, liftoff, azimuth, C3 (or apogee through
  `c3ForApoapsis`, or v∞), injection altitude, flight start (default: burnout rounded up,
  for example 1 500 s for Atlas, 600 s for Minotaur). Engine flags go in the sandbox
  vehicle editor.
- *Launch feedback.* `computeDirectAscent(vehicleStages(plan), { gm, radius: referenceRadius,
  c3, injectionAltitudeM }, launchGeometry(site, t, az), ASCENT_BODIES.earth)` gives
  `achievedC3`, `shortfall`, `cutoff`, `upperStage` and `upperPropellant`, `burnout`
  (time, altitude, speed, flight-path angle, downrange), `losses` and `stages`. It costs
  about the same as `computeAscent`. Show "overshoot" when `cutoff === 'depletion' &&
  achievedC3 > c3`; for solids, payload mass is what tunes the energy.
- *What to chart.*
  - The departure conic: `departureGeometry(burnout, gm, R)`.
  - The aim error against liftoff time: `directAimError` over ±30 min. It shows the
    instantaneous window.
  - The windows from `directInjectionWindows` over the coming days. Flag `converged:
    false` and `azimuthAllowed: false`.
- *After a replay.* `result.directAscent` (with `launch.t` = the burnout), `result.stages`,
  `totalDeltaV`. Validation codes: `launch-params`, `launch-c3`, `launch-altitude`,
  `launch-ascent` (flight start), `launch-burnout` (in the replay reason), `engine-flags`,
  `engine-restart`, `engine-throttle`, `stages`, `format`.
- `simulationStartOffset(start)` returns `flightStartS` for a direct plan. The trajectory
  actually starts slightly earlier, at the burnout (`result.launch.t`).

**Leaderboard server**

- Nothing is needed for decode, validate or replay. `decodePlan` reads format 3, and the
  replay and digest are shared code.
- Format-3 plans hash the burnout into the digest; formats 1 and 2 are unchanged.
- `checkRules` requires a launch start, which direct plans are.
- Before a mission allows direct injection, check `SERVER_RULES` and the plan-size limits
  (format 3 adds 1 byte per engine), and give the mission a new version. No current
  mission allows direct injection, so the deployed server refuses every direct plan with
  `launch-mode`.

### Hand-off to part three

**UI**

- *Stage list.* Use `vehicleStages(plan)` to get the stages. After a replay,
  `result.stages[k]` (a `StageReport`) gives `propellantUsed`, `propellantLeft`,
  `deltaV`, `ascentDeltaV`, `separatedAt` and `droppedInAscent`.
- *Planning before a replay.* `computeAscent(vehicleStages(plan), { gm, radius,
  altitudeM }, launchGeometry(launchSite(id), t, azimuthDeg), ASCENT_BODIES.earth)`
  returns `AscentResult`, which includes `upperStage`, `upperPropellant`, `deltaV`, the
  `losses` breakdown and `stages[]`. Call it as the player drags altitude or azimuth to
  show upper-stage propellant at insertion. It takes 5-9 ms for the catalogue vehicles
  (measured by `bench.mjs ascent`), so debounce it or run it in a worker.
- *Burns and separations.*
  - A burn needs `stage`.
  - A separation is `{ time }` in `plan.separations`.
  - `flightActions(plan)` gives the merged, time-ordered list.
  - `validatePlanIssues` and `stagingIssues(plan, firstStage)` give coded errors.
- *Plan construction.*
  - Build plans with `makePlan`, so the format is chosen for you.
  - A vehicle launch is `start: { kind: 'launch', site, params, ascent: 'vehicle' }`.
  - Check with `isVehicleLaunch(start)`.
- *Sandbox vehicle editor.* Edit `lowerStages` (start from `VEHICLES`) and `spacecraft`
  freely, subject to `LIMITS.maxStages`, `maxEngines` and `maxSeparations`.
- *Missions.* Done in part three: every campaign mission sets `rules.vehicle`, and
  `initialMissionPlan`, `launchFields` and the editor's `withLaunchRule` use its altitude
  band and `lowerStages`.

**Regenerating the campaign references.** The per-site reference solutions
(`test/fixtures/campaign-solutions.json`) and the `CAMPAIGN_SITES` table in
`src/mission/campaign-sites.ts` are written by `pnpm gen:campaign-sites` from solver logs:

```sh
mkdir -p campaign-solve-logs/solve
# One mission per process; logs are read in name order, later ones win.
SLOW=1 ONLY=geo-from-leo pnpm vitest run test/mission-campaign-sites-solve.test.ts --silent=false \
  > campaign-solve-logs/solve/geo-from-leo.log
# ...repeat for each mission (SITES=<id,id> narrows to some sites)...
pnpm gen:campaign-sites            # or: python3 scripts/gen-campaign-sites.py <logs dir>
```

The generator stores each reference's total delta-v and time in the leaderboard's quantised
units (delta-v rounded up to 0.1 m/s, time up to the whole second, exactly as `keys` quantises
them), so flying a reference scores exactly 10,000; `test/mission-campaign*.test.ts` check it.

Run one mission per process. Most take minutes; the lunar free return's per-site solver takes
about fifteen minutes. An optional `campaign-solve-logs/not-offered.json` (`{ mission: { site:
reason } }`) marks sites that are not offered. The logs directory is not committed. Changing the
references changes par and the limits, so it needs new mission versions (see the release notes).

**Leaderboard server**

- *Start kind.* `engine.ts` `checkRules` requires `start.kind === 'launch'`. Vehicle
  launches pass, because they are `launch` starts.
- *Delta-v used for scoring.* Done in part three: `evaluate` scores and keys
  `totalDeltaV`, and the server stores it.
- *New mission versions.* Done in part three. See "Release: launch vehicles" below for
  the versions, the measured sizes and the costs.
- *Integrator tolerance.* `SERVER_RULES` limits apply unchanged.
- *Physics model.* The ascent constants are part of the physics model: a change needs a
  `PHYSICS_MODEL` bump.

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
- **Layout** (`layout.ts`): one instance of every panel, the same tabs in every mode. On a
  desktop (>= 1200 x 600) a single dock on the right (27 % of the width, 360-460 px,
  resizable, collapsible to a rail of tabs, all persisted) holds the tabs: Nodes (node list,
  selected node's editor, events and the full Orbit readout, next to the map), Mission and
  Start (set once), Results and View. The orbit at the time cursor is also a one-line strip
  marked "At cursor" above the timeline; the Results panel shows the final orbit and each
  objective's evidence. Map share with a node selected (grid sample, Chromium): 1280 x 720
  59 %, 1440 x 900 62 %, 1920 x 1080 67 % (two docks before: 51 / 54 / 64 %).
- **Map colours and shapes** (`palette.ts`, with a legend next to the timeline): trajectory
  near-white ahead of the cursor and grey behind it; burns drawn thick in the colour of the
  stage that flies them (S1 magenta, S2 cyan, S3 pink, S4 lavender, spacecraft orange) with
  the stage tag written on node and ignition / cutoff markers ("B1 · S2 end") and on timeline
  spans; events blue diamonds, closest approach amber, failures red and bold, separations
  teal ✂ "S1 → S2", plane AN / DN violet triangles, launch sites green squares (the only
  green on the map). Every kind differs by shape or text as well as colour.
- **Number formats** (`numfmt.ts`): one precision per quantity. Budgets, limits and totals in
  whole m/s; a single burn's Δv to 0.1 m/s; masses in kg (t from 100 t); site names shortened
  without their parenthetical, the full name in the title and under the site selector. The
  Start panel's first line says what the launch leaves for the flight and what it costs or
  saves in ascent Δv against the mission's reference launch.
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
- **View settings** (`view-settings.ts`, `view-ui.ts`, persisted): how much is drawn after the last burn
  (auto: to the end of an escape, three revolutions of a closed orbit with the rest faint; or 1 / 3
  revolutions, a chosen time, everything; display only, the replay and its digest are untouched), the
  flight length (the plan's duration: replayed and scored, capped by the mission maximum), ascending /
  descending nodes (`plane-nodes.ts`, pure: sign changes of the out-of-plane coordinate on the replayed
  trajectory, refined on a cubic Hermite) against the reference body's equator or a body's orbital plane,
  the rotation-axis and plane-disc overlays, and one distance convention for the whole UI (`units.ts`:
  altitude by default, or radius from the centre; the Sun always from its centre). Altitude means one
  thing in every layer (launch, replay events, impact and atmosphere thresholds, objectives, planner,
  UI): distance from the body's centre minus its reference radius (`referenceRadius` in the body data,
  the equatorial radius its gravity field is referred to, e.g. 6,378.1366 km for Earth; the mean
  radius for bodies without a field). The mean radius is used only for drawing.
- **Timeline** (`timeline.ts`): zoomable about the cursor (wheel, pinch, buttons, fit presets), adaptive
  axis in the time display's form, clustered ticks, overview strip when zoomed, separations as teal
  scissors marks (drag to move, tap to edit); it controls only what the scrubber shows.
- **Separations as flight actions** (`nodes.ts`): a separation drops the active stage at a time you
  choose ("Separation at cursor", or "separate after" a burn), with whatever propellant it holds; burns
  after it are fired by the next stage, and each burn row carries its stage chip (S1, S2…, SC). A stage
  that runs dry separates by itself, and that separation is listed like any other. The transfer planner
  offers to split a departure the active stage cannot complete ("Split across a separation": the stage
  burns what it has, separates a second after cutoff, the next stage flies the rest in the same
  direction).
- **Vehicle panel and Sandbox vehicle editor** (`vehicle-ui.ts`, `vehicle.ts`): the stack bottom to top
  with masses, engines, thrust-to-weight at ignition and each stage's delta-v with everything above it;
  before a replay what the ascent leaves each stage and what the nodes ask of it, after it what each used
  and has left. Read-only in a mission; in Sandbox a full editor (presets, a spacecraft alone delivered
  free to orbit, add / remove / reorder stages, masses and engines), every change undoable.
- **Launch feedback** (in the Start panel): the ascent's required delta-v and its breakdown, which stage
  reaches orbit and what the upper stage has left at insertion (or why the vehicle cannot reach the
  orbit), and two charts of upper-stage delta-v left against parking altitude and against azimuth (with
  each azimuth's inclination and the site's range-safety corridor), computed in `ascent-worker.ts`. Tap
  or drag a chart to set the value. The score's delta-v is the total: ascent plus everything flown after.
- **Orbit panel** (`orbit-ui.ts`, maths in `orbit-elements.ts`): the state and orbit at the time cursor
  about the dominant body or a pinned one, in the shared node plane. The elements are *osculating*: the
  two-body orbit matching the position and velocity at that instant, which drift in an N-body flight;
  where the replay knows the real next apsis it is shown alongside. The status bar's orbit (Pe, Ap, i)
  and the free-orbit start preview come from the same code (`orbitAbout`, `osculating`).
- **Time display** (`timefmt.ts`, persisted with the view settings): every point in time is shown as
  mission elapsed time (T+ from liftoff or the plan start), UTC (marked * where leap seconds are
  predicted) or TDB, chosen in View or by tapping the time under the timeline or in the status bar
  (MET → UTC → TDB). Durations are never converted. Exceptions: the status bar's second line, the Time
  panel and the node editor's "Absolute / Mission elapsed" row show the other form on purpose, and the
  transfer planner keeps calendar dates (UTC, or TDB in TDB mode) with T+ alongside.
  `e2e/times.e2e.ts` audits the rendered text in every mode.
- **Map labels** (`label-layout.ts`, pure; `labels.ts` applies it): priority by kind, raised for the
  selected item and for items near the time cursor in time; labels never overlap each other or sit on a
  globe (a marker over a planet gets its name outside the disc with a leader line); markers within a few
  pixels (more on touch) collapse into one cluster ("Burn 1 +2") that fans out on a tap; items far in
  time from the cursor fade; markers behind a body are drawn faded, without a name (the selected item and failures keep
  theirs), and are not tappable. A marker whose name is hidden is still tappable (the map picks within 28 px on touch).
- Viewer pieces: `frames.ts`, `paths.ts`, `scene.ts`, `labels.ts`, `hud.ts`, `camera.ts`, `time.ts`.

Keys (the in-app "Shortcuts and gestures" dialog, `?`, lists the same, with the map legend and the
panels): Space pauses, `,` and `.` change warp. With a node selected: W/S prograde, D/A
normal, E/Q radial (Alt, none, Shift: the small, medium, large step, 0.1, 1, 10 m/s and 1 s, 1 min, 10 min for time), `[` `]` move it in time, Delete
removes it, Esc clears the selection, N (or Enter) adds a node at the picked trajectory point or else at the time cursor. Ctrl/Cmd Z undoes any plan edit and Shift Ctrl/Cmd Z (or Ctrl Y) redoes it
(`history.ts`: a drag or a burst of step clicks on one value is one step); the nodes panel has Undo / Redo buttons.

Adding a node is select-then-confirm, the same on desktop and touch: a click or tap on the trajectory picks that point
(the time cursor moves there, its readout pops up) and "Add node here", N or Enter adds it. A click never adds a node by
itself, a click that ends a camera drag does nothing, and far-side points hidden behind a body are not hit-testable.
A double click or double tap focuses what is under the pointer; when several things are there `pick.ts` decides, in
this order: the spacecraft, maneuver nodes and burn markers, event and AN / DN markers, launch sites, bodies (nearest
the camera first), a trajectory point (the time cursor moves there and the spacecraft is focused). Single clicks use
the same order, without bodies. Touch: one-finger drag orbits the camera, pinch zooms, two-finger drag
tilts and turns; every control has a tap target of about 44 px and nothing needs hover or a keyboard.
Tapping a cluster of markers fans it out; tapping the time cycles the time display.
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
pnpm test:browsers   # Playwright: every suite on Chromium, Firefox and WebKit (builds first)
```

Which UI tests run on which engine, what Playwright's WebKit does not prove about iOS Safari, and a
ten-minute manual script for real phones: [docs/mobile-testing.md](docs/mobile-testing.md).

The browser suite can be narrowed the way CI splits it (`e2e/playwright.config.ts`):
`PW_SUITE=engines` runs only the cross-engine determinism files (`determinism`, `ephemeris`),
`PW_SUITE=ui` every other file; `PW_PREBUILT=1` serves the existing `dist/` instead of
building first. For example `PW_SUITE=ui pnpm test:browsers --project=chromium --shard=2/4`.

## CI

`.github/workflows/ci.yml` runs on every push and pull request, as parallel jobs:

| job | what | needs |
|---|---|---|
| `unit` | `pnpm typecheck`, `pnpm test` | |
| `build` | `pnpm build` (uploaded as the artifact `site-dist`), `pnpm build:leaderboard` | |
| `engines` (×3) | `PW_SUITE=engines` on Chromium, Firefox and WebKit, one job per engine, against `site-dist` | `build` |
| `ui` (×11) | `PW_SUITE=ui` (every UI suite, including `smoke` and `mobile`) on Chromium in 5 shards and on WebKit in 6, against `site-dist` | `build` |
| `firefox` | `e2e/smoke.e2e.ts` on Firefox, `PW_FIREFOX_HEADED=1 xvfb-run -a` (headless Linux Firefox has no WebGL) | `build` |
| `report` | merges every browser job's blob report into one HTML report and writes the run summary | `engines`, `ui`, `firefox` |
| `deploy` | `.github/workflows/deploy.yml` (below); pushes to main only | all of the above |

Dependencies come from the pnpm store cache (`actions/setup-node`), browsers from a cache per
engine and Playwright version, and the site is built once and shared as an artifact, so no
browser job rebuilds it. There are no retries: a flaky test fails its job (the summary table
would mark a flaky pass separately if retries were ever turned on).

Finding a failure: the run's Summary page lists every failed test with its file and line and
the artifact that holds it. Each failing browser job uploads `playwright-report-engines-<engine>`
or `playwright-report-ui-<engine>-<shard>` / `playwright-report-firefox-smoke` (HTML report, traces); the merged report of all jobs is
`playwright-report`. Failures are also annotated on the commit by Playwright's `github` reporter.

Timings. The old single job took about 13 minutes, most of it the browser suite run
serially. Measured locally (12-core laptop, heavily loaded by other work, so pessimistic):
unit tests 43-150 s (depending on that load), typecheck 4 s, build 1 s, each engine's determinism files 7-8 s (4 tests), UI shards
1-4: 171, 131, 139, 69 s with 2 workers (18, 21, 18, 13 tests; 70 UI tests, all passing). Expected on GitHub's 4-vCPU runners (not measured there): about
1 minute of setup per job (checkout, pnpm install from cache, browser cache restore and
`install-deps`), `unit` 3-5 min, `build` 1 min, `engines` 2-3 min, each `ui` shard 4-5 min,
so about 6-7 minutes from push to green, bounded by `build` plus the slowest UI shard and
by `unit`. More shards would shave the UI path further at the cost of more setup minutes.

`.github/workflows/slow.yml` runs the `SLOW=1` validation suites that the default path skips
(the campaign and per-site campaign suites, the Voyager 2 variant (a), `pnpm test:slow`) every
Monday and on demand (Actions > Slow validation > Run workflow), one job each. The reference
solvers (`*-solve.test.ts`) are generators that take hours and are not run there.

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

Per mission version, three boards (combined score, delta-v, time), each for every launch site
the mission offers and for all sites together (`site=<id>` or `site=all`, the default). A
player keeps a best per site on each board; the all-sites view shows each player once, with
their best over all sites and the site it was flown from. Scoring (par) is one per mission, so
the all-sites board compares sites directly; each offered site has its own delta-v and time
limits (`src/mission/campaign-sites.ts`). The server never trusts a
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
- `... show|hide|unhide --mission <id> --version <v> --pid <pid>` inspects or hides a player
  (all their entries: every site board and the all-sites boards; a hidden player stays
  hidden when they submit again, from any site).
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

#### Release: physics model 2

Physics model 2 changes replay results (force model, the altitude reference radius, the
time-dependent pole for inclination objectives) and every campaign mission's rules (fixed
parking orbit, re-derived par and limits), so all boards move to new partitions: physics
`2.<fingerprint>` and new mission versions (plane-change 1 -> 2, every other mission 2 -> 3).
Build the site and the leaderboard bundle from the same commit, then:

```sh
# 1. Leaderboard first: from now on model-1 plans are refused ("made for an older version
#    of the game", version-mismatch) and model-1 pages get "mission is now version N".
AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<artifact-bucket> \
  scripts/deploy-leaderboard.sh <leaderboard-stack>
# 2. The site, right after (same commit), so players get the model-2 game.
AWS_PROFILE=<profile> scripts/deploy.sh <site-stack>
# 3. Check what the server runs: physics 2.<fingerprint>, the mission versions below.
pnpm build:leaderboard
eval "$(aws configure export-credentials --profile <profile> --format env)"
export TABLE_NAME=<table>
node dist-server/leaderboard/admin.mjs missions
# 4. Re-fly every stored plan under model 2 and file it under the new mission version.
#    Each command covers all of the mission's launch sites (a player's group holds one
#    entry per site plus the all-sites entry). Dry run first, then for real; repeat each
#    until it reports written: 0.
for m in plane-change:1 geo-from-leo:2 earth-escape:2 lunar-flyby:2 lunar-free-return:2 \
         lunar-orbit:2 venus-flyby:2 mars-flyby:2 mars-orbit:2 venus-to-mercury:2 \
         solar-escape:2 jupiter-saturn:2; do
  node dist-server/leaderboard/admin.mjs reverify --mission "${m%%:*}" --from "${m##*:}" --dry-run
done
for m in plane-change:1 geo-from-leo:2 earth-escape:2 lunar-flyby:2 lunar-free-return:2 \
         lunar-orbit:2 venus-flyby:2 mars-flyby:2 mars-orbit:2 venus-to-mercury:2 \
         solar-escape:2 jupiter-saturn:2; do
  node dist-server/leaderboard/admin.mjs reverify --mission "${m%%:*}" --from "${m##*:}"
done
```

Re-verification checks each stored plan against the new rules before re-flying it: a plan
whose parking orbit is not the mission's fixed altitude (or that changed the ascent time,
downrange angle or circularisation) is marked invalid with that reason, as is any plan
whose flight no longer meets the objectives or the new limits under model 2. Valid
entries keep their original submission times. The old version's boards stay in the table
but are no longer served.

Re-verification also migrates entries stored before launch sites existed (one item per
player, no per-site items): their plans are re-flown and filed under the site they launched
from. Missions whose version did not change with the launch-site release (plane-change) need
`reverify --mission plane-change` once after that deploy, because board partitions now
include the site.

#### Release: launch vehicles (mission versions 4; plane-change 3)

Every campaign mission now launches on a catalogue vehicle (`rules.vehicle`), charges the
ascent, and scores and limits the total delta-v (ascent plus flight). The physics model
does not change (no `PHYSICS_MODEL` bump: replay results of existing plans are
unchanged), but every mission version does: plane-change 2 -> 3, every other mission
3 -> 4. Plans made for the old versions were free deliveries to the parking orbit
(format 1, no lower stages); the new versions refuse them. In the editor and from the
server, they are refused with the same reason: *"this plan was made for an earlier version of
the mission, whose launch delivered the spacecraft to its parking orbit free of charge;
this version launches on its vehicle and charges the ascent, so the plan must be
rebuilt"*. The server returns it as `rule-violation` when the plan is submitted under the
new version, and as `mission-version` (409) when it is submitted under the old version
number. So no stored result carries over, and the new boards start empty.

Cost of a submission. Every vehicle launch runs the ascent model before the replay:
5-9 ms per call for the campaign's vehicles (`bench.mjs ascent`). Only the
mission's own vehicle can reach it, because the rule check comes first, and it is bit for
bit. A warm lunar free return, ascent included, re-flies in about 25 ms (395 ms cold, with
one chunk built). Decoding the largest staged plan the format allows takes about 0.3 ms,
and checking its rules about 0.01 ms (`bench.mjs checks`). That plan has 6 stages of 8
engines, 5 separations and 200 burns, encodes to 14 676 characters (under
`maxEncodedLength` 16 384) and makes a 14.8 kB request (under `MAX_BODY_BYTES` 20 000).
Each stored entry holds at most three plans, about 45 kB, well under DynamoDB's 400 KB
item limit. The replay budget (`REPLAY_BUDGET_MS`, `MAX_STEPS`) is unchanged.

Build the site and the leaderboard bundle from the same commit, then:

```sh
# 1. Leaderboard first: from now on old-version plans are refused with the reason above,
#    and pages still on the old build get "mission is now version N".
AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<artifact-bucket> \
  scripts/deploy-leaderboard.sh <leaderboard-stack>
# 2. The site, right after (same commit).
AWS_PROFILE=<profile> scripts/deploy.sh <site-stack>
# 3. Check what the server runs: the same physics version as before, mission versions
#    plane-change 3 and 4 for every other mission.
pnpm build:leaderboard
eval "$(aws configure export-credentials --profile <profile> --format env)"
export TABLE_NAME=<table>
node dist-server/leaderboard/admin.mjs missions
# 4. Optional: confirm that nothing carries over. Every old plan is logged as refused
#    with the reason above, and the run reports written: 0.
for m in plane-change:2 geo-from-leo:3 earth-escape:3 lunar-flyby:3 lunar-free-return:3 \
         lunar-orbit:3 venus-flyby:3 mars-flyby:3 mars-orbit:3 venus-to-mercury:3 \
         solar-escape:3 jupiter-saturn:3; do
  node dist-server/leaderboard/admin.mjs reverify --mission "${m%%:*}" --from "${m##*:}" --dry-run
done
```

The old versions' boards stay in the table but are no longer served. Rolling back means
redeploying the previous commit's two bundles. The old boards are served again from that
moment, and nothing has to be re-verified, because nothing was written to them.

## Deploy pipeline

On a push to main, once every CI job has passed, the `deploy` job
(`.github/workflows/deploy.yml`, GitHub environment `production`) deploys that exact commit:

1. Guards: runs only from main and only for a commit of main; an automatic run whose commit is
   no longer main's head stops (the newer push's run deploys the newer commit, so a slow old run
   cannot roll a new deploy back). One deploy at a time (`concurrency: deploy-production`, never
   cancelled half-way).
2. Release gate (`scripts/release-gate.mjs`): compares this commit's physics version and mission
   versions (`admin.mjs missions` of a fresh `pnpm build:leaderboard`) with what the live
   `/api/leaderboard/missions` serves. If the physics version or any existing mission's version
   differs, it **stops before deploying anything** and prints, in the run summary, the exact
   `reverify` commands (see "Re-verification" above). Reason: such a deploy empties those boards
   until the stored plans are re-flown, re-verification needs table write access that the deploy
   role deliberately does not have, and it must be checked with a dry run by a person. Deploying
   blindly and flagging "pending" would leave boards empty for however long nobody notices.
3. AWS credentials through GitHub OIDC (`infra/github-deploy-role.yaml`); no keys anywhere.
4. Pre-flight: both stacks are readable, and the deployed leaderboard template is identical to
   this commit's `infra/leaderboard.yaml`. The role can only swap the bundle; a template change
   is deployed by hand once (below), then automation resumes.
5. `scripts/deploy-leaderboard.sh` (it runs `pnpm test` again, builds and uploads the bundle,
   updates the stack), with `IP_HASH_SALT` and `EXPOSE_PLANS` forced empty, so CloudFormation
   keeps the stored salt and setting. The salt is not stored in GitHub at all.
6. `scripts/deploy.sh` (site), same commit.
7. Smoke check (`scripts/smoke-check.mjs`, Chromium against the live site): the missions endpoint
   serves exactly this commit's physics and mission versions (polled for up to 4 minutes: the
   reply may be cached for 60 s), `/` loads with no console errors, and `/check.html` reports
   PASS overall and for its model-2 and staged replays, with this commit's model and data
   fingerprint. Any failure fails the job, and the run summary says what was deployed and what
   to do. The same check runs by hand: `pnpm build:leaderboard && SITE_URL=https://<site> node scripts/smoke-check.mjs`.

Pull requests (from forks or not) can never reach the role: the deploy job runs only for
`push` events on main, the `production` environment accepts only main, and the role's trust
policy accepts only tokens whose subject is this repository's `production` environment on
`refs/heads/main` (a pull request's subject is `repo:<owner>/<repo>:pull_request`).

### Automatic deploy: one-time setup

Prerequisites: the site and leaderboard stacks exist and were deployed by hand as above (the
first leaderboard deploy sets the salt). Placeholders: `<owner>/<repo>`, `<profile>`,
`<site-stack>`, `<leaderboard-stack>`, `<artifact-bucket>`, `<site.example.com>`.

```sh
# 1. Does the account already have GitHub's OIDC provider? (then CreateOidcProvider=false)
aws iam list-open-id-connect-providers --profile <profile>

# 2. The role stack (needs CAPABILITY_IAM). Bucket and distribution from the site stack's outputs.
out() { aws cloudformation describe-stacks --profile <profile> --region us-east-1 --stack-name "$1" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
aws cloudformation deploy --profile <profile> --region us-east-1 \
  --stack-name sendit-github-deploy --template-file infra/github-deploy-role.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Repository=<owner>/<repo> CreateOidcProvider=true \
    SiteStackName=<site-stack> SiteBucketName="$(out <site-stack> BucketName)" \
    DistributionId="$(out <site-stack> DistributionId)" \
    LeaderboardStackName=<leaderboard-stack> ArtifactBucket=<artifact-bucket>
ROLE_ARN="$(out sendit-github-deploy RoleArn)"

# 3. Make the OIDC subject carry the branch as well as the environment (the trust policy expects
#    repo:<owner>/<repo>:environment:production:ref:refs/heads/main).
gh api -X PUT repos/<owner>/<repo>/actions/oidc/customization/sub \
  -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=ref'

# 4. The environment, accepting deployments from main only. Add required reviewers in
#    Settings > Environments > production if every deploy should wait for a manual approval.
gh api -X PUT repos/<owner>/<repo>/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/<owner>/<repo>/environments/production/deployment-branch-policies -f name=main -f type=branch

# 5. Configuration. The role ARN is a secret only to keep the account id out of public logs;
#    the rest are plain environment variables. Nothing here is the IP-hash salt.
gh secret set AWS_DEPLOY_ROLE_ARN --env production --repo <owner>/<repo> --body "$ROLE_ARN"
gh variable set SITE_URL          --env production --repo <owner>/<repo> --body https://<site.example.com>
gh variable set SITE_STACK        --env production --repo <owner>/<repo> --body <site-stack>
gh variable set LEADERBOARD_STACK --env production --repo <owner>/<repo> --body <leaderboard-stack>
gh variable set ARTIFACT_BUCKET   --env production --repo <owner>/<repo> --body <artifact-bucket>

# 6. Switch automatic deploys on (a repository variable: ci.yml reads it before the environment).
gh variable set DEPLOY_ENABLED --repo <owner>/<repo> --body true
```

| name | kind | sensitive | used for |
|---|---|---|---|
| `DEPLOY_ENABLED` | repository variable | no | kill switch: automatic deploys run only while it is `true` |
| `AWS_DEPLOY_ROLE_ARN` | `production` secret | mildly (account id) | the role to assume |
| `SITE_URL` | `production` variable | no | release gate, smoke check, environment link |
| `SITE_STACK`, `LEADERBOARD_STACK` | `production` variables | no | passed to the two scripts |
| `ARTIFACT_BUCKET` | `production` variable | no | bundle bucket for `deploy-leaderboard.sh` |
| IP-hash salt | none | yes | never in GitHub: set once by the manual first deploy, kept by CloudFormation |

### Pause, bypass, roll back

- Pause: `gh variable set DEPLOY_ENABLED --repo <owner>/<repo> --body false` (CI still runs; the
  deploy job is skipped). To stop every deploy, manual ones included, also disable the workflow:
  `gh workflow disable Deploy`, or add required reviewers to `production` and decline.
- Redeploy or roll back: Actions > Deploy > Run workflow (from main), `sha` = the commit of main
  to deploy (empty = main's head), or `gh workflow run Deploy --ref main -f sha=<commit>`. The
  same gate, pre-flight and smoke check apply; rolling back across a version change is stopped
  by the gate like any other version change.
- Deploy a physics or mission version change: preferably by hand (next section, then the
  `reverify` commands the gate printed). Or run the Deploy workflow with
  `version_change_acknowledged` checked: it deploys, and the summary marks re-verification as
  pending; run the printed commands immediately.
- If a deploy fails: a failed leaderboard update is rolled back by CloudFormation and the site is
  left alone. If the leaderboard deployed but the site did not, the server runs the new commit
  and players the old site: re-run the job (both scripts are idempotent) or roll back. If the
  smoke check fails, both are live: roll back to the last good commit, then investigate.

### Deploy by hand

Still works exactly as before, with an operator profile, and is required for the first deploy,
for changes to `infra/*.yaml`, and preferably for version changes:

```sh
AWS_PROFILE=<profile> SITE_STACK=<site-stack> ARTIFACT_BUCKET=<artifact-bucket> \
  scripts/deploy-leaderboard.sh <leaderboard-stack>
AWS_PROFILE=<profile> scripts/deploy.sh <site-stack>
pnpm build:leaderboard && SITE_URL=https://<site.example.com> node scripts/smoke-check.mjs
```

Pause automatic deploys first (`DEPLOY_ENABLED=false`) if a push could land meanwhile; the
role stack (`infra/github-deploy-role.yaml`) needs a redeploy only if a stack, bucket or
distribution it names changes.
