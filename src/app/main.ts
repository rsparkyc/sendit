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
import { bodyName, CraftPanel, DV_LEVELS, T_LEVELS, EventsPanel, MissionPanel, NodesPanel, ResultsPanel, StartPanel, type UiContext } from './editor-ui';
import { listEvents, eventMarker, eventExplain, type ListedEvent } from './events-view';
import { crossingsNear, planeCrossings, type PlaneCrossing, type RelSample } from './plane-nodes';
import { drawnEnd, defaultDiscRadius, loadViewSettings } from './view-settings';
import { ViewOptions } from './view-ui';
import { Timeline } from './timeline';
import { fromSurface, onDistanceMode, setDistanceMode } from './units';
import { mul3 } from './body-rotation';
import { computeFrame, frameCenter, frameKey, newFrameState, parseFrameKey, toFrame, type FrameSpec } from './frames';
import { Hud, type Readout } from './hud';
import { bodyOrientation } from './orientation';
import { Layout } from './layout';
import { LeaderboardPanel } from './leaderboard-ui';
import { MapInput } from './map-input';
import { isDoubleTap, kindOfLabel, pickTarget, type PickCandidate } from './pick';
import { poolSizing } from './schedule';
import { objectiveBodies, statusOf } from './status';
import { formatMet, el } from './dom';
import { fmtTime, otherTime, parseTime, timeMode, onTimeMode, setTimeMode, nextTimeMode, TIME_MODE_LABEL, setTimeEpoch } from './timefmt';
import { Labels, type LabelItem } from './labels';
import type { Placed } from './label-layout';
import { geocentricLatitudeDeg, LAUNCH_SITES, makeWorld, REPLAY_SAMPLE_STRIDE, simulationStartOffset, planErrors, errorCount, type EventKind, type MissionPlan } from './mission-layer';
import { initialPlan, launchOf, missionById, missionForLoadedPlan, MISSIONS } from './missions';
import { nodesOf, separationsOf, stageAt } from './nodes';
import { orbitAbout, OrbitPanel, type OrbitSource } from './orbit-ui';
import { ECLIPTIC_POLE } from './orbit-elements';
import { separationTag, stageRows } from './vehicle';
import { MAP, stageStyle } from './palette';
import { siteShort } from './numfmt';
import { MapLegend } from './legend';
import { VehiclePanel, ascentMetrics } from './vehicle-ui';
import { anchorSegments, bodyPath, frameAt, trajectoryPath, type FrameContext, type FramePath } from './paths';
import { BODIES, BODY_DATA, BODY_GM, bodyIndex, Ephemeris } from './physics';
import { ChunkPool } from './chunk-pool';
import { PlannerOverlay } from './planner-ui';
import { ReplayClient } from './replay-client';
import { sandboxSpheres } from './replay-options';
import { SceneView, UNIT } from './scene';
import { loadSaved, parsePlanHash, planHash, save, versionNotice } from './share';
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
    return { missionId: m.missionId, plan: saved.plan, parked: saved.parked, notice: [link.error, versionNotice(saved.plan, fingerprint, 'saved'), m.notice].filter(Boolean).join('\n') || null };
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
  selectedSeparation: null,
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

/** Startup failed for good (no WebGL): say so on the page instead of leaving it blank, and stop. */
function startupFailed(message: string, e: unknown): never {
  document.documentElement.dataset.appError = message;
  const box = el('div', { className: 'notice', role: 'alert', textContent: message });
  box.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;z-index:10;padding:1rem;';
  document.body.append(box);
  throw e;
}
let sceneView: SceneView;
try {
  sceneView = new SceneView(
    canvas,
    BODIES.map((b, i) => ({ radius: b.radius, color: meta[i].color, emissive: i === sunIndex })),
    sunIndex,
  );
} catch (e) {
  startupFailed('This browser could not create a WebGL context, which the map needs. Check that WebGL (hardware acceleration) is enabled, or try another browser.', e);
}
const scene = sceneView;
// Device pixel ratio: 2 at most, 1.5 on small touch screens (fill rate, battery).
const DPR_CAP = smallTouch ? 1.5 : 2;
scene.renderer.setPixelRatio(Math.min(DPR_CAP, window.devicePixelRatio || 1));
const camera = new OrbitCamera();
camera.inertia = !reducedMotion.matches;
reducedMotion.addEventListener?.('change', () => (camera.inertia = !reducedMotion.matches));
camera.setDistance(Number(params.get('dist') ?? 6e7), true);
if (params.has('az')) camera.azimuth = Number(params.get('az'));
if (params.has('el')) camera.elevation = Number(params.get('el'));

