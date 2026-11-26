/**
 * Viewer entry point: wires the worker-fed ephemeris, store, camera, scene,
 * labels and HUD, and runs the frame loop.
 */
import './style.css';
import { deriveMeta } from './body-meta';
import { OrbitCamera } from './camera';
import { computeFrame, frameCenter, frameKey, newFrameState, parseFrameKey, toFrame, type FrameSpec } from './frames';
import { Hud, type Readout } from './hud';
import { Labels, type LabelItem } from './labels';
import { anchorSegments, bodyPath, trajectoryPath, type FrameContext, type FramePath } from './paths';
import { MISSION_LAUNCH } from './mission';
import { BODIES, BODY_GM, bodyIndex, Ephemeris } from './physics';
import type { FromWorker, MissionInfo, ToWorker } from './protocol';
import { SceneView, UNIT } from './scene';
import { chunksMissing } from './schedule';
import { Store, WARP_RATES, type ViewState } from './store';
import { calendarToTdb, formatCalendar, JULIAN_YEAR, parseCalendar, tdbToCalendar, utcMsToTdb } from './time';
import { stateAt, trajectoryFrom, type Trajectory } from './trajectory';

const SPACECRAFT = -1;
const PATH_SAMPLES = 360;
const PATH_WINDOW = 400 * 86400; // s either side of now kept loaded
const n = BODIES.length;
const meta = deriveMeta(BODIES);
const sunIndex = meta.findIndex((m) => m.parent < 0);

// ---------------------------------------------------------------------------
// Ephemeris fed by the worker

const eph = new Ephemeris();
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const metrics = {
  chunkMs: [] as number[],
  frameCpuMs: 0,
  frameIntervalMs: 0,
  mission: null as MissionInfo | null,
  errors: [] as string[],
};
let trajectory: Trajectory | null = null;
let coverageVersion = 0;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (m.type === 'chunk') {
    eph.install(m.k, m.coeffs);
    if (m.ms > 0) metrics.chunkMs.push(m.ms);
    coverageVersion++;
  } else if (m.type === 'mission') {
    trajectory = trajectoryFrom(m.samples);
    metrics.mission = m.info;
    trajectoryDirty = true;
  } else if (m.type === 'error') {
    metrics.errors.push(m.message);
    console.error('physics worker:', m.message);
  }
};
worker.onerror = (e) => {
  metrics.errors.push(e.message);
  console.error('physics worker failed to load', e.message);
};

let lastWant = '';
function want(lo: number, hi: number): void {
  const key = `${lo}:${hi}`;
  if (key === lastWant) return;
  lastWant = key;
  worker.postMessage({ type: 'want', lo, hi } satisfies ToWorker);
}

// ---------------------------------------------------------------------------
// Initial state (URL hash overrides, e.g. #t=2030-01-01&frame=rot:earth:moon&focus=earth&dist=1e9)

const params = new URLSearchParams(location.hash.slice(1));
const earth = bodyIndex('earth');
const moon = bodyIndex('moon');
const home = earth >= 0 ? earth : 0;

function initialTime(): number {
  const p = params.get('t');
  if (p !== null) {
    if (/^-?\d+(\.\d+)?(e\d+)?$/.test(p)) return Number(p);
    const c = parseCalendar(p);
    if (c) return calendarToTdb(c);
  }
  return MISSION_LAUNCH + 3600;
}

function defaultSecondary(c: number): number {
  let best = -1;
  BODIES.forEach((b, i) => {
    if (meta[i].parent === c && (best < 0 || b.gm > BODIES[best].gm)) best = i;
  });
  if (best >= 0) return best;
  return meta[c].parent >= 0 ? meta[c].parent : (c + 1) % n;
}

const focusParam = params.get('focus');
const initialFocus = focusParam === 'sc' ? SPACECRAFT : focusParam && bodyIndex(focusParam) >= 0 ? bodyIndex(focusParam) : home;
const initialFrame: FrameSpec = parseFrameKey(params.get('frame') ?? '', bodyIndex) ?? { kind: 'inertial', center: home };
const t0 = initialTime();

const store = new Store<ViewState>({
  t: t0,
  paused: params.get('paused') === '1',
  warpIndex: Math.max(0, Math.min(WARP_RATES.length - 1, Number(params.get('warp') ?? 3))),
  focus: initialFocus,
  frame: initialFrame,
  loadingTarget: t0,
  loadingChunks: 0,
});

