/**
 * Entry point: the flight-plan editor. Wires the worker-fed ephemeris, the
 * replay worker, the store, camera, scene, labels, HUD and editor panels, and
 * runs the frame loop.
 *
 * Data flow: an edit changes `plan` in the store -> the replay client replays
 * it in the worker with the mission layer's `replay` (the scoring path) ->
 * the result and its trajectory samples land in `replay` in the store -> the
 * trajectory, burn arcs, event markers and panels are redrawn from it. No
 * trajectory is ever computed any other way.
 */
import './style.css';
import { deriveMeta } from './body-meta';
import { OrbitCamera } from './camera';
import { Editor } from './editor';
import { bodyName, CraftPanel, EventsPanel, MissionPanel, NodesPanel, ResultsPanel, Scrubber, StartPanel, type UiContext } from './editor-ui';
import { listEvents, eventMarker, type ListedEvent } from './events-view';
import { computeFrame, frameCenter, frameKey, newFrameState, parseFrameKey, toFrame, type FrameSpec } from './frames';
import { Hud, type Readout } from './hud';
import { bodyOrientation } from './orientation';
import { Layout } from './layout';
import { LeaderboardPanel } from './leaderboard-ui';
import { MapInput, nearestOnScreen } from './map-input';
import { poolSizing } from './schedule';
import { statusOf } from './status';
import { formatMet, el } from './dom';
import { Labels, type LabelItem } from './labels';
import { makeWorld, REPLAY_SAMPLE_STRIDE, simulationStartOffset, planErrors, type EventKind } from './mission-layer';
import { initialPlan, missionById, missionForLoadedPlan, MISSIONS } from './missions';
import { nodesOf } from './nodes';
import { anchorSegments, bodyPath, frameAt, trajectoryPath, type FrameContext, type FramePath } from './paths';
import { BODIES, BODY_DATA, BODY_GM, bodyIndex, Ephemeris } from './physics';
import { ChunkPool } from './chunk-pool';
import { PlannerOverlay } from './planner-ui';
import { ReplayClient } from './replay-client';
import { sandboxSpheres } from './replay-options';
import { SceneView, UNIT } from './scene';
import { loadSaved, parsePlanHash, planHash, save } from './share';
import { Store, WARP_RATES, type AppState } from './store';
import { calendarToTdb, formatCalendar, JULIAN_YEAR, parseCalendar, tdbToCalendar, utcMsToTdb } from './time';
import { SAMPLE_STRIDE, stateAt, trajectoryFrom, type Trajectory } from './trajectory';

const SPACECRAFT = -1;
const PATH_SAMPLES = 360;
const n = BODIES.length;
const meta = deriveMeta(BODIES);
const sunIndex = meta.findIndex((m) => m.parent < 0);

// ---------------------------------------------------------------------------
// Ephemeris fed by the chunk pool (any date, from the checkpoint asset) and by the replay worker (flight spans)

const eph = new Ephemeris();
const metrics = {
  chunkMs: [] as number[],
  frameCpuMs: 0,
  frameIntervalMs: 0,
  /** Edit to trajectory-on-screen, ms: replay client latency plus the redraw. */
  redrawLatencyMs: 0,
  errors: [] as string[],
};
let coverageVersion = 0;
/** Viewable dates: 1900 to 2150 (outside the 1950-2100 checkpoint asset chunks integrate outward, slowly). */
const VIEW_LIMIT = {
  lo: eph.chunkIndex(calendarToTdb({ year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0 })),
  hi: eph.chunkIndex(calendarToTdb({ year: 2150, month: 1, day: 1, hour: 0, minute: 0, second: 0 })),
};
/** Phones and small tablets: fewer chunk workers and a smaller chunk budget, whatever the core count claims. */
const smallTouch = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
const sizing0 = poolSizing(navigator.hardwareConcurrency, (navigator as { deviceMemory?: number }).deviceMemory);
const sizing = smallTouch ? { workers: Math.min(2, sizing0.workers), budget: Math.min(48, sizing0.budget) } : sizing0;
const pool = new ChunkPool(eph, VIEW_LIMIT, {
  onInstall() {
    coverageVersion++;
  },
  onError(message) {
    metrics.errors.push(message);
    console.error('chunk worker:', message);
  },
}, sizing);
metrics.chunkMs = pool.stats.buildMs;

const world = makeWorld(eph.physics, BODY_DATA);
const fingerprint = world.fingerprint;
const soi = new Map(sandboxSpheres().map((s) => [s.body, s.radius]));

// ---------------------------------------------------------------------------
// Initial state: shared link (#m=..&p=..) > saved work > sandbox. View params (#t=, frame=, ...) still apply.

const params = new URLSearchParams(location.hash.slice(1));
const earth = bodyIndex('earth');
const home = earth >= 0 ? earth : 0;