/** Label clicks: a single click is a pick (labelPick); the second of a double click focuses (focusAt, same precedence as the map). */
let lastLabelTap: { t: number; x: number; y: number } | null = null;
const labels = new Labels(overlay, (key, x, y) => {
  const now = performance.now();
  if (isDoubleTap(lastLabelTap, now, x, y)) {
    lastLabelTap = null;
    focusAt(x, y, true, key);
    return;
  }
  lastLabelTap = { t: now, x, y };
  labelPick(key);
}, canvas);
/** What a single click on a label (or the map near one) does. */
function labelPick(key: string): void {
  const lay = lastLayout.find((p) => p.key === key);
  if (lay && lay.clusterSize > 0 && labels.expanded !== key) {
    // A cluster of co-located markers: the first tap fans them out; tap one of them to pick it.
    labels.expanded = key;
    return;
  }
  const at = labelPoint(key);
  if (key.startsWith('pn:')) {
    const c = crossings[Number(key.slice(3))];
    if (!c) return;
    const t = c.t;
    store.set({ t, paused: true, loadingTarget: t });
    showTapPop(t - store.get().plan.epoch, at.x, at.y, `${c.ascending ? 'Ascending' : 'Descending'} node: the orbit crosses ${crossingLabel} at ${c.inclinationDeg.toFixed(2)}° relative inclination. A plane change is cheapest here.`);
    return;
  }
  if (key.startsWith('site:') || key.startsWith('ax')) {
    const m = siteAndAxisTitles.get(key);
    if (m) showTapPop(null, at.x, at.y, m);
    return;
  }
  if (key === 'sc') store.set({ focus: SPACECRAFT });
  else if (key.startsWith('node:')) store.set({ selectedNode: Number(key.slice(5)) });
  else if (key.startsWith('burn:')) store.set({ selectedNode: Number(key.split(':')[1]) });
  else if (key.startsWith('sep:')) {
    const j = Number(key.slice(4));
    const m = markers.find((x) => x.key === key);
    store.set({ selectedSeparation: j, selectedNode: null, ...(m ? { t: m.t, paused: true, loadingTarget: m.t } : {}) });
    if (m && m.title && document.documentElement.classList.contains('touch')) showTapPop(null, at.x, at.y, m.title);
  } else if (key.startsWith('ev:')) {
    const i = Number(key.slice(3));
    const ev = store.get().replay?.result.events[i];
    if (ev) store.set({ selectedEvent: i, t: ev.t, paused: true, loadingTarget: ev.t });
    const x = listed.find((y) => y.index === i);
    if (x && document.documentElement.classList.contains('touch')) showTapPop(null, at.x, at.y, eventExplain(x, bodyName));
  } else store.set({ focus: Number(key) });
}
/** Screen position of a label's anchor point (for popovers). */
function labelPoint(key: string): { x: number; y: number } {
  const e = overlay.querySelector(`[data-key="${CSS.escape(key)}"]`) as HTMLElement | null;
  const m = e ? /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(e.style.transform) : null;
  const r = canvas.getBoundingClientRect();
  return m ? { x: Number(m[1]) + r.left, y: Number(m[2]) + r.top } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
const siteAndAxisTitles = new Map<string, string>();

function jumpTo(t: number): void {
  store.set({ loadingTarget: t });
}

/** The Orbit panel's state source; the status line's orbit reads it too (one orbit computation: orbit-ui.ts orbitAbout). */
let orbitSrc: OrbitSource | null = null;
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
    status: (s) => statusOf(s, bodyName, (id) => (orbitSrc ? orbitAbout(orbitSrc, s.t, id, 'equator') : null)),
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
const eventsPanel = new EventsPanel(ui, () => ({ failureKinds: failureKinds(), targets: eventTargets(), dominant: (t: number) => dominantBody(t - store.get().plan.epoch) }));
/** Bodies whose closest approach counts as an encounter: the mission's objective bodies, the node-plane target. */
function eventTargets(): string[] {
  const def = missionById(store.get().missionId)?.def;
  const out = def ? objectiveBodies(def.objectives) : [];
  if (viewSettings.nodePlane !== 'equator') out.push(viewSettings.nodePlane);
  return out;
}
const leaderboard = new LeaderboardPanel(store, editor);
hudRoot.append(leaderboard.dialog);
// One instance of each panel; the layout puts it in a dock (wide) or a tab (side / sheet).
layout.add(hud.timePanel, 'view', 'left');
layout.add(new MissionPanel(ui).root, 'mission', 'left');
layout.add(new ResultsPanel(ui).root, 'results', 'left');
layout.add(leaderboard.root, 'results', 'left');
layout.add(new StartPanel(ui).root, 'start', 'left');
layout.add(new VehiclePanel(ui).root, 'mission', 'left');
layout.add(new CraftPanel(ui).root, 'mission', 'left');
const viewSettings = loadViewSettings();
setDistanceMode(viewSettings.distances);
setTimeMode(viewSettings.timeMode);
setTimeEpoch(store.get().plan.epoch);
store.subscribe((s, p) => { if (s.plan.epoch !== p.plan.epoch) setTimeEpoch(s.plan.epoch); });
onTimeMode(() => {
  markersDirty = true;
  viewDirty = true;
  crossingsDirty = true;
  const st = store.get();
  if (st.replay) store.set({ replay: { ...st.replay } }); // panels, timeline and markers re-render in the new convention
});
onDistanceMode(() => {
  markersDirty = true;
  viewDirty = true;
  const st = store.get();
  if (st.replay) store.set({ replay: { ...st.replay } }); // re-render the status line and markers in the new convention
});
const viewOptions = new ViewOptions(store, editor, viewSettings, () => {
  viewDirty = true;
  crossingsDirty = true;
  updateDrawn();
  orbitPanel?.schedule();
});
layout.add(hud.viewPanel, 'view', 'right');
layout.add(viewOptions.root, 'view', 'right');
layout.add(nodesPanel.root, 'nodes', 'right');
layout.add(eventsPanel.root, 'events', 'right');
const orbitMass = (t: number): number => {
  const r = store.get().replay;
  if (!r) return NaN;
  const sm = r.samples;
  const N = sm.length / REPLAY_SAMPLE_STRIDE;
  let lo = 0, hi = N - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sm[mid * REPLAY_SAMPLE_STRIDE] <= t) lo = mid; else hi = mid; }
  return sm[lo * REPLAY_SAMPLE_STRIDE + 7];
};
const orbitPanel: OrbitPanel = new OrbitPanel(store, orbitSrc = {
  craft: (t, out) => { if (!trajectory || !stateAt(trajectory, t, out)) return false; out[6] = orbitMass(t); return true; },
  bodies: (t, pos, vel) => eph.evaluate(t, pos, vel),
  dominant: (tm) => dominantBody(tm),
  planeNormal: (center, t, pos, vel) => {
    const plane = viewSettings.nodePlane;
    const nrm = [0, 0, 0];
    if (plane === 'ecliptic') return { n: [...ECLIPTIC_POLE], label: 'ecliptic' };
    const target = bodyIndex(plane);
    const use = plane === 'equator' || target === center ? 'equator' : plane;
    if (!planeNormalAt(center, use, t, pos, vel, nrm)) return null;
    return { n: nrm, label: use === 'equator' ? `${BODIES[center].name}'s equator` : `${BODIES[target].name}'s orbital plane` };
  },
  orientation: (center, t, out) => bodyOrientation(center, t, out),
  stage: (tm) => { const p = store.get().plan; if (!(p.lowerStages?.length)) return null; const k = stageAt(p, tm); const row = stageRows(p)[k]; return row ? { tag: row.tag, name: row.name } : null; },
});
layout.add(orbitPanel.root, 'orbit', 'right');
orbitPanel.onDetails = () => layout.showTab('orbit');
layout.add(hud.infoPanel, 'view', 'right');
const timeline = new Timeline(store, {
  events: () => listed.filter((x) => !x.distant).map((x) => ({ t: x.ev.t, label: eventMarker(x, bodyName), kind: x.failure ? 'failure' : 'event' })),
  crossings: () => (viewSettings.showNodes ? crossings : []),
  period: (t) => periodAt(t),
  separations: () => { const p = store.get().plan; return separationsOf(p).map((x) => ({ t: p.epoch + x.time, label: `Separation ${separationTag(p, x)}` })); },
  moveSeparation: (j, t) => { editor.moveSeparation(j, t - store.get().plan.epoch); },
  selectSeparation: (j) => { const p = store.get().plan; const sp = p.separations?.[j]; store.set({ selectedSeparation: j, selectedNode: null, ...(sp ? { t: p.epoch + sp.time, paused: true, loadingTarget: p.epoch + sp.time } : {}) }); layout.showTab('nodes'); },
});
layout.bottom.prepend(timeline.root);
// Above the timeline: the orbit at the cursor as one line (wide mode; CSS hides it elsewhere) and the map legend.
const legend = new MapLegend(store);
const mapStrip = el('div', { className: 'map-strip' }, orbitPanel.strip, legend.root);
layout.bottom.prepend(mapStrip);
// Phones and tablets: the legend lives in the View tab (no map area spent on it); on a desktop, beside the timeline.
const placeLegend = () => {
  const target = layout.mode === 'wide' ? mapStrip : viewOptions.root;
  if (legend.root.parentElement !== target) target.append(legend.root);
};
layout.onChange(placeLegend);
placeLegend();
// Selecting a node on a phone brings its editor up.
store.subscribe((s, p) => {
  if (s.selectedNode !== null && s.selectedNode !== p.selectedNode) layout.showTab('nodes');
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
    // The status is back to idle; say why the trajectory did not update instead of showing a stale one silently.
    store.set({ notice: `The replay failed: ${message.split('\n')[0]}` });
  },
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function planChanged(): void {
  const s = store.get();
  if (errorCount(planErrors(s.plan)) === 0) replayClient.request(s.plan, s.missionId);
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
  if (s.selectedEvent !== p.selectedEvent || s.selectedNode !== p.selectedNode || s.selectedSeparation !== p.selectedSeparation) markersDirty = true;
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
  hoverHide();
}
/** Popover at a screen point: a sentence (optional) and, for a trajectory time t (mission time), its readout and "Add node here". */
function showTapPop(t: number | null, x: number, y: number, text?: string): void {
  tapPick = t === null ? null : { t, x, y };
  const kids: (HTMLElement | null)[] = [];
  if (text) kids.push(el('div', { className: 'tp-text', textContent: text }));
  if (t !== null) {
    const add = el('button', { className: 'btn primary', type: 'button', textContent: 'Add node here' });
    add.onclick = () => {
      const p = tapPick;
      hideTapPop();
      if (p) addNodeAt(p.t);
    };
    kids.push(el('span', { className: 'tp-t', textContent: pointReadout(t) }), add);
    if (!document.documentElement.classList.contains('touch')) kids.push(el('span', { className: 'tp-hint', textContent: 'or N' }));
  }
  const close = el('button', { className: 'btn', type: 'button', textContent: '✕', ariaLabel: 'Dismiss' });
  close.onclick = hideTapPop;
  kids.push(close);
  tapPop.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
  tapPop.hidden = false;
  placeTapPop(x, y);
}
function placeTapPop(x: number, y: number): void {
  const W = window.innerWidth;
  const pw = Math.min(300, W - 16);
  tapPop.style.left = `${Math.max(8, Math.min(W - pw - 8, x - pw / 2))}px`;
  // Never over the picked point (a second click there must reach the map): above it, or below if no room.
  const h = tapPop.offsetHeight || 80;
  const above = y - h - 20;
  tapPop.style.top = `${above >= 60 ? above : y + 20}px`;
}

new MapInput(canvas, {
  rotate: (a, e) => camera.rotate(a, e),
  zoom: (f) => camera.zoom(f),
  fling: (a, e) => camera.fling(a, e),
  stop: () => camera.stop(),
  changed: () => {
    viewDirty = true;
  },
  // A click never adds a node: on the trajectory it picks that point (select, then "Add node here" or N / Enter);
  // near a marker it goes to the marker, by the same precedence as a double click (pick.ts). Bodies have no single-click action.
  tap(x, y, type) {
    const c = pickTarget(candidatesAt(x, y, type !== 'mouse', false));
    if (!c || c.kind === 'trajectory') labels.expanded = null; // a tap away from an expanded cluster folds it
    if (!c) {
      hideTapPop();
      return;
    }
    if (c.kind === 'trajectory') selectPoint(Number(c.key), x, y);
    else {
      hideTapPop();
      labelPick(c.key);
    }
  },
  doubleTap(x, y, type) {
    focusAt(x, y, type !== 'mouse');
  },
});

/** Candidates under or near a client point, for pickTarget. Occluded markers and far-side trajectory points are never candidates. */
function candidatesAt(x: number, y: number, touch: boolean, withBodies: boolean, preferKey?: string): PickCandidate[] {
  const rect = canvas.getBoundingClientRect();
  const px = x - rect.left;
  const py = y - rect.top;
  const R = touch ? 28 : 14;
  const out: PickCandidate[] = [];
  for (const it of lastItems) {
    const kind = kindOfLabel(it.key);
    if (!kind || kind === 'body' || !it.onScreen) continue;
    if (it.key === preferKey) {
      out.push({ kind, key: it.key, screenDist: 0, depth: 0 });
      continue;
    }
    if (it.occluded) continue;
    // Absorbed into a cluster: the cluster's leader stands for it; fanned out: at its ring position.
    const lay = lastLayout.find((p) => p.key === it.key);
    if (lay?.clusteredInto) continue;
    const d = Math.hypot((lay?.x ?? it.x) - px, (lay?.y ?? it.y) - py);
    if (d <= R) out.push({ kind, key: it.key, screenDist: d, depth: 0 });
  }
  if (withBodies) {
    const pr = { x: 0, y: 0 };
    for (let i = 0; i < n; i++) {
      if (!scene.project(lastFramePos, 3 * i, camera.position, pr)) continue;
      const dist = Math.hypot(lastFramePos[3 * i] - camera.position[0], lastFramePos[3 * i + 1] - camera.position[1], lastFramePos[3 * i + 2] - camera.position[2]);
      const rad = scene.pixelRadius(BODIES[i].radius, dist);
      const d = Math.hypot(pr.x - px, pr.y - py);
      const hit = String(i) === preferKey || (d <= Math.max(rad, touch ? 22 : 10) && !behindBody(lastFramePos, 3 * i, i));
      if (hit) out.push({ kind: 'body', key: String(i), screenDist: d, depth: dist - BODIES[i].radius });
    }
  }
  const t = pickTrajectory(x, y, R);
  if (t !== null && t >= simulationStartOffset(store.get().plan.start)) out.push({ kind: 'trajectory', key: String(t), screenDist: Math.hypot(pickScreen.x - x, pickScreen.y - y), depth: 0 });
  return out;
}

/** Double click / double tap: focus what is under the pointer (precedence in pick.ts). Never adds or removes anything. */
function focusAt(x: number, y: number, touch: boolean, preferKey?: string): void {
  hideTapPop();
  const c = pickTarget(candidatesAt(x, y, touch, true, preferKey));
  if (!c) return;
  const s = store.get();
  if (c.kind === 'spacecraft') focusCraftAt(null);
  else if (c.kind === 'node' || c.kind === 'event') {
    const t = markerTime(c.key);
    if (c.key.startsWith('node:') || c.key.startsWith('burn:')) store.set({ selectedNode: Number(c.key.split(':')[1]) });
    if (c.key.startsWith('sep:')) store.set({ selectedSeparation: Number(c.key.slice(4)), selectedNode: null });
    if (c.key.startsWith('ev:')) store.set({ selectedEvent: Number(c.key.slice(3)) });
    if (t !== null) focusCraftAt(t);
  } else if (c.kind === 'site') focusSite(c.key);
  else if (c.kind === 'body') {
    const i = Number(c.key);
    if (s.focus !== i) store.set({ focus: i });
    // Frame it: the disc fills about two thirds of the view height.
    const half = (scene.camera.fov * Math.PI) / 360;
    camera.setDistance((BODIES[i].radius / Math.sin(half)) * 1.5);
  } else if (c.kind === 'trajectory') focusCraftAt(s.plan.epoch + Number(c.key));
  lastFocusPick = c;
}
let lastFocusPick: PickCandidate | null = null;

/** Absolute time of a node, burn-end, event or AN / DN marker. */
function markerTime(key: string): number | null {
  if (key.startsWith('pn:')) return crossings[Number(key.slice(3))]?.t ?? null;
  const m = markers.find((x) => x.key === key) ?? burnEnds.flatMap((b) => [b.start, b.end]).find((x) => x.key === key);
  return m ? m.t : null;
}

/** Focus the spacecraft (at time t: the time cursor moves there), at a distance that shows its neighbourhood. */
function focusCraftAt(t: number | null): void {
  const s = store.get();
  camera.refocus();
  if (t !== null) store.set({ t, paused: true, loadingTarget: t, focus: SPACECRAFT });
  else store.set({ focus: SPACECRAFT });
  const tt = t ?? s.t;
  let d = 2e6;
  if (trajectory && stateAt(trajectory, tt, tmpState) && eph.evaluate(tt, tmpPos, null)) {
    const di = bodyIndex(dominantBody(tt - s.plan.epoch));
    if (di >= 0) d = 0.5 * Math.hypot(tmpState[0] - tmpPos[3 * di], tmpState[1] - tmpPos[3 * di + 1], tmpState[2] - tmpPos[3 * di + 2]);
  }
  camera.setDistance(Math.max(5e4, Math.min(2e10, d)));
}

/** Focus Earth with the launch site facing the camera, in the centre of the view. */
function focusSite(key: string): void {
  const p = siteFrame.get(key);
  if (earth < 0 || !p) return;
  if (store.get().focus !== earth) store.set({ focus: earth });
  const dx = p[0] - lastFramePos[3 * earth], dy = p[1] - lastFramePos[3 * earth + 1], dz = p[2] - lastFramePos[3 * earth + 2];
  const r = Math.hypot(dx, dy, dz);
  camera.azimuth = Math.atan2(dy, dx);
  camera.elevation = Math.max(-1.55, Math.min(1.55, Math.asin(dz / r)));
  camera.setDistance(BODIES[earth].radius * 2.2);
  viewDirty = true;
}

/** Single click on the trajectory: the time cursor moves to that point and a popover offers "Add node here". */
function selectPoint(tm: number, x: number, y: number): void {
  const t = store.get().plan.epoch + tm;
  store.set({ t, paused: true, loadingTarget: t });
  showTapPop(tm, x, y);
}
const lastFramePos = new Float64Array(3 * n);
/** Label items of the last rendered frame (canvas px), for hit tests; launch sites in frame coordinates. */
let lastItems: LabelItem[] = [];
/** This frame's label layout (clusters: a tap on a cluster expands it). */
let lastLayout: Placed[] = [];
const siteFrame = new Map<string, Float64Array>();

/** Nearest drawn, visible (not behind a body) trajectory sample to a client point (within `radius` px), as mission time. */
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
    // Far-side points hidden behind a body are not hit-testable.
    if (d2 < best && !behindBody(path.points, 3 * i)) {
      best = d2;
      bestT = path.times[i];
      pickScreen.x = pr.x + rect.left;
      pickScreen.y = pr.y + rect.top;
    }
  }
  return bestT === null ? null : bestT - store.get().plan.epoch;
}
const pickScreen = { x: 0, y: 0 };