// ---------------------------------------------------------------------------
// Scene, camera, labels, HUD

const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('labels') as HTMLElement;
const scene = new SceneView(
  canvas,
  BODIES.map((b, i) => ({ radius: b.radius, color: meta[i].color, emissive: i === sunIndex })),
  sunIndex,
);
const camera = new OrbitCamera();
camera.setDistance(Number(params.get('dist') ?? 1.6e9), true);
if (params.has('az')) camera.azimuth = Number(params.get('az'));
if (params.has('el')) camera.elevation = Number(params.get('el'));

const labels = new Labels(overlay, (key) => store.set({ focus: key === 'sc' ? SPACECRAFT : Number(key) }));

function jumpTo(t: number): void {
  store.set({ loadingTarget: t });
}

const hud = new Hud(
  document.getElementById('hud') as HTMLElement,
  store,
  BODIES.map((b, i) => ({ name: b.name, defaultSecondary: defaultSecondary(i) })),
  {
    jump(text) {
      const c = parseCalendar(text);
      if (!c) return 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM (TDB)';
      jumpTo(calendarToTdb(c));
      return null;
    },
    jumpTo,
    presets: [
      { label: 'Mission', t: MISSION_LAUNCH + 3600 },
      { label: 'Now', t: utcMsToTdb(Date.now()) },
      { label: 'J2000', t: 0 },
    ],
    spacecraftName: 'Demo TLI (spacecraft)',
  },
);

function resize(): void {
  scene.resize(canvas.clientWidth, canvas.clientHeight);
}
window.addEventListener('resize', resize);
resize();

// Input
let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camera.rotate(-(e.clientX - drag.x) * 0.005, (e.clientY - drag.y) * 0.005);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  camera.zoom(Math.exp(dy * 0.0015));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    store.set({ paused: !store.get().paused });
  } else if (e.key === ',') hud.stepWarp(-1);
  else if (e.key === '.') hud.stepWarp(1);
});

// ---------------------------------------------------------------------------
// Paths

const ctx: FrameContext = { count: n, gm: BODY_GM, evaluate: (t, p, v) => eph.evaluate(t, p, v) };

interface PathState {
  center: number; // time the window is centred on
  span: number;
  coverage: number; // coverageVersion when computed
  clipped: boolean;
}
const pathState: (PathState | null)[] = new Array(n).fill(null);
let trajectoryDirty = false;
let trajectoryPathCache: FramePath | null = null;

/** Time span drawn for body i's path in this frame (one orbit, or the period of the frame's own motion). */
function pathSpan(i: number, frame: FrameSpec): number {
  // 2% overlap so the ends meet despite the osculating period being approximate.
  if (Number.isFinite(meta[i].period)) return meta[i].period * 1.02;
  const c = frameCenter(frame);
  if (c !== null && Number.isFinite(meta[c].period)) return meta[c].period;
  return JULIAN_YEAR;
}

function updatePaths(t: number, frame: FrameSpec, budget: number): void {
  const c = frameCenter(frame);
  const [ca, cb] = eph.span();
  for (let i = 0; i < n && budget > 0; i++) {
    if (i === c) {
      if (pathState[i]) {
        scene.setBodyPath(i, null);
        pathState[i] = null;
      }
      continue;
    }
    const span = pathSpan(i, frame);
    const s = pathState[i];
    const stale = !s || Math.abs(t - s.center) > span / 24 || (s.clipped && s.coverage !== coverageVersion);
    if (!stale) continue;
    budget--;
    const ta = t - span / 2;
    const tb = t + span / 2;
    const p = bodyPath(ctx, frame, i, Math.max(ta, ca), Math.min(tb, cb - 1), PATH_SAMPLES);
    scene.setBodyPath(i, anchorSegments(p.points, UNIT));
    pathState[i] = { center: t, span, coverage: coverageVersion, clipped: ta < ca || tb > cb };
  }
}

function invalidatePaths(): void {
  pathState.fill(null);
  trajectoryDirty = true;
}