function initialEditor(): Pick<AppState, 'missionId' | 'plan' | 'parked' | 'notice'> {
  const link = parsePlanHash(location.hash, fingerprint);
  const saved = loadSaved();
  if (link.plan) {
    const m = missionForLoadedPlan(link.missionId ?? undefined, link.plan);
    return { missionId: m.missionId, plan: link.plan, parked: [], notice: [link.mismatch, m.notice].filter(Boolean).join('\n') || null };
  }
  if (saved) {
    const m = missionForLoadedPlan(saved.missionId, saved.plan);
    return { missionId: m.missionId, plan: saved.plan, parked: saved.parked, notice: [link.error, m.notice].filter(Boolean).join('\n') || null };
  }
  return { missionId: 'sandbox', plan: initialPlan(MISSIONS[0], fingerprint), parked: [], notice: link.error };
}

function defaultSecondary(c: number): number {
  let best = -1;
  BODIES.forEach((b, i) => {
    if (meta[i].parent === c && (best < 0 || b.gm > BODIES[best].gm)) best = i;
  });
  if (best >= 0) return best;
  return meta[c].parent >= 0 ? meta[c].parent : (c + 1) % n;
}

const ed0 = initialEditor();
function initialTime(): number {
  const p = params.get('t');
  if (p !== null) {
    if (/^-?\d+(\.\d+)?(e\d+)?$/.test(p)) return Number(p);
    const c = parseCalendar(p);
    if (c) return calendarToTdb(c);
  }
  return ed0.plan.epoch + simulationStartOffset(ed0.plan.start) + 60;
}
const focusParam = params.get('focus');
const initialFocus = focusParam === 'sc' ? SPACECRAFT : focusParam && bodyIndex(focusParam) >= 0 ? bodyIndex(focusParam) : home;
const initialFrame: FrameSpec = parseFrameKey(params.get('frame') ?? '', bodyIndex) ?? { kind: 'inertial', center: home };
const t0 = initialTime();

const store = new Store<AppState>({
  t: t0,
  paused: params.get('paused') !== '0',
  warpIndex: Math.max(0, Math.min(WARP_RATES.length - 1, Number(params.get('warp') ?? 3))),
  focus: initialFocus,
  frame: initialFrame,
  loadingTarget: t0,
  loadingChunks: 0,
  ...ed0,
  selectedNode: null,
  selectedEvent: null,
  replay: null,
  replayStatus: 'idle',
});
const editor = new Editor(store, fingerprint);

// ---------------------------------------------------------------------------
// Scene, camera, labels, HUD, panels

const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('labels') as HTMLElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const layout = new Layout(hudRoot);
document.documentElement.classList.toggle('touch', matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const scene = new SceneView(
  canvas,
  BODIES.map((b, i) => ({ radius: b.radius, color: meta[i].color, emissive: i === sunIndex })),
  sunIndex,
);
// Device pixel ratio: 2 at most, 1.5 on small touch screens (fill rate, battery).
const DPR_CAP = smallTouch ? 1.5 : 2;
scene.renderer.setPixelRatio(Math.min(DPR_CAP, window.devicePixelRatio || 1));
const camera = new OrbitCamera();
camera.inertia = !reducedMotion.matches;
reducedMotion.addEventListener?.('change', () => (camera.inertia = !reducedMotion.matches));
camera.setDistance(Number(params.get('dist') ?? 6e7), true);
if (params.has('az')) camera.azimuth = Number(params.get('az'));
if (params.has('el')) camera.elevation = Number(params.get('el'));

const labels = new Labels(overlay, (key) => {
  if (key === 'sc') store.set({ focus: SPACECRAFT });
  else if (key.startsWith('node:')) store.set({ selectedNode: Number(key.slice(5)) });
  else if (key.startsWith('burn:')) store.set({ selectedNode: Number(key.split(':')[1]) });
  else if (key.startsWith('ev:')) {
    const i = Number(key.slice(3));
    const ev = store.get().replay?.result.events[i];
    if (ev) store.set({ selectedEvent: i, t: ev.t, paused: true, loadingTarget: ev.t });
  } else store.set({ focus: Number(key) });
});

function jumpTo(t: number): void {
  store.set({ loadingTarget: t });
}

const hud = new Hud(
  layout.topbar,
  hudRoot,
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
      {
        label: 'Flight start',
        get t() {
          const pl = store.get().plan;
          return pl.epoch + simulationStartOffset(pl.start);
        },
      },
      { label: 'Now', t: utcMsToTdb(Date.now()) },
      { label: 'J2000', t: 0 },
    ],
    spacecraftName: 'Spacecraft',
    status: (s) => statusOf(s, bodyName),
  },
);

// Spacecraft trajectory of the latest replay. Subscribed before the panels so they see it updated.
let trajectory: Trajectory | null = null;
store.subscribe((s, p) => {
  if (s.replay !== p.replay) {
    trajectory = s.replay ? trajectoryFrom(toStride7(s.replay.samples)) : null;
    trajectoryDirty = true;
  }
});
const tmpState = new Float64Array(6);
const tmpPos = new Float64Array(3 * n);