/** "T+… · alt … km · … m/s (Earth)": the point's mission time, altitude and speed relative to its reference body. */
function pointReadout(tm: number): string {
  const r = store.get().replay;
  const t = (r?.plan.epoch ?? store.get().plan.epoch) + tm;
  const st = new Float64Array(6);
  const bp = new Float64Array(3 * n);
  const bv = new Float64Array(3 * n);
  if (!trajectory || !stateAt(trajectory, t, st) || !eph.evaluate(t, bp, bv)) return fmtTime(tm, 0);
  const di = bodyIndex(dominantBody(tm));
  const alt = Math.hypot(st[0] - bp[3 * di], st[1] - bp[3 * di + 1], st[2] - bp[3 * di + 2]) - BODIES[di].refRadius;
  const v = Math.hypot(st[3] - bv[3 * di], st[4] - bv[3 * di + 1], st[5] - bv[3 * di + 2]);
  return `${fmtTime(tm, 0)} · ${fromSurface(alt, BODIES[di].id)} · ${v.toFixed(0)} m/s (${BODIES[di].name})`;
}

// Pointer feedback: over a point a click would pick, a crosshair cursor, a marker on the curve and a readout.
// Same hit test and radius as the click (pickTrajectory, 14 px).
const hoverMark = el('div', { className: 'hover-mark' });
const hoverRead = el('div', { className: 'hover-read' });
hoverMark.hidden = hoverRead.hidden = true;
hudRoot.append(hoverMark, hoverRead);
function hoverHide(): void {
  hoverMark.hidden = hoverRead.hidden = true;
  canvas.classList.remove('add-here');
}
function hoverShowAt(x: number, y: number, text: string | null): void {
  hoverMark.hidden = false;
  hoverMark.style.transform = `translate(${x}px, ${y}px)`;
  hoverRead.hidden = text === null;
  if (text !== null) {
    hoverRead.textContent = text;
    const w = hoverRead.offsetWidth || 240;
    hoverRead.style.transform = `translate(${Math.max(4, Math.min(window.innerWidth - w - 4, x + 14))}px, ${y + 12}px)`;
  }
}
let hoverQueued: { x: number; y: number } | null = null;
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  dragging = true;
  canvas.classList.add('grabbing');
  hoverHide();
});
window.addEventListener('pointerup', () => {
  dragging = false;
  canvas.classList.remove('grabbing');
});
canvas.addEventListener('pointerleave', () => {
  if (!dragging) hoverHide();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || dragging || e.buttons !== 0) return;
  if (!hoverQueued) {
    requestAnimationFrame(() => {
      const q = hoverQueued;
      hoverQueued = null;
      if (!q || dragging) return;
      const t = pickTrajectory(q.x, q.y, 14);
      if (t === null || t < simulationStartOffset(store.get().plan.start)) {
        hoverHide();
        return;
      }
      canvas.classList.add('add-here');
      hoverShowAt(pickScreen.x, pickScreen.y, `${pointReadout(t)} · click: pick this point`);
    });
  }
  hoverQueued = { x: e.clientX, y: e.clientY };
});