store.subscribe((s, p) => {
  if (s.frame !== p.frame) {
    invalidatePaths();
    camera.reset();
  }
  if (s.focus !== p.focus) {
    camera.refocus();
    const r = s.focus === SPACECRAFT ? 2e6 : BODIES[s.focus].radius * 12;
    camera.setDistance(Math.max(r, Math.min(camera.targetDistance, r * 50)));
  }
});

// ---------------------------------------------------------------------------
// Frame loop

const pos = new Float64Array(3 * n);
const vel = new Float64Array(3 * n);
const framePos = new Float64Array(3 * n);
const fs = newFrameState();
const scState = new Float64Array(6);
const scFrame = new Float64Array(3);
const focusPos = new Float64Array(3);
const proj = { x: 0, y: 0 };
let last = performance.now();
let lastCoverageForWant = -1;

function readout(title: string, p: ArrayLike<number>, po: number, v: ArrayLike<number>, vo: number, frame: FrameSpec, extra?: string): Readout {
  const c = frameCenter(frame);
  const ox = c === null ? fs.origin : pos.subarray(3 * c, 3 * c + 3);
  const ov = c === null ? fs.originVel : vel.subarray(3 * c, 3 * c + 3);
  return {
    title,
    relativeTo: c === null ? 'barycentre' : BODIES[c].name,
    distance: Math.hypot(p[po] - ox[0], p[po + 1] - ox[1], p[po + 2] - ox[2]),
    speed: Math.hypot(v[vo] - ov[0], v[vo + 1] - ov[1], v[vo + 2] - ov[2]),
    extra,
  };
}