/** Body (id) whose sphere of influence holds the craft at mission time t; the launch / start body otherwise. */
function dominantBody(tMission: number): string {
  const plan = store.get().plan;
  const fallback = plan.start.kind === 'state' ? plan.start.center : 'earth';
  const t = plan.epoch + tMission;
  if (!trajectory || !stateAt(trajectory, t, tmpState) || !eph.evaluate(t, tmpPos, null)) return fallback;
  let best: string | null = null;
  let bestR = Infinity;
  for (let i = 0; i < n; i++) {
    const r = soi.get(BODIES[i].id);
    if (r === undefined || r >= bestR) continue;
    const d = Math.hypot(tmpState[0] - tmpPos[3 * i], tmpState[1] - tmpPos[3 * i + 1], tmpState[2] - tmpPos[3 * i + 2]);
    if (d < r) {
      best = BODIES[i].id;
      bestR = r;
    }
  }
  return best ?? BODIES[sunIndex].id;
}

function shareUrl(): string | null {
  const s = store.get();
  const h = planHash(s.missionId, s.plan);
  return h ? `${location.origin}${location.pathname}${h}` : null;
}

const ui: UiContext = {
  store,
  editor,
  soi,
  dominantBody,
  focusBody(id) {
    const i = bodyIndex(id);
    if (i >= 0) store.set({ focus: i });
  },
  shareUrl,
  openPlanner(tab, node) {
    planner.open(tab, node ?? null);
  },
};

function failureKinds(): readonly EventKind[] {
  const def = missionById(store.get().missionId)?.def;
  const reentry = def ? JSON.stringify(def.objectives).includes('"reentry"') || JSON.stringify(def.objectives).includes('"return"') : false;
  return reentry ? ['impact'] : ['impact', 'atmosphere-entry'];
}

const planner = new PlannerOverlay(store, editor, eph, pool);
const nodesPanel = new NodesPanel(ui);
const eventsPanel = new EventsPanel(ui, () => ({ failureKinds: failureKinds(), dominant: (t: number) => dominantBody(t - store.get().plan.epoch) }));
const leaderboard = new LeaderboardPanel(store, editor);
hudRoot.append(leaderboard.dialog);
// One instance of each panel; the layout puts it in a dock (wide) or a tab (side / sheet).
layout.add(hud.timePanel, 'view', 'left');
layout.add(new MissionPanel(ui).root, 'mission', 'left');
layout.add(new ResultsPanel(ui).root, 'results', 'left');
layout.add(leaderboard.root, 'results', 'left');
layout.add(new StartPanel(ui).root, 'start', 'left');
layout.add(new CraftPanel(ui).root, 'mission', 'left');
{
  const all = el('input', { type: 'checkbox', id: 'show-all-revs' });
  all.onchange = () => {
    showAllRevs = all.checked;
    viewDirty = true;
  };
  hud.viewPanel.querySelector('.sec-body')!.append(el('label', { className: 'check' }, all, ' Show all revolutions (else only the one at the cursor is bright)'));
}
layout.add(hud.viewPanel, 'view', 'right');
layout.add(nodesPanel.root, 'nodes', 'right');
layout.add(eventsPanel.root, 'events', 'right');
layout.add(hud.infoPanel, 'view', 'right');
layout.bottom.prepend(new Scrubber(ui).root);
// Selecting a node on a phone brings its editor up.
store.subscribe((s, p) => {
  if (s.selectedNode !== null && s.selectedNode !== p.selectedNode && layout.mode !== 'wide') layout.showTab('nodes');
});

let viewDirty = true;
/** Size the canvas and centre the camera's focus in the part of the map no panel covers. */
function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  scene.resize(w, h);
  const f = layout.freeRect();
  const cx = (f.left + (window.innerWidth - f.right)) / 2;
  const cy = (f.top + (window.innerHeight - f.bottom)) / 2;
  scene.camera.setViewOffset(w, h, Math.round(w / 2 - cx), Math.round(h / 2 - cy), w, h);
  scene.camera.updateProjectionMatrix();
  viewDirty = true;
}
window.addEventListener('resize', resize);
layout.onChange(resize);
resize();
store.subscribe(() => {
  viewDirty = true;
});
document.addEventListener('visibilitychange', () => {
  last = performance.now();
  viewDirty = true;
});

// ---------------------------------------------------------------------------
// Replay: every plan change is replayed in the worker

const replayClient = new ReplayClient(eph, {
  onResult(d) {
    store.set({
      replay: { plan: d.plan, result: d.result, evaluation: d.evaluation, samples: d.samples, replayMs: d.replayMs, latencyMs: d.latencyMs, preview: d.preview },
      replayStatus: d.stale || d.preview !== null ? 'running' : store.get().replayStatus,
    });
  },
  onChunk(k, coeffs) {
    if (eph.install(k, coeffs)) {
      coverageVersion++;
      pool.installed();
    }
  },
  onStatus(s) {
    store.set({ replayStatus: s });
  },
  onError(message) {
    metrics.errors.push(message);
    console.error('replay worker:', message);
  },
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function planChanged(): void {
  const s = store.get();
  if (planErrors(s.plan).plan.length + planErrors(s.plan).burns.size === 0) replayClient.request(s.plan, s.missionId);
  else store.set({ replayStatus: 'idle' });
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const st = store.get();
    save(st.missionId, st.plan, st.parked);
    const h = planHash(st.missionId, st.plan);
    if (h && location.hash !== h) history.replaceState(null, '', h);
  }, 250);
}

