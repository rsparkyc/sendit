/**
 * Orbit panel: the spacecraft's state and osculating orbit at the time
 * cursor, relative to a reference body (the dominant body by default, or one
 * the player pins, the Sun included), in the reference plane shared with the
 * AN / DN markers (View: the body's equator, the ecliptic, or a target's
 * orbital plane). Updates as the cursor moves (scrub, play, event or node
 * selection, a picked trajectory point). Values are selectable text.
 *
 * The numbers come from orbit-elements.ts (pure). Where the replay knows a
 * real upcoming apsis about the body, it is shown next to the osculating one.
 */
import { el, formatMet, section, setText } from './dom';
import { fmtTime, otherTime, parseTime, timeMode, onTimeMode, setTimeMode, nextTimeMode, TIME_MODE_LABEL, setTimeEpoch } from './timefmt';
import { latLon, osculating, planeBasis, type OrbitState } from './orbit-elements';
import { BODIES, bodyIndex } from './physics';
import type { AppState, Store } from './store';
import { distanceRow, fromCentre, onDistanceMode } from './units';
import type { TrajectoryEvent } from './mission-layer';

export interface OrbitSource {
  /** Spacecraft [x y z vx vy vz mass] (ICRF barycentric) at absolute time t, or false. */
  craft(t: number, out: Float64Array): boolean;
  /** Body positions and velocities at t (3 per body), or false. */
  bodies(t: number, pos: Float64Array, vel: Float64Array): boolean;
  /** Dominant body id at mission time (as the events list uses). */
  dominant(tMission: number): string;
  /** Reference-plane normal (ICRF) for `center` at t, from the shared node-plane setting; null if none. */
  planeNormal(center: number, t: number, pos: Float64Array, vel: Float64Array): { n: number[]; label: string } | null;
  /** Body-fixed -> ICRF rotation (row-major) at t; NaN if the body has no orientation model. */
  orientation(center: number, t: number, out: Float64Array): number;
  /** Stage active at mission time t and its tag / name. */
  stage(tMission: number): { tag: string; name: string } | null;
}

