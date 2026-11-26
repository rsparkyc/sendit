/**
 * The app's single adapter to src/planning (as physics.ts is to src/physics
 * and mission-layer.ts to src/mission). Nothing else in src/app imports the
 * planning modules. Planning is advisory: whatever it proposes enters the
 * plan only as ordinary nodes through nodes.ts, and is then judged by the
 * scoring replay like any hand-made node.
 */
export { bForPeriapsis, correctBurn, type BPlaneTarget, type CorrectorResult, type PositionTarget } from '../planning/corrector';
export { bPlane, flyToTarget, planDeparture, type DeparturePlan } from '../planning/departure';
export { evaluateChain, optimizeChain, type ChainResult, type FlybyReport } from '../planning/flyby';
export { computePorkchopAsync, gridMinimum, PorkchopJob, type PorkchopGrid, type PorkchopPoint, type PorkchopSpec, type TimeRange } from '../planning/porkchop';
export { findBody, minFlybyAltitude } from '../planning/bodies';