store.subscribe((s, p) => {
  if (s.plan.epoch !== p.plan.epoch && s.loadingTarget === null) {
    // Liftoff / start moved: keep the time cursor at the same mission elapsed time, inside the flight.
    const met = Math.max(simulationStartOffset(s.plan.start), Math.min(s.plan.duration, s.t - p.plan.epoch));
    store.set({ t: s.plan.epoch + met, loadingTarget: s.plan.epoch + met });
  }
  if (s.plan !== p.plan || s.missionId !== p.missionId) planChanged();
  else if (s.parked !== p.parked) save(s.missionId, s.plan, s.parked);
  if (s.selectedEvent !== p.selectedEvent || s.selectedNode !== p.selectedNode) markersDirty = true;
});
planChanged();

function toStride7(samples: Float64Array): Float64Array {
  const m = samples.length / REPLAY_SAMPLE_STRIDE;
  const out = new Float64Array(m * SAMPLE_STRIDE);
  for (let i = 0; i < m; i++) out.set(samples.subarray(i * REPLAY_SAMPLE_STRIDE, i * REPLAY_SAMPLE_STRIDE + 7), i * SAMPLE_STRIDE);
  return out;
}

// ---------------------------------------------------------------------------
// Input: drag rotates, wheel zooms, a click on the trajectory adds a burn there

// Tap popover: "add node here" at the picked trajectory point (touch and pen; a mouse click adds directly).
const tapPop = el('div', { className: 'tap-pop', role: 'dialog', ariaLabel: 'Trajectory point' });
tapPop.hidden = true;
hudRoot.append(tapPop);
let tapPick: { t: number; x: number; y: number } | null = null;
function hideTapPop(): void {
  tapPop.hidden = true;
  tapPick = null;
}
function showTapPop(t: number, x: number, y: number): void {
  tapPick = { t, x, y };
  const add = el('button', { className: 'btn primary', type: 'button', textContent: 'Add node here' });
  add.onclick = () => {
    const p = tapPick;
    hideTapPop();
    if (p) addNodeAt(p.t);
  };
  const close = el('button', { className: 'btn', type: 'button', textContent: '✕', ariaLabel: 'Dismiss' });
  close.onclick = hideTapPop;
  tapPop.replaceChildren(el('span', { className: 'tp-t', textContent: formatMet(t, 0) }), add, close);
  tapPop.hidden = false;
  const W = window.innerWidth;
  const pw = 250;
  tapPop.style.left = `${Math.max(8, Math.min(W - pw - 8, x - pw / 2))}px`;
  tapPop.style.top = `${Math.max(60, y - 74)}px`;
}

new MapInput(canvas, {
  rotate: (a, e) => camera.rotate(a, e),
  zoom: (f) => camera.zoom(f),
  fling: (a, e) => camera.fling(a, e),
  stop: () => camera.stop(),
  changed: () => {
    viewDirty = true;
  },
  tap(x, y, type) {
    const touch = type !== 'mouse';
    const t = pickTrajectory(x, y, touch ? 32 : 14);
    if (t === null || t < simulationStartOffset(store.get().plan.start)) {
      hideTapPop();
      return;
    }
    if (touch) showTapPop(t, x, y);
    else addNodeAt(t);
  },
  doubleTap(x, y) {
    hideTapPop();
    const rect = canvas.getBoundingClientRect();
    const i = nearestOnScreen(n, (k, out) => scene.project(lastFramePos, 3 * k, camera.position, out), x - rect.left, y - rect.top, 44);
    if (i >= 0) store.set({ focus: i });
  },
});
const lastFramePos = new Float64Array(3 * n);

/** Nearest drawn trajectory sample to a screen point (within 12 px), as mission time. */
function pickTrajectory(x: number, y: number, radius = 14): number | null {
  const path = trajectoryPathCache;
  if (!path) return null;
  const rect = canvas.getBoundingClientRect();
  const px = x - rect.left;
  const py = y - rect.top;
  let best = radius * radius;
  let bestT: number | null = null;
  const pr = { x: 0, y: 0 };
  for (let i = 0; i < path.times.length; i++) {
    if (!scene.project(path.points, 3 * i, camera.position, pr)) continue;
    const d2 = (pr.x - px) ** 2 + (pr.y - py) ** 2;
    if (d2 < best) {
      best = d2;
      bestT = path.times[i];
    }
  }
  return bestT === null ? null : bestT - store.get().plan.epoch;
}