function addNodeAt(t: number): void {
  editor.addNode(Math.round(t * 10) / 10, { kind: 'orbital', body: dominantBody(t) });
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (planner.isOpen || (e.target as HTMLElement).closest?.('dialog')) return;
  // Undo / redo of plan edits (text fields keep their own undo: handled above by returning early).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    e.preventDefault();
    if (e.code === 'KeyY' || e.shiftKey) editor.redo();
    else editor.undo();
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  const s = store.get();
  const i = s.selectedNode;
  const level = e.shiftKey ? 2 : e.altKey ? 0 : 1;
  const nudge: Record<string, [0 | 1 | 2, number]> = { KeyW: [0, 1], KeyS: [0, -1], KeyD: [1, 1], KeyA: [1, -1], KeyE: [2, 1], KeyQ: [2, -1] };
  if (i !== null && nudge[e.code]) {
    e.preventDefault();
    const [axis, sign] = nudge[e.code];
    editor.nudgeDv(i, axis, sign * DV_LEVELS[level]);
    return;
  }
  if (i !== null && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    editor.nudgeTime(i, (e.code === 'BracketLeft' ? -1 : 1) * T_LEVELS[level]);
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
    store.set({ selectedNode: null, selectedSeparation: null, selectedEvent: null });
  }
  else if (e.code === 'Space') {
    e.preventDefault();
    store.set({ paused: !s.paused });
  } else if (e.key === ',') hud.stepWarp(-1);
  else if (e.key === '.') hud.stepWarp(1);
  else if ((e.key === 'n' || e.key === 'N' || e.key === 'Enter') && tapPick) {
    const p = tapPick;
    hideTapPop();
    addNodeAt(p.t);
  } else if (e.key === 'n' || e.key === 'N') nodesPanel.addAtCursor();
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
  title?: string;
  /** Absolute time of the marked point. */
  t: number;
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
  const arcs: (ReturnType<typeof anchorSegments>[number] & { hex: number })[] = [];
  const times = path.times;
  const burnNodes = nodesOf(r.plan);
  r.result.burns.forEach((b, i) => {
    const hex = burnStyle(r.plan, burnNodes[i]?.stage).hex;
    if (!(b.burnTime > 0)) return;
    const ta = r.plan.epoch + r.plan.burns[i].start;
    const tb = ta + b.burnTime;
    let lo = 0;
    while (lo < times.length && times[lo] < ta) lo++;
    let hi = lo;
    while (hi < times.length && times[hi] <= tb) hi++;
    const from = Math.max(0, lo - 1);
    const to = Math.min(times.length, hi + 1);
    if (to - from >= 2) arcs.push(...anchorSegments(path.points.slice(3 * from, 3 * to), UNIT).map((x) => ({ ...x, hex })));
  });
  scene.setBurnArcs(arcs);
  updateDrawn();
  crossingsDirty = true;
  rebuildMarkers(frame);
}

/** Stage style of the stage that flies a burn (`stage`: its index from nodesOf; the spacecraft if unknown). */
function burnStyle(plan: MissionPlan, stage: number | undefined) {
  const rows = stageRows(plan);
  const k = stage ?? rows.length - 1;
  const row = rows[k];
  return stageStyle(k, !row || row.isSpacecraft, row?.tag);
}