function tick(now: number): void {
  const dtReal = Math.min(0.25, (now - last) / 1000);
  metrics.frameIntervalMs = metrics.frameIntervalMs * 0.95 + (now - last) * 0.05;
  last = now;
  const cpu0 = performance.now();
  let s = store.get();

  // Time.
  if (s.loadingTarget !== null) {
    if (eph.covers(s.loadingTarget)) {
      store.set({ t: s.loadingTarget, loadingTarget: null, loadingChunks: 0 });
    }
  } else if (!s.paused) {
    const tn = s.t + dtReal * WARP_RATES[s.warpIndex];
    if (eph.covers(tn)) store.set({ t: tn });
    else store.set({ loadingTarget: tn });
  }
  s = store.get();
  const tFocus = s.loadingTarget ?? s.t;
  const k = eph.chunkIndex(tFocus);
  // Enough around the current time for the inner planets' paths; the worker prefetches beyond.
  want(Math.min(k - 1, eph.chunkIndex(tFocus - PATH_WINDOW)), Math.max(k + 1, eph.chunkIndex(tFocus + PATH_WINDOW)));
  if (s.loadingTarget !== null && coverageVersion !== lastCoverageForWant) {
    lastCoverageForWant = coverageVersion;
    store.set({ loadingChunks: chunksMissing({ lo: eph.lo, hi: eph.hi }, { lo: k, hi: k }) });
  }

  const t = s.t;
  if (eph.evaluate(t, pos, vel)) {
    const frame = s.frame;
    computeFrame(frame, { count: n, pos, vel, gm: BODY_GM }, fs);
    for (let i = 0; i < n; i++) toFrame(fs, pos, 3 * i, framePos, 3 * i);
    updatePaths(t, frame, 2);

    // Spacecraft.
    let scVisible = false;
    if (trajectory) {
      if (trajectoryDirty) {
        trajectoryPathCache = trajectoryPath(ctx, frame, trajectory);
        scene.setTrajectory(anchorSegments(trajectoryPathCache.points, UNIT));
        trajectoryDirty = false;
      }
      scVisible = stateAt(trajectory, t, scState);
      if (scVisible) toFrame(fs, scState, 0, scFrame, 0);
      if (trajectoryPathCache) {
        const times = trajectoryPathCache.times;
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (times[mid] <= t) lo = mid + 1;
          else hi = mid;
        }
        scene.setTrajectorySplit(Math.max(0, lo - 1), times.length);
      }
    }

    // Camera.
    let minDist = 10;
    if (s.focus === SPACECRAFT) {
      if (scVisible) focusPos.set(scFrame);
      else if (trajectoryPathCache && trajectoryPathCache.times.length > 0) {
        const p = trajectoryPathCache.points;
        const end = t < trajectoryPathCache.times[0] ? 0 : p.length - 3;
        focusPos.set(p.subarray(end, end + 3));
      } else focusPos.set(framePos.subarray(3 * home, 3 * home + 3));
    } else {
      focusPos.set(framePos.subarray(3 * s.focus, 3 * s.focus + 3));
      minDist = BODIES[s.focus].radius * 1.02;
    }
    camera.update(dtReal, focusPos, minDist);
    scene.render(camera.position, camera.target, framePos);

    // Labels and markers.
    const items: LabelItem[] = [];
    for (let i = 0; i < n; i++) {
      const on = scene.project(framePos, 3 * i, camera.position, proj);
      const d = Math.hypot(framePos[3 * i] - camera.position[0], framePos[3 * i + 1] - camera.position[1], framePos[3 * i + 2] - camera.position[2]);
      const px = scene.pixelRadius(BODIES[i].radius, d);
      items.push({
        key: String(i),
        text: BODIES[i].name,
        color: meta[i].color,
        priority: (i === s.focus ? 1000 : 0) + Math.log10(BODIES[i].gm),
        x: proj.x,
        y: proj.y,
        marker: px < 3,
        offset: px < 3 ? 0 : px,
        onScreen: on,
      });
    }
    if (scVisible) {
      const on = scene.project(scFrame, 0, camera.position, proj);
      items.push({ key: 'sc', text: metrics.mission?.name ?? 'Spacecraft', color: '#7dffb0', priority: s.focus === SPACECRAFT ? 1000 : 13.5, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on });
    }
    labels.update(items);

    // Readouts.
    const ro: Readout[] = [];
    if (s.focus !== SPACECRAFT) ro.push(readout(BODIES[s.focus].name, pos, 3 * s.focus, vel, 3 * s.focus, frame));
    if (trajectory && metrics.mission) {
      const mi = metrics.mission;
      const ca = `Closest lunar approach ${Math.round(mi.closestApproach / 1000).toLocaleString('en-US')} km, ${formatCalendar(tdbToCalendar(mi.closestApproachTime), false)}`;
      if (scVisible) {
        const phase = t < mi.burnStart ? 'Parking orbit' : t < mi.burnEnd ? 'TLI burn' : 'Coast';
        let extra = `${phase} · TLI Δv ${mi.deltaV.toFixed(0)} m/s`;
        if (moon >= 0) {
          const dm = Math.hypot(scState[0] - pos[3 * moon], scState[1] - pos[3 * moon + 1], scState[2] - pos[3 * moon + 2]);
          extra += ` · Moon ${Math.round(dm / 1000).toLocaleString('en-US')} km`;
        }
        ro.push(readout(mi.name, scState, 0, scState, 3, frame, `${extra} · ${ca}`));
      } else {
        ro.push({ title: mi.name, relativeTo: '—', distance: NaN, speed: NaN, extra: `Not flying at this date (${formatCalendar(tdbToCalendar(mi.launch), false)} to ${formatCalendar(tdbToCalendar(mi.end), false)} TDB). ${ca}` });
      }
    }
    const [ya, yb] = eph.span().map((x) => tdbToCalendar(x).year);
    const avgChunk = metrics.chunkMs.length ? metrics.chunkMs.reduce((a, b) => a + b, 0) / metrics.chunkMs.length : 0;
    metrics.frameCpuMs = metrics.frameCpuMs * 0.95 + (performance.now() - cpu0) * 0.05;
    hud.frame(
      ro,
      `${(1000 / metrics.frameIntervalMs).toFixed(0)} fps · frame CPU ${metrics.frameCpuMs.toFixed(2)} ms · ephemeris ${ya}–${yb} (${eph.hi - eph.lo + 1} chunks, ${avgChunk.toFixed(0)} ms each)` +
        (metrics.mission ? ` · mission propagated in ${metrics.mission.propagateMs.toFixed(0)} ms (search ${metrics.mission.searchMs.toFixed(0)} ms)` : '') +
        (metrics.errors.length ? ` · WORKER ERROR: ${metrics.errors[0]}` : ''),
    );
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// For automated checks and debugging from the console.
Object.assign(window, { sendit: { store, camera, metrics, eph, bodies: BODIES.map((b) => b.id), frameKey: () => frameKey(store.get().frame, (i) => BODIES[i].id) } });