const kmv = (m: number) => `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
const ms = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m/s`;
const deg = (d: number | null, why = 'undefined') => (d === null || !Number.isFinite(d) ? why : `${d.toFixed(3)}°`);
const dur = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return d > 0 ? `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
};

export class OrbitPanel {
  readonly root: HTMLElement;
  private readonly titleEl = el('div', { className: 'orbit-title' });
  private readonly pin = el('select', { className: 'orbit-body', title: 'Reference body of the orbit readout' });
  private readonly grid = el('div', { className: 'orbit-grid' });
  private readonly note = el('div', { className: 'hint orbit-note', textContent: 'Osculating elements: the two-body orbit that matches the position and velocity at this instant. This is an N-body flight, so they drift as other bodies and the planet’s oblateness pull; the replay’s real next apsis is shown alongside when known.' });
  private pinned = '';
  private raf = 0;
  /** Last computed state (tests and the status line read it). */
  last: { body: string; o: OrbitState; alt: number; plane: string } | null = null;
  private readonly pos = new Float64Array(3 * BODIES.length);
  private readonly vel = new Float64Array(3 * BODIES.length);
  private readonly sc = new Float64Array(7);
  private readonly rot = new Float64Array(9);

  constructor(private readonly store: Store<AppState>, private readonly src: OrbitSource) {
    this.pin.append(el('option', { value: '', textContent: 'Auto (dominant body)' }));
    for (const b of BODIES) this.pin.append(el('option', { value: b.id, textContent: b.name }));
    this.pin.onchange = () => { this.pinned = this.pin.value; this.schedule(); };
    this.root = section('Orbit', 'orbit', el('div', { className: 'row wrap' }, this.titleEl, this.pin), this.grid, this.note);
    store.subscribe((s, p) => { if (s.t !== p.t || s.replay !== p.replay) this.schedule(); });
    onDistanceMode(() => this.schedule());
    this.schedule();
  }

  /** Re-render on the next frame (the plane setting changed, etc.). */
  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    const s = this.store.get();
    const r = s.replay;
    const t = s.t;
    if (!r || !this.src.craft(t, this.sc) || !this.src.bodies(t, this.pos, this.vel)) {
      setText(this.titleEl, 'Orbit: no flight at the cursor');
      this.grid.replaceChildren();
      this.last = null;
      return;
    }
    const id = this.pinned || this.src.dominant(t - s.plan.epoch);
    const c = bodyIndex(id);
    if (c < 0) return;
    const B = BODIES[c];
    const rel = [0, 1, 2].map((k) => this.sc[k] - this.pos[3 * c + k]).concat([0, 1, 2].map((k) => this.sc[3 + k] - this.vel[3 * c + k]));
    const pl = this.src.planeNormal(c, t, this.pos, this.vel);
    const basis = planeBasis(pl?.n ?? [0, 0, 1]);
    const o = osculating(B.gm, rel, basis);
    const plane = pl?.label ?? 'ICRF equator';
    this.last = { body: id, o, alt: o.r - B.refRadius, plane };
    setText(this.titleEl, `Orbit about ${B.name}${this.pinned ? ' (pinned)' : ''}`);
    // Now.
    const rows: [string, string, string?][] = [];
    const head = (x: string) => rows.push([x, '', 'h']);
    head('Now');
    const [dl, dv] = distanceRow(o.r, id, B.name);
    rows.push([dl, dv]);
    rows.push([`Speed relative to ${B.name}`, ms(o.speed)]);
    rows.push(['Vertical speed · flight-path angle', `${ms(o.vr)} · ${o.fpaDeg.toFixed(2)}°`]);
    if (Number.isFinite(this.src.orientation(c, t, this.rot))) {
      const ll = latLon(rel, this.rot);
      rows.push(['Latitude · longitude (surface)', `${ll.latDeg.toFixed(3)}° · ${ll.lonDeg.toFixed(3)}°`]);
    }
    const st = this.src.stage(t - s.plan.epoch);
    if (st) rows.push(['Active stage · mass', `${st.tag} ${st.name} · ${Math.round(this.sc[6]).toLocaleString('en-US')} kg`]);
    else rows.push(['Mass', `${Math.round(this.sc[6]).toLocaleString('en-US')} kg`]);
    // Orbit.
    head(`Orbit (osculating, ${plane})`);
    rows.push(['Periapsis', fromCentre(o.rp, id)]);
    rows.push(['Apoapsis', o.bound ? fromCentre(o.ra, id) : 'none (escape)', o.bound ? undefined : 'na']);
    rows.push(['Semi-major axis', o.bound ? `${kmv(o.a)} radius` : `${kmv(o.a)} radius (hyperbolic)`]);
    rows.push(['Eccentricity', o.e.toFixed(6)]);
    rows.push(['Inclination', `${o.incDeg.toFixed(3)}°`]);
    rows.push(['Longitude of ascending node', deg(o.raanDeg, 'undefined (equatorial)'), o.raanDeg === null ? 'na' : undefined]);
    rows.push(['Argument of periapsis', deg(o.argPeDeg, 'undefined (circular)'), o.argPeDeg === null ? 'na' : undefined]);
    rows.push([o.anomalyKind[0].toUpperCase() + o.anomalyKind.slice(1), `${o.trueAnomalyDeg.toFixed(3)}°`]);
    rows.push(['Period', o.bound ? dur(o.period) : '— (not bound)', o.bound ? undefined : 'na']);
    if (!o.bound) {
      rows.push(['Hyperbolic excess speed', ms(o.vInf)]);
      rows.push(['C3', `${o.c3.toFixed(3)} km²/s²`]);
      if (o.asymptote) rows.push(['Outgoing asymptote (lon · lat in the plane)', `${o.asymptote.lonDeg.toFixed(2)}° · ${o.asymptote.latDeg.toFixed(2)}°`]);
    }
    // Next.
    head('Next');
    const ev = this.nextEvent(r.result.events, id, t);
    const at = (dt: number) => (Number.isFinite(dt) ? `in ${dur(dt)} · ${fmtTime(t + dt - s.plan.epoch, 0)}` : '—');
    rows.push(['Periapsis (osculating)', at(o.toPeriapsis)]);
    if (ev.peri) rows.push(['Periapsis (replay)', `in ${dur(ev.peri.t - t)} · ${fromCentre(ev.peri.distance, id)}`, 'real']);
    rows.push(['Apoapsis (osculating)', o.bound ? at(o.toApoapsis) : '— (not bound)', o.bound ? undefined : 'na']);
    if (ev.apo) rows.push(['Apoapsis (replay)', `in ${dur(ev.apo.t - t)} · ${fromCentre(ev.apo.distance, id)}`, 'real']);
    rows.push(['Ascending node', o.raanDeg === null ? 'undefined (equatorial)' : at(o.toAscending)]);
    rows.push(['Descending node', o.raanDeg === null ? 'undefined (equatorial)' : at(o.toDescending)]);
    this.grid.replaceChildren(...rows.map(([k, v, cls]) => cls === 'h'
      ? el('div', { className: 'orbit-h', textContent: k })
      : el('div', { className: `kv orbit-kv${cls ? ` ${cls}` : ''}` }, el('span', { textContent: k }), el('b', { className: 'sel', textContent: v }))));
  }

  private nextEvent(events: readonly TrajectoryEvent[], body: string, t: number): { peri?: TrajectoryEvent; apo?: TrajectoryEvent } {
    let peri: TrajectoryEvent | undefined, apo: TrajectoryEvent | undefined;
    for (const e of events) {
      if (e.body !== body || e.t <= t) continue;
      if (!peri && e.kind === 'periapsis') peri = e;
      if (!apo && e.kind === 'apoapsis') apo = e;
      if (peri && apo) break;
    }
    return { peri, apo };
  }
}