/** Index of the last vertex at or before t. */
function vertexAt(times: ArrayLike<number>, t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (times[m] <= t) lo = m + 1;
    else hi = m;
  }
  return Math.max(0, lo - 1);
}

/** Drawn span after the last burn (display only: the replay and its digest are untouched). */
let drawn = { t: Infinity, faintRest: false };
function updateDrawn(): void {
  viewDirty = true;
  const r = store.get().replay;
  if (!r || !trajectory || trajectory.n < 2) {
    drawn = { t: Infinity, faintRest: false };
    return;
  }
  const t0 = trajectory.data[0];
  const end = trajectory.data[(trajectory.n - 1) * SAMPLE_STRIDE];
  let last = t0;
  r.plan.burns.forEach((b, i) => {
    last = Math.max(last, r.plan.epoch + b.start + (r.result.burns[i]?.burnTime ?? b.duration));
  });
  const period = periodAt(Math.min(end, last));
  drawn = drawnEnd(viewSettings, last, period, end);
  viewOptions.setOrbitContext(period);
}
/** Orbital period about the dominant body at absolute time t; NaN if unbound. */
function periodAt(t: number): number {
  const r = store.get().replay;
  const st = new Float64Array(6);
  const bp = new Float64Array(3 * n);
  const bv = new Float64Array(3 * n);
  if (!r || !trajectory || !stateAt(trajectory, t, st) || !eph.evaluate(t, bp, bv)) return NaN;
  const di = bodyIndex(dominantBody(t - r.plan.epoch));
  if (di < 0) return NaN;
  const d = Math.hypot(st[0] - bp[3 * di], st[1] - bp[3 * di + 1], st[2] - bp[3 * di + 2]);
  const v2 = (st[3] - bv[3 * di]) ** 2 + (st[4] - bv[3 * di + 1]) ** 2 + (st[5] - bv[3 * di + 2]) ** 2;
  const mu = BODIES[di].gm;
  const inv = 2 / d - v2 / mu;
  return inv > 0 ? 2 * Math.PI * Math.sqrt((1 / inv) ** 3 / mu) : NaN;
}

// ---------------------------------------------------------------------------
// Ascending / descending nodes relative to the chosen reference plane