function addNodeAt(t: number): void {
  editor.addNode(Math.round(t * 10) / 10, { kind: 'orbital', body: dominantBody(t) });
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.ctrlKey || e.metaKey || planner.isOpen || (e.target as HTMLElement).closest?.('dialog')) return;
  const s = store.get();
  const i = s.selectedNode;
  const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  const nudge: Record<string, [0 | 1 | 2, number]> = { KeyW: [0, 1], KeyS: [0, -1], KeyD: [1, 1], KeyA: [1, -1], KeyE: [2, 1], KeyQ: [2, -1] };
  if (i !== null && nudge[e.code]) {
    e.preventDefault();
    const [axis, sign] = nudge[e.code];
    editor.nudgeDv(i, axis, sign * mult * nodesPanel.step());
    return;
  }
  if (i !== null && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    editor.nudgeTime(i, (e.code === 'BracketLeft' ? -1 : 1) * mult * nodesPanel.timeStep());
    return;
  }
  if (i !== null && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    editor.removeNode(i);
    return;
  }
  if (e.key === '?') hud.showKeys();
  else if (e.key === 'Escape') {
    hideTapPop();
    store.set({ selectedNode: null, selectedEvent: null });
  }
  else if (e.code === 'Space') {
    e.preventDefault();
    store.set({ paused: !s.paused });
  } else if (e.key === ',') hud.stepWarp(-1);
  else if (e.key === '.') hud.stepWarp(1);
  else if (e.key === 'n' || e.key === 'N') nodesPanel.addAtCursor();
});

// ---------------------------------------------------------------------------
// Paths

const ctx: FrameContext = { count: n, gm: BODY_GM, evaluate: (t, p, v) => eph.evaluate(t, p, v), orient: bodyOrientation };

interface PathState {
  center: number; // time the window is centred on
  span: number;
  coverage: number; // coverageVersion when computed
  clipped: boolean;
}
const pathState: (PathState | null)[] = new Array(n).fill(null);
let trajectoryDirty = false;
let trajectoryCoverage = -1;
let trajectoryClipped = false;
let trajectoryPathCache: FramePath | null = null;
let markersDirty = true;

interface Marker {
  key: string;
  text: string;
  cls: string;
  pos: Float64Array;
  priority: number;
  color: string;
}
let markers: Marker[] = [];
/** Ignition / cutoff marker pairs; drawn only when they are far enough apart on screen. */
let burnEnds: { node: string; start: Marker; end: Marker }[] = [];
const projA = { x: 0, y: 0 };
const projB = { x: 0, y: 0 };
let listed: ListedEvent[] = [];

/** Time span drawn for body i's path in this frame (one orbit, or the period of the frame's own motion). */
const ROT_TMP = new Float64Array(9);
function pathSpan(i: number, frame: FrameSpec): number {
  // Turning with a surface, any longer span winds into a spiral: one rotation shows each body's daily circle.
  if (frame.kind === 'surface') return (2 * Math.PI) / Math.abs(bodyOrientation(frame.center, store.get().t, ROT_TMP));
  if (Number.isFinite(meta[i].period)) return meta[i].period * 1.02;
  const c = frameCenter(frame);
  if (c !== null && Number.isFinite(meta[c].period)) return meta[c].period;
  return JULIAN_YEAR;
}

function updatePaths(t: number, frame: FrameSpec, budget: number): void {
  pathsPending = false;
  const c = frameCenter(frame);
  for (let i = 0; i < n; i++) {
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
    if (budget <= 0) {
      pathsPending = true;
      return;
    }
    budget--;
    // Samples the ephemeris cannot evaluate yet are dropped; redrawn when coverage grows.
    const p = bodyPath(ctx, frame, i, t - span / 2, t + span / 2, PATH_SAMPLES);
    scene.setBodyPath(i, anchorSegments(p.points, UNIT));
    pathState[i] = { center: t, span, coverage: coverageVersion, clipped: p.times.length < PATH_SAMPLES + 1 };
  }
}

function invalidatePaths(): void {
  pathState.fill(null);
  trajectoryDirty = true;
}

/** Rebuild the trajectory, burn arcs and markers in the current frame. */
function rebuildTrajectory(frame: FrameSpec): void {
  const s = store.get();
  const r = s.replay;
  trajectoryCoverage = coverageVersion;
  if (!r || !trajectory || trajectory.n < 2) {
    scene.setTrajectory(null);
    scene.setBurnArcs(null);
    trajectoryPathCache = null;
    markers = [];
    return;
  }
  const path = trajectoryPath(ctx, frame, trajectory);
  trajectoryClipped = path.times.length < trajectory.n;
  trajectoryPathCache = path;
  scene.setTrajectory(anchorSegments(path.points, UNIT));
  scene.setTrajectoryDim(r.plan !== s.plan);
  // Burn arcs: the samples between each burn's actual ignition and cutoff.
  const arcs: ReturnType<typeof anchorSegments> = [];
  const times = path.times;
  r.result.burns.forEach((b, i) => {
    if (!(b.burnTime > 0)) return;
    const ta = r.plan.epoch + r.plan.burns[i].start;
    const tb = ta + b.burnTime;
    let lo = 0;
    while (lo < times.length && times[lo] < ta) lo++;
    let hi = lo;
    while (hi < times.length && times[hi] <= tb) hi++;
    const from = Math.max(0, lo - 1);
    const to = Math.min(times.length, hi + 1);
    if (to - from >= 2) arcs.push(...anchorSegments(path.points.slice(3 * from, 3 * to), UNIT));
  });
  scene.setBurnArcs(arcs);
  rebuildMarkers(frame);
}