let crossings: PlaneCrossing[] = [];
let crossingPos: (Float64Array | null)[] = [];
let crossingCenter = -1;
let crossingLabel = '';
/** Plane normal (ICRF) for the target-plane option at t, or null. */
let crossingsDirty = true;
const ROT_N = new Float64Array(9);
function planeNormalAt(center: number, plane: string, t: number, bp: Float64Array, bv: Float64Array, out: number[]): boolean {
  if (plane === 'ecliptic') {
    out[0] = ECLIPTIC_POLE[0]; out[1] = ECLIPTIC_POLE[1]; out[2] = ECLIPTIC_POLE[2];
    return true;
  }
  if (plane === 'equator') {
    if (!Number.isFinite(bodyOrientation(center, t, ROT_N))) return false;
    out[0] = ROT_N[2]; out[1] = ROT_N[5]; out[2] = ROT_N[8];
    return true;
  }
  const k = bodyIndex(plane);
  if (k < 0 || k === center) return false;
  const rx = bp[3 * k] - bp[3 * center], ry = bp[3 * k + 1] - bp[3 * center + 1], rz = bp[3 * k + 2] - bp[3 * center + 2];
  const vx = bv[3 * k] - bv[3 * center], vy = bv[3 * k + 1] - bv[3 * center + 1], vz = bv[3 * k + 2] - bv[3 * center + 2];
  const hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);
  if (!(h > 0)) return false;
  out[0] = hx / h; out[1] = hy / h; out[2] = hz / h;
  return true;
}
/** The node reference body: the frame's centre body, else the flight's home body. */
function nodeCenter(): number {
  const c = frameCenter(store.get().frame);
  return c ?? home;
}
function computeCrossings(): void {
  crossingsDirty = false;
  crossings = [];
  crossingPos = [];
  const r = store.get().replay;
  const center = nodeCenter();
  crossingCenter = center;
  const plane = viewSettings.nodePlane;
  const target = plane === 'equator' || plane === 'ecliptic' ? -1 : bodyIndex(plane);
  crossingLabel = plane === 'ecliptic' ? 'the ecliptic' : plane === 'equator' || target === center ? `${BODIES[center].name}'s equator` : `${BODIES[target]?.name ?? plane}'s orbital plane`;
  const usePlane = target === center ? 'equator' : plane;
  if (!r || !trajectory || !viewSettings.showNodes) return;
  const R = soi.get(BODIES[center].id) ?? Infinity;
  const bp = new Float64Array(3 * n);
  const bv = new Float64Array(3 * n);
  const d = trajectory.data;
  let run: RelSample[] = [];
  const flush = () => {
    if (run.length > 1) crossings.push(...planeCrossings(run));
    run = [];
  };
  for (let i = 0; i < trajectory.n; i++) {
    const o = i * SAMPLE_STRIDE;
    const t = d[o];
    if (!eph.evaluate(t, bp, bv)) { flush(); continue; }
    const rel = [d[o + 1] - bp[3 * center], d[o + 2] - bp[3 * center + 1], d[o + 3] - bp[3 * center + 2], d[o + 4] - bv[3 * center], d[o + 5] - bv[3 * center + 1], d[o + 6] - bv[3 * center + 2]];
    const nrm = [0, 0, 0];
    if (Math.hypot(rel[0], rel[1], rel[2]) > R || !planeNormalAt(center, usePlane, t, bp, bv, nrm)) { flush(); continue; }
    run.push({ t, s: rel, n: nrm });
  }
  flush();
  // Positions in the current frame (on the drawn path).
  const frame = store.get().frame;
  const scratch = { pos: new Float64Array(3 * n), vel: new Float64Array(3 * n), fs: newFrameState() };
  const st = new Float64Array(6);
  crossingPos = crossings.map((c) => {
    if (!stateAt(trajectory!, c.t, st)) return null;
    const f = frameAt(ctx, frame, c.t, scratch);
    if (!f) return null;
    const q = new Float64Array(3);
    toFrame(f, st, 0, q, 0);
    return q;
  });
  eventsPanel.setCrossings(crossings, r.plan.epoch, crossingLabel);
  nodeSummaryCenter = BODIES[center].name;
  nodeSummary();
}
let nodeSummaryCenter = '';
/** The node-crossing summary in View: its "next" crossing follows the time cursor. */
function nodeSummary(): void {
  const s = store.get();
  const nx = crossings.findIndex((c) => c.t >= s.t);
  viewOptions.setNodeSummary(crossings.length ? `${crossings.length} crossings of ${crossingLabel}${nx >= 0 ? `; next ${crossings[nx].ascending ? 'AN' : 'DN'} at ${fmtTime(crossings[nx].t - s.plan.epoch, 0)}, ${crossings[nx].inclinationDeg.toFixed(2)}°` : ''}.` : `No crossings of ${crossingLabel}${nodeSummaryCenter ? ` while near ${nodeSummaryCenter}` : ''}.`);
}
store.subscribe((s, p) => { if (s.t !== p.t && crossings.length) nodeSummary(); });
store.subscribe((s, p) => {
  if (s.frame !== p.frame) crossingsDirty = true;
});
const fmtIn = (dt: number) => {
  const a = Math.abs(dt);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), sec = Math.floor(a % 60);
  return h > 48 ? `${(a / 86400).toFixed(1)} d` : h > 0 ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} m ${String(sec).padStart(2, '0')} s`;
};

function rebuildMarkers(frame: FrameSpec): void {
  markersDirty = false;
  markers = [];
  const s = store.get();
  const r = s.replay;
  if (!r || !trajectory) return;
  listed = listEvents(r.result.events, soi, { failureKinds: failureKinds(), targets: eventTargets(), dominant: (t) => dominantBody(t - r.plan.epoch) });
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
    if (x.distant && s.selectedEvent !== x.index) continue; // not an encounter: listed (collapsed), never drawn
    const pos = place(x.ev.t);
    if (!pos) continue;
    markers.push({
      key: `ev:${x.index}`,
      text: eventMarker(x, bodyName),
      cls: `marker ev ${x.failure ? 'failure' : ''} ${x.role} ${s.selectedEvent === x.index ? 'selected' : ''}`,
      pos,
      priority: x.failure ? 900 : s.selectedEvent === x.index ? 800 : x.role === 'closest' ? 20 : 12,
      color: x.failure ? MAP.failure : x.role === 'closest' ? MAP.closest : MAP.event,
      title: eventExplain(x, bodyName),
      t: x.ev.t,
    });
  }
  // Nodes of the replayed plan, at the node (burn centre), and each burn's flown ignition and cutoff.
  burnEnds = [];
  if (r.plan === s.plan) {
    nodesOf(r.plan).forEach((x, i) => {
      const pos = place(r.plan.epoch + x.node.t);
      if (!pos) return;
      const sel = s.selectedNode === i;
      const ss = burnStyle(r.plan, x.stage);
      const staged = (r.plan.lowerStages?.length ?? 0) > 0;
      const tag = staged ? ` · ${ss.tag}` : '';
      markers.push({ key: `node:${i}`, text: `Burn ${i + 1}${tag}`, cls: `marker node ${sel ? 'selected' : ''}`, pos, priority: sel ? 950 : 700, color: ss.colour, title: `Maneuver node ${i + 1}${staged ? `, flown by ${ss.tag}` : ''}: the centre of a planned burn. Tap to edit it, double-tap to focus it.`, t: r.plan.epoch + x.node.t });
      const flown = r.result.burns[i];
      if (!flown || !(flown.burnTime > 0)) return;
      const t0 = r.plan.epoch + r.plan.burns[i].start;
      const t1 = t0 + flown.burnTime;
      const short = flown.burnTime < r.plan.burns[i].duration * 0.999;
      const a = place(t0);
      const b = place(t1);
      if (!a || !b) return;
      const dur = flown.burnTime >= 120 ? `${(flown.burnTime / 60).toFixed(1)} min` : `${flown.burnTime.toFixed(0)} s`;
      const start: Marker = { key: `burn:${i}:s`, text: `▶ B${i + 1}${tag} start${sel ? ` ${fmtTime(r.plan.burns[i].start, 0)}` : ''}`, cls: `marker burn-end start ${sel ? 'selected' : ''}`, pos: a, priority: sel ? 940 : 690, color: ss.colour, t: t0 };
      const end: Marker = { key: `burn:${i}:e`, text: short ? `■ B${i + 1}${tag} cut short · ${dur} · out of propellant` : `■ B${i + 1}${tag} end · ${dur}`, cls: `marker burn-end end ${short ? 'short' : ''} ${sel ? 'selected' : ''}`, pos: b, priority: short ? 945 : sel ? 940 : 690, color: short ? MAP.failure : ss.colour, t: t1 };
      burnEnds.push({ node: `node:${i}`, start, end });
    });
    // Separations: where a stage is dropped (distinct from burns and events: teal, scissors).
    const rows = stageRows(r.plan);
    for (const sp of separationsOf(r.plan)) {
      const pos = place(r.plan.epoch + sp.time);
      if (!pos) continue;
      const sel = s.selectedSeparation === sp.index && s.selectedNode === null;
      markers.push({ key: `sep:${sp.index}`, text: `✂ ${separationTag(r.plan, sp)}`, cls: `marker sep ${sel ? 'selected' : ''}`, pos, priority: sel ? 930 : 680, color: MAP.separation, title: `Separation: ${rows[sp.dropped]?.name ?? 'the stage'} is dropped here${sp.empty ? ' (empty)' : ` with ${Math.round(sp.propellantLeft).toLocaleString('en-US')} kg of propellant`}; ${rows[sp.next]?.name ?? 'the next stage'} fires from now on. Tap to edit it.`, t: r.plan.epoch + sp.time });
    }
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

const ROT_S = new Float64Array(9);
/** "Cape Canaveral SFS SLC-40, Florida, USA" -> "Cape Canaveral". */
const ROT_F = new Float64Array(9);
const sitePos = new Float64Array(3);

/**
 * Whether a frame-coordinate point is hidden behind a body as seen from the
 * camera (the segment camera -> point passes inside a body's sphere). A point
 * on the near surface is not occluded (the closest approach is the point itself).
 */
function behindBody(p: ArrayLike<number>, po: number, skip = -1): boolean {
  const c = camera.position;
  const dx = p[po] - c[0], dy = p[po + 1] - c[1], dz = p[po + 2] - c[2];
  const L2 = dx * dx + dy * dy + dz * dz;
  if (!(L2 > 0)) return false;
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const R = BODIES[i].radius * 0.998;
    const wx = framePos[3 * i] - c[0], wy = framePos[3 * i + 1] - c[1], wz = framePos[3 * i + 2] - c[2];
    const u = (wx * dx + wy * dy + wz * dz) / L2;
    if (u <= 0) continue;
    const k = Math.min(1, u);
    const ex = wx - k * dx, ey = wy - k * dy, ez = wz - k * dz;
    if (ex * ex + ey * ey + ez * ez < R * R) return true;
  }
  return false;
}

/** Axis and plane-disc overlays for this frame (scene) and their N / S labels. */
const OV_M = new Float64Array(9);
const OV_F = new Float64Array(9);
const axisEnd = new Float64Array(3);
function overlays(t: number, focus: number): LabelItem[] {
  const out: LabelItem[] = [];
  const st = viewSettings;
  let b = st.overlayBody ? bodyIndex(st.overlayBody) : focus === SPACECRAFT ? nodeCenter() : focus;
  if (b < 0) b = home;
  const hasRot = (st.showAxis || st.showEquator) && Number.isFinite(bodyOrientation(b, t, OV_M));
  let eq = null;
  let ax = null;
  const R = BODIES[b].radius;
  const radii = st.discRadius > 1 ? st.discRadius : defaultDiscRadius(BODIES[b].id);
  viewOptions.showRadius(radii, (radii * R) / 1000);
  const pos = framePos.subarray(3 * b, 3 * b + 3);
  if (hasRot) {
    mul3(fs.axes, OV_M, OV_F);
    const rot = Float64Array.from(OV_F);
    if (st.showEquator) eq = { pos, rot, size: radii * R, opacity: st.discOpacity };
    if (st.showAxis) {
      ax = { pos, rot, size: 1.8 * R };
      for (const [sign, key, text] of [[1, 'axN', 'N'], [-1, 'axS', 'S']] as const) {
        for (let k = 0; k < 3; k++) axisEnd[k] = pos[k] + sign * 1.8 * R * OV_F[3 * k + 2];
        const on = scene.project(axisEnd, 0, camera.position, proj);
        siteAndAxisTitles.set(key, `${text === 'N' ? 'North' : 'South'} end of ${BODIES[b].name}'s rotation axis (IAU pole; the same pole the texture and the surface frame use).`);
        items0.push({ key, text, color: sign > 0 ? '#ff6b6b' : '#6bb6ff', priority: 30, x: proj.x, y: proj.y, marker: false, offset: 4, onScreen: on, className: 'axis-end', title: siteAndAxisTitles.get(key), occluded: on && behindBody(axisEnd, 0) });
      }
      out.push(...items0.splice(0));
    }
  }
  let tg = null;
  if (st.showTargetPlane && st.nodePlane !== 'equator' && crossingCenter >= 0 && bodyIndex(st.nodePlane) !== crossingCenter && eph.evaluate(t, ovP, ovV)) {
    const nrm = [0, 0, 0];
    if (planeNormalAt(crossingCenter, st.nodePlane, t, ovP, ovV, nrm)) {
      // Frame-space basis with the normal as third column.
      const a = fs.axes;
      const z = [a[0] * nrm[0] + a[1] * nrm[1] + a[2] * nrm[2], a[3] * nrm[0] + a[4] * nrm[1] + a[5] * nrm[2], a[6] * nrm[0] + a[7] * nrm[1] + a[8] * nrm[2]];
      const h = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const x = [h[1] * z[2] - h[2] * z[1], h[2] * z[0] - h[0] * z[2], h[0] * z[1] - h[1] * z[0]];
      const xl = Math.hypot(x[0], x[1], x[2]);
      for (let k = 0; k < 3; k++) x[k] /= xl;
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      const Rc = BODIES[crossingCenter].radius;
      const rc = st.discRadius > 1 ? st.discRadius : defaultDiscRadius(BODIES[crossingCenter].id);
      tg = { pos: framePos.subarray(3 * crossingCenter, 3 * crossingCenter + 3), rot: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], size: rc * Rc, opacity: st.discOpacity };
    }
  }
  scene.setOverlays(eq, tg, ax);
  return out;
}
const items0: LabelItem[] = [];
const ovP = new Float64Array(3 * n);
const ovV = new Float64Array(3 * n);

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
    relativeId: c === null ? null : BODIES[c].id,
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
function revolutionWindow(t: number, times: Float64Array | number[], scVisible: boolean): [number, number] {
  const all: [number, number] = [0, times.length - 1];
  if (viewSettings.brightAll || !scVisible || times.length < 2) return all;
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
        scene.setTrajectorySplit(Math.max(0, lo - 1), times.length, revolutionWindow(t, times, scVisible), vertexAt(times, drawn.t) + 1, drawn.faintRest);
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
    const discs: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      const on = scene.project(framePos, 3 * i, camera.position, proj);
      const d = Math.hypot(framePos[3 * i] - camera.position[0], framePos[3 * i + 1] - camera.position[1], framePos[3 * i + 2] - camera.position[2]);
      const px = scene.pixelRadius(BODIES[i].radius, d);
      if (on && px > 4) discs.push({ x: proj.x, y: proj.y, r: px });
      items.push({ key: String(i), text: BODIES[i].name, color: meta[i].color, priority: (i === s.focus ? 1000 : 0) + Math.log10(BODIES[i].gm), x: proj.x, y: proj.y, marker: px < 3, offset: px < 3 ? 0 : px, onScreen: on });
    }
    if (scVisible) {
      const on = scene.project(scFrame, 0, camera.position, proj);
      items.push({ key: 'sc', text: 'Spacecraft', color: '#ffffff', priority: s.focus === SPACECRAFT ? 1000 : 13.5, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on, occluded: on && behindBody(scFrame, 0) });
    }
    // Markers are drawn in the frame at their own time; in a moving frame they sit on the drawn path, as the path does.
    for (const m of markers) {
      const on = scene.project(m.pos, 0, camera.position, proj);
      items.push({ key: m.key, text: m.text, color: m.color, priority: m.priority, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on, className: m.cls, title: m.title, occluded: on && behindBody(m.pos, 0), t: m.t });
    }
    // Ascending / descending nodes: the ones around the cursor (all of them when few).
    if (crossingsDirty) computeCrossings();
    if (viewSettings.showNodes && crossings.length) {
      const near = crossingsNear(crossings, t);
      let nextA = -1, nextD = -1;
      for (let k = 0; k < crossings.length; k++) {
        if (crossings[k].t < t) continue;
        if (crossings[k].ascending && nextA < 0) nextA = k;
        if (!crossings[k].ascending && nextD < 0) nextD = k;
        if (nextA >= 0 && nextD >= 0) break;
      }
      for (const k of near) {
        const c = crossings[k];
        const p = crossingPos[k];
        if (!p) continue;
        const on = scene.project(p, 0, camera.position, proj);
        const next = k === nextA || k === nextD;
        const text = `${c.ascending ? 'AN' : 'DN'} ${c.inclinationDeg.toFixed(2)}°${next ? ` · in ${fmtIn(c.t - t)}` : ''}`;
        items.push({ key: `pn:${k}`, text, color: MAP.planeNode, priority: next ? 600 : 300, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on, className: `marker pnode ${c.ascending ? 'asc' : 'desc'}`, title: `${c.ascending ? 'Ascending' : 'Descending'} node: crosses ${crossingLabel} at ${c.inclinationDeg.toFixed(2)}° relative inclination. Tap to move the time cursor here.`, occluded: on && behindBody(p, 0), t: c.t });
      }
    }
    // Launch sites on Earth: in Earth's surface frame, or when Earth is large on screen.
    siteAndAxisTitles.clear();
    if (earth >= 0) {
      const de = Math.hypot(framePos[3 * earth] - camera.position[0], framePos[3 * earth + 1] - camera.position[1], framePos[3 * earth + 2] - camera.position[2]);
      // Sites only when Earth is a real disc on screen; their names only when it is large (the selected site always named).
      const pxE = scene.pixelRadius(BODIES[earth].radius, de);
      siteFrame.clear();
      if (pxE > 40) {
        const selSite = launchOf(s.plan)?.site;
        if (Number.isFinite(bodyOrientation(earth, t, ROT_S))) {
          mul3(fs.axes, ROT_S, ROT_F);
          for (const site of LAUNCH_SITES) {
            const lat = (geocentricLatitudeDeg(site) * Math.PI) / 180;
            const lon = (site.lonDeg * Math.PI) / 180;
            const R = BODIES[earth].radius + site.heightM;
            const b = [R * Math.cos(lat) * Math.cos(lon), R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat)];
            for (let k = 0; k < 3; k++) sitePos[k] = framePos[3 * earth + k] + ROT_F[3 * k] * b[0] + ROT_F[3 * k + 1] * b[1] + ROT_F[3 * k + 2] * b[2];
            const on = scene.project(sitePos, 0, camera.position, proj);
            const sel = site.id === selSite;
            const key = `site:${site.id}`;
            siteFrame.set(key, Float64Array.from(sitePos));
            const title = `Launch site ${site.name} (${site.latDeg.toFixed(2)}°, ${site.lonDeg.toFixed(2)}°)${sel ? ', the selected site' : ''}.`;
            siteAndAxisTitles.set(key, title);
            items.push({ key, text: sel || pxE > 320 ? siteShort(site.name) : '', color: MAP.site, priority: sel ? 500 : 40, x: proj.x, y: proj.y, marker: true, offset: 0, onScreen: on, className: `marker site${sel ? ' selected' : ''}`, title, occluded: on && behindBody(sitePos, 0) });
          }
        }
      }
    }
    // Reference geometry overlays.
    items.push(...overlays(t, s.focus));
    // Burn ends: expanded once ignition and cutoff are 28 px apart on screen, else the single "Burn N" marker stands for both.
    const beOcc = (p: Float64Array) => behindBody(p, 0);
    for (const be of burnEnds) {
      const onA = scene.project(be.start.pos, 0, camera.position, projA);
      const onB = scene.project(be.end.pos, 0, camera.position, projB);
      if (!onA || !onB || Math.hypot(projA.x - projB.x, projA.y - projB.y) < 28) continue;
      items.push({ key: be.start.key, text: be.start.text, color: be.start.color, priority: be.start.priority, x: projA.x, y: projA.y, marker: true, offset: 0, onScreen: true, className: be.start.cls, title: `Burn ${be.node.slice(5)} ignition: the engine starts here.`, occluded: beOcc(be.start.pos), t: be.start.t });
      items.push({ key: be.end.key, text: be.end.text, color: be.end.color, priority: be.end.priority, x: projB.x, y: projB.y, marker: true, offset: 0, onScreen: true, className: be.end.cls, title: `Burn ${be.node.slice(5)} cutoff: the engine stops here.`, occluded: beOcc(be.end.pos), t: be.end.t });
    }
    lastLayout = labels.update(items, { cursor: t, fadeScale: Math.max(1800, s.plan.duration * 0.08), discs, touch: document.documentElement.classList.contains('touch') });
    lastFramePos.set(framePos);
    lastItems = items;
    // A picked trajectory point: the popover follows the spacecraft (which is at that point); it closes when time moves on.
    if (tapPick && !tapPop.hidden) {
      const tp = s.plan.epoch + tapPick.t;
      if (Math.abs((s.loadingTarget ?? s.t) - tp) > 0.5) hideTapPop();
      else if (scVisible && Math.abs(t - tp) <= 0.5 && scene.project(scFrame, 0, camera.position, proj)) {
        const rc = canvas.getBoundingClientRect();
        placeTapPop(proj.x + rc.left, proj.y + rc.top);
      }
    }

    // Readouts.
    const ro: Readout[] = [];
    // The focused body: its distance from the frame's centre (none when it is the centre: an "altitude" of minus its radius says nothing).
    if (s.focus !== SPACECRAFT) ro.push(frameCenter(frame) === s.focus ? { title: BODIES[s.focus].name, relativeTo: '—', distance: NaN, speed: NaN, extra: 'Centre of the current frame.' } : readout(BODIES[s.focus].name, pos, 3 * s.focus, vel, 3 * s.focus, frame));
    const r = s.replay;
    if (r && trajectory) {
      if (scVisible) {
        const dom = dominantBody(t - r.plan.epoch);
        const di = bodyIndex(dom);
        const alt = Math.hypot(scState[0] - pos[3 * di], scState[1] - pos[3 * di + 1], scState[2] - pos[3 * di + 2]) - BODIES[di].refRadius;
        const vr = Math.hypot(scState[3] - vel[3 * di], scState[4] - vel[3 * di + 1], scState[5] - vel[3 * di + 2]);
        ro.push(readout('Spacecraft', scState, 0, scState, 3, frame, `${phaseAt(t)} · ${BODIES[di].name} ${fromSurface(alt, BODIES[di].id)}, ${vr.toFixed(0)} m/s`));
      } else {
        ro.push({ title: 'Spacecraft', relativeTo: '—', distance: NaN, speed: NaN, extra: `Not flying at this time (${fmtTime(0, 0)} to ${Number.isFinite(r.result.finalT) ? fmtTime(r.result.finalT - r.plan.epoch, 0) : '—'}).` });
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
    timeline,
    scene,
    earthPole(t: number): number[] {
      const m = new Float64Array(9);
      bodyOrientation(earth, t, m);
      return [m[2], m[5], m[8]];
    },
    viewSettings,
    crossings: () => crossings,
    crossingLabel: () => crossingLabel,
    drawn: () => drawn,
    editor,
    camera,
    metrics,
    eph,
    pool,
    planner,
    replayStats: replayClient.stats,
    nodesOf: () => nodesOf(store.get().plan),
    ascentMetrics,
    orbit: () => orbitPanel.last,
    fmtTime: (t: number, d = 0) => fmtTime(t, d),
    /** The current plan with these burns and separations, as nodes (tests re-enter a reference solution through the UI). */
    nodesOfBurns: (burns: MissionPlan['burns'], separations?: MissionPlan['separations']) => nodesOf({ ...store.get().plan, burns, ...(separations ? { separations } : {}) }).map((x) => ({ t: x.node.t, dv: x.node.dv, stage: x.stage })),
    shareUrl,
    layout,
    leaderboard,
    /** Frames actually rendered so far (render-on-demand check). */
    renders: () => renderCount,
    /** Map pick at a client point: the candidates (kinds, keys) and the winner by the precedence in pick.ts. */
    pickAt(x: number, y: number, touch = false, withBodies = true): { candidates: PickCandidate[]; winner: PickCandidate | null } {
      const candidates = candidatesAt(x, y, touch, withBodies);
      return { candidates, winner: pickTarget(candidates) };
    },
    /** Last double-click / double-tap focus pick (kind and key), for tests. */
    lastFocusPick: () => lastFocusPick,
    /** Screen position (client px) of a map label's anchor, or null if it is not drawn. */
    labelAt(key: string): { x: number; y: number; occluded: boolean } | null {
      const it = lastItems.find((i) => i.key === key);
      if (!it || !it.onScreen) return null;
      const rc = canvas.getBoundingClientRect();
      return { x: it.x + rc.left, y: it.y + rc.top, occluded: !!it.occluded };
    },
    /** Whether the trajectory point at mission time t is hidden behind a body. */
    occludedAt(tMission: number): boolean | null {
      const path = trajectoryPathCache;
      if (!path) return null;
      const t = store.get().plan.epoch + tMission;
      let best = 0;
      for (let i = 0; i < path.times.length; i++) if (Math.abs(path.times[i] - t) < Math.abs(path.times[best] - t)) best = i;
      return behindBody(path.points, 3 * best);
    },
    listedEvents: () => listed,
    /** What a tap on a map label or marker does (labelPick), for tests. */
    pickLabel: (key: string) => labelPick(key),
    /** The label layout's cluster radius in the last frame (px; 22 in touch mode, 7 with a mouse), and its clusters. */
    labelState: () => ({ clusterRadius: labels.clusterRadius, expanded: labels.expanded, clusters: lastLayout.filter((p) => p.clusterSize > 0).map((p) => ({ key: p.key, x: p.x, y: p.y, size: p.clusterSize })) }),
    /** Screen disc (client px) of a body this frame, or null. */
    bodyDisc(id: string): { x: number; y: number; r: number } | null {
      const i = BODIES.findIndex((b) => b.id === id);
      const pr = { x: 0, y: 0 };
      if (i < 0 || !scene.project(lastFramePos, 3 * i, camera.position, pr)) return null;
      const d = Math.hypot(lastFramePos[3 * i] - camera.position[0], lastFramePos[3 * i + 1] - camera.position[1], lastFramePos[3 * i + 2] - camera.position[2]);
      const rc = canvas.getBoundingClientRect();
      return { x: pr.x + rc.left, y: pr.y + rc.top, r: scene.pixelRadius(BODIES[i].radius, d) };
    },
    bodies: BODIES.map((b) => b.id),
    frameKey: () => frameKey(store.get().frame, (i) => BODIES[i].id),
    /** Screen position of the drawn trajectory at mission time t (for tests clicking on it). */
    screenAt(tMission: number, visibleOnly = false): { x: number; y: number } | null {
      const path = trajectoryPathCache;
      if (!path) return null;
      const t = store.get().plan.epoch + tMission;
      let best = 0;
      for (let i = 0; i < path.times.length; i++) if (Math.abs(path.times[i] - t) < Math.abs(path.times[best] - t)) best = i;
      const pr = { x: 0, y: 0 };
      if (!scene.project(path.points, 3 * best, camera.position, pr)) return null;
      if (visibleOnly && behindBody(path.points, 3 * best)) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: pr.x + rect.left, y: pr.y + rect.top };
    },
  },
});