function rebuildMarkers(frame: FrameSpec): void {
  markersDirty = false;
  markers = [];
  const s = store.get();
  const r = s.replay;
  if (!r || !trajectory) return;
  listed = listEvents(r.result.events, soi, { failureKinds: failureKinds(), dominant: (t) => dominantBody(t - r.plan.epoch) });
  const scratch = { pos: new Float64Array(3 * n), vel: new Float64Array(3 * n), fs: newFrameState() };
  const st = new Float64Array(6);
  const place = (t: number): Float64Array | null => {
    if (!stateAt(trajectory!, t, st)) return null;
    const f = frameAt(ctx, frame, t, scratch);
    if (!f) return null;
    const q = new Float64Array(3);
    toFrame(f, st, 0, q, 0);
    return q;
  };
  for (const x of listed) {
    // Periapsis / apoapsis markers only for the selected event or bodies other than the many-orbit primary.
    const isExt = x.role === 'event' && (x.ev.kind === 'periapsis' || x.ev.kind === 'apoapsis');
    if (isExt && listed.length > 40 && s.selectedEvent !== x.index) continue;
    const pos = place(x.ev.t);
    if (!pos) continue;
    markers.push({
      key: `ev:${x.index}`,
      text: eventMarker(x, bodyName),
      cls: `marker ev ${x.failure ? 'failure' : ''} ${x.role} ${s.selectedEvent === x.index ? 'selected' : ''}`,
      pos,
      priority: x.failure ? 900 : s.selectedEvent === x.index ? 800 : x.role === 'closest' ? 20 : 12,
      color: x.failure ? '#ff4d4d' : x.role === 'closest' ? '#ffd36b' : '#9fc6ff',
    });
  }
  // Nodes of the replayed plan, at the node (burn centre), and each burn's flown ignition and cutoff.
  burnEnds = [];
  if (r.plan === s.plan) {
    nodesOf(r.plan).forEach((x, i) => {
      const pos = place(r.plan.epoch + x.node.t);
      if (!pos) return;
      const sel = s.selectedNode === i;
      markers.push({ key: `node:${i}`, text: `Burn ${i + 1}`, cls: `marker node ${sel ? 'selected' : ''}`, pos, priority: sel ? 950 : 700, color: '#ff8a3d' });
      const flown = r.result.burns[i];
      if (!flown || !(flown.burnTime > 0)) return;
      const t0 = r.plan.epoch + r.plan.burns[i].start;
      const t1 = t0 + flown.burnTime;
      const short = flown.burnTime < r.plan.burns[i].duration * 0.999;
      const a = place(t0);
      const b = place(t1);
      if (!a || !b) return;
      const dur = flown.burnTime >= 120 ? `${(flown.burnTime / 60).toFixed(1)} min` : `${flown.burnTime.toFixed(0)} s`;
      const start: Marker = { key: `burn:${i}:s`, text: `▶ B${i + 1} start${sel ? ` ${formatMet(r.plan.burns[i].start, 0)}` : ''}`, cls: `marker burn-end start ${sel ? 'selected' : ''}`, pos: a, priority: sel ? 940 : 690, color: '#ff8a3d' };
      const end: Marker = { key: `burn:${i}:e`, text: short ? `■ B${i + 1} cut short · ${dur} · out of propellant` : `■ B${i + 1} end · ${dur}`, cls: `marker burn-end end ${short ? 'short' : ''} ${sel ? 'selected' : ''}`, pos: b, priority: short ? 945 : sel ? 940 : 690, color: short ? '#ff4d4d' : '#ff8a3d' };
      burnEnds.push({ node: `node:${i}`, start, end });
    });
  }
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

function phaseAt(t: number): string {
  const r = store.get().replay;
  if (!r) return '';
  const tm = t - r.plan.epoch;
  for (let i = 0; i < r.plan.burns.length; i++) {
    const b = r.plan.burns[i];
    const flown = r.result.burns[i]?.burnTime ?? 0;
    if (tm >= b.start && tm <= b.start + flown) return `Burn ${i + 1}`;
  }
  return 'Coast';
}

/**
 * Vertex window drawn bright around the time cursor: when the craft is on a
 * bound orbit whose period is short against the drawn path (a parking orbit
 * wrapped dozens of times), the quarter revolution before the cursor and one
 * revolution after it; the rest is drawn faint. "Show all revolutions" in
 * the View panel turns this off.
 */
let showAllRevs = false;
function revolutionWindow(t: number, times: Float64Array | number[], scVisible: boolean): [number, number] {
  const all: [number, number] = [0, times.length - 1];
  if (showAllRevs || !scVisible || times.length < 2) return all;
  const r = store.get().replay;
  if (!r) return all;
  const di = bodyIndex(dominantBody(t - r.plan.epoch));
  if (di < 0) return all;
  const dx = scState[0] - pos[3 * di], dy = scState[1] - pos[3 * di + 1], dz = scState[2] - pos[3 * di + 2];
  const vx = scState[3] - vel[3 * di], vy = scState[4] - vel[3 * di + 1], vz = scState[5] - vel[3 * di + 2];
  const mu = BODIES[di].gm;
  const inv = 2 / Math.hypot(dx, dy, dz) - (vx * vx + vy * vy + vz * vz) / mu;
  if (!(inv > 0)) return all;
  const P = 2 * Math.PI * Math.sqrt((1 / inv) ** 3 / mu);
  if (!(P * 4 < times[times.length - 1] - times[0])) return all;
  const idx = (tt: number) => {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (times[m] <= tt) lo = m + 1;
      else hi = m;
    }
    return Math.max(0, lo - 1);
  };
  return [idx(t - 0.25 * P), idx(t + 1.05 * P) + 1];
}
let lastRender = 0;
let renderCount = 0;
const busyLabel = () => (store.get().paused && camera.settled() ? 'idle when still · ' : '');
let renderedCoverage = -1;
let pathsPending = true;
function tick(now: number): void {
  const dtReal = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (now - lastRender < 200) metrics.frameIntervalMs = metrics.frameIntervalMs * 0.95 + (now - lastRender) * 0.05;
  const cpu0 = performance.now();
  let s = store.get();

  // Time.
  if (s.loadingTarget !== null) {
    if (eph.covers(s.loadingTarget)) store.set({ t: s.loadingTarget, loadingTarget: null, loadingChunks: 0 });
  } else if (!s.paused) {
    const tn = s.t + dtReal * WARP_RATES[s.warpIndex];
    if (eph.covers(tn)) store.set({ t: tn });
    else store.set({ loadingTarget: tn });
  }
  s = store.get();
  const tFocus = s.loadingTarget ?? s.t;
  const k = eph.chunkIndex(tFocus);
  const rate = s.paused ? 0 : WARP_RATES[s.warpIndex];
  const pl = s.plan;
  pool.want({
    view: k,
    direction: rate > 0 ? 1 : 0,
    // Two seconds of warp ahead (at least the next chunk), capped.
    ahead: rate > 0 ? Math.min(12, Math.ceil((2 * rate) / eph.chunkSpan) + 1) : 0,
    flight: Number.isFinite(pl.epoch) && pl.duration > 0 ? { lo: eph.chunkIndex(pl.epoch), hi: eph.chunkIndex(pl.epoch + Math.min(pl.duration, 50 * JULIAN_YEAR)) } : { lo: 0, hi: -1 },
  });
  if (s.loadingTarget !== null && coverageVersion !== lastCoverageForWant) {
    lastCoverageForWant = coverageVersion;
    store.set({ loadingChunks: pool.missing({ lo: k, hi: k }) });
  }

  const t = s.t;
  // Render only when something can have changed: time running, the view or store touched,
  // camera moving, new ephemeris coverage, paths or trajectory pending. A slow heartbeat
  // picks up anything else (textures arriving). requestAnimationFrame already stops in hidden tabs.
  const busy = !s.paused || s.loadingTarget !== null || viewDirty || !camera.settled() || coverageVersion !== renderedCoverage || trajectoryDirty || markersDirty || pathsPending;
  if (!busy && now - lastRender < 1000) {
    requestAnimationFrame(tick);
    return;
  }
  viewDirty = false;
  renderedCoverage = coverageVersion;
  lastRender = now;
  renderCount++;
  if (eph.evaluate(t, pos, vel)) {
    const frame = s.frame;
    computeFrame(frame, { count: n, pos, vel, gm: BODY_GM, t, orient: bodyOrientation }, fs);
    for (let i = 0; i < n; i++) toFrame(fs, pos, 3 * i, framePos, 3 * i);
    updatePaths(t, frame, 2);

    // Spacecraft.
    if (trajectoryDirty || (trajectoryClipped && trajectoryCoverage !== coverageVersion)) {
      trajectoryDirty = false;
      rebuildTrajectory(frame);
      const r = store.get().replay;
      if (r) metrics.redrawLatencyMs = r.latencyMs + (performance.now() - cpu0);
    } else if (markersDirty) rebuildMarkers(frame);
    let scVisible = false;
    if (trajectory) {
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
        scene.setTrajectorySplit(Math.max(0, lo - 1), times.length, revolutionWindow(t, times, scVisible));
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
    scene.visuals.setTime(t, fs.axes);
    scene.render(camera.position, camera.target, framePos);
    camera.markRendered();

    // Labels and markers.
    const items: LabelItem[] = [];
    for (let i = 0; i < n; i++) {
      const on = scene.project(framePos, 3 * i, camera.position, proj);
      const d = Math.hypot(framePos[3 * i] - camera.position[0], framePos[3 * i + 1] - camera.position[1], framePos[3 * i + 2] - camera.position[2]);
      const px = scene.pixelRadius(BODIES[i].radius, d);
      items.push({ key: String(i), text: BODIES[i].name, color: meta[i].color, priority: (i === s.focus ? 1000 : 0) + Math.log10(BODIES[i].gm), x: proj.x, y: proj.y, marker: px < 3, offset: px < 3 ? 0 : px, onScreen: on });
    }
    if (scVisible) {
      const on = scene.project(scFrame, 0, camera.position, proj);
      items.push({ key: 'sc', text: 'Spacecraft', color: '#7dffb0', priority: s.focus === SPACECRAFT ? 1000 : 13.5, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on });
    }
    // Markers are drawn in the frame at their own time; in a moving frame they sit on the drawn path, as the path does.
    for (const m of markers) {
      const on = scene.project(m.pos, 0, camera.position, proj);
      items.push({ key: m.key, text: m.text, color: m.color, priority: m.priority, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on, className: m.cls });
    }
    // Burn ends: expanded once ignition and cutoff are 28 px apart on screen, else the single "Burn N" marker stands for both.
    for (const be of burnEnds) {
      const onA = scene.project(be.start.pos, 0, camera.position, projA);
      const onB = scene.project(be.end.pos, 0, camera.position, projB);
      if (!onA || !onB || Math.hypot(projA.x - projB.x, projA.y - projB.y) < 28) continue;
      items.push({ key: be.start.key, text: be.start.text, color: be.start.color, priority: be.start.priority, x: projA.x, y: projA.y, marker: true, offset: 0, onScreen: true, className: be.start.cls });
      items.push({ key: be.end.key, text: be.end.text, color: be.end.color, priority: be.end.priority, x: projB.x, y: projB.y, marker: true, offset: 0, onScreen: true, className: be.end.cls });
    }
    labels.update(items);
    lastFramePos.set(framePos);

    // Readouts.
    const ro: Readout[] = [];
    if (s.focus !== SPACECRAFT) ro.push(readout(BODIES[s.focus].name, pos, 3 * s.focus, vel, 3 * s.focus, frame));
    const r = s.replay;
    if (r && trajectory) {
      if (scVisible) {
        const dom = dominantBody(t - r.plan.epoch);
        const di = bodyIndex(dom);
        const alt = Math.hypot(scState[0] - pos[3 * di], scState[1] - pos[3 * di + 1], scState[2] - pos[3 * di + 2]) - BODIES[di].radius;
        const vr = Math.hypot(scState[3] - vel[3 * di], scState[4] - vel[3 * di + 1], scState[5] - vel[3 * di + 2]);
        ro.push(readout('Spacecraft', scState, 0, scState, 3, frame, `${phaseAt(t)} · ${BODIES[di].name} altitude ${Math.round(alt / 1000).toLocaleString('en-US')} km, ${vr.toFixed(0)} m/s`));
      } else {
        ro.push({ title: 'Spacecraft', relativeTo: '—', distance: NaN, speed: NaN, extra: `Not flying at this time (${formatCalendar(tdbToCalendar(r.plan.epoch), false)} to ${Number.isFinite(r.result.finalT) ? formatCalendar(tdbToCalendar(r.result.finalT), false) : '—'} TDB).` });
      }
    }
    const avgChunk = metrics.chunkMs.length ? metrics.chunkMs.reduce((a, b) => a + b, 0) / metrics.chunkMs.length : 0;
    metrics.frameCpuMs = metrics.frameCpuMs * 0.95 + (performance.now() - cpu0) * 0.05;
    const st = replayClient.stats;
    hud.frame(
      ro,
      `${busyLabel()}${(1000 / metrics.frameIntervalMs).toFixed(0)} fps · frame CPU ${metrics.frameCpuMs.toFixed(2)} ms · ${eph.chunks().length} ephemeris chunks (${avgChunk.toFixed(0)} ms each)` +
        (st.runs ? ` · replay ${st.lastReplayMs.toFixed(0)} ms, edit→redraw ${metrics.redrawLatencyMs.toFixed(0)} ms` : '') +
        (metrics.errors.length ? ` · WORKER ERROR: ${metrics.errors[0]}` : ''),
    );
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// For automated checks and debugging from the console.
Object.assign(window, {
  sendit: {
    store,
    editor,
    camera,
    metrics,
    eph,
    pool,
    planner,
    replayStats: replayClient.stats,
    nodesOf: () => nodesOf(store.get().plan),
    shareUrl,
    layout,
    leaderboard,
    /** Frames actually rendered so far (render-on-demand check). */
    renders: () => renderCount,
    listedEvents: () => listed,
    bodies: BODIES.map((b) => b.id),
    frameKey: () => frameKey(store.get().frame, (i) => BODIES[i].id),
    /** Screen position of the drawn trajectory at mission time t (for tests clicking on it). */
    screenAt(tMission: number): { x: number; y: number } | null {
      const path = trajectoryPathCache;
      if (!path) return null;
      const t = store.get().plan.epoch + tMission;
      let best = 0;
      for (let i = 0; i < path.times.length; i++) if (Math.abs(path.times[i] - t) < Math.abs(path.times[best] - t)) best = i;
      const pr = { x: 0, y: 0 };
      if (!scene.project(path.points, 3 * best, camera.position, pr)) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: pr.x + rect.left, y: pr.y + rect.top };
    },
  },
});
