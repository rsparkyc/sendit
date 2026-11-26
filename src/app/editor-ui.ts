/**
 * Flight-plan editor panels (plain DOM; see dom.ts for why no UI library).
 *
 *  - MissionPanel: mission picker, objectives with live status, score.
 *  - StartPanel: launch (site, liftoff, azimuth with live inclination and the
 *    range-safety corridor, parking altitude) or a free start in an orbit
 *    about any body; flight duration.
 *  - CraftPanel: wet and dry mass, engines, presets.
 *  - NodesPanel: maneuver nodes, the selected node's editor, disabled nodes.
 *  - EventsPanel: events from the replay; selecting one moves the time cursor.
 *  - ResultsPanel: outcome, delta-v budget, per-burn breakdown, share link, digest.
 *  - Scrubber: time slider along the flight.
 *
 * Each panel builds its DOM once and updates it from the store.
 */
import { el, esc, fillBodySelect, formatMet, parseDuration, section, setText, setValue } from './dom';
import type { Editor } from './editor';
import { Tuner } from './tuner';
import { tooShort, objectiveBodies } from './status';
import { bandFromCentre, bodyRadius, convertText, distanceMode, fromCentre, fromSurface, onDistanceMode } from './units';
import { eventLabel, listEvents, type ListedEvent } from './events-view';
import { groupCrossings, type PlaneCrossing } from './plane-nodes';
import { formatDistance, formatSpeed } from './format';
import {
  LAUNCH_SITES, PAR_SCORE, allowedSites, briefingText, missionForSite, siteOption, azimuthAllowed, azimuthForInclination, groundRelativeAzimuthDeg, launchPlane, launchSite, planErrors, simulationStartOffset,
  type BriefingDistance, type MissionDefinition, type MissionPlan, type Objective, type PlanFrame,
} from './mission-layer';

/** The mission as flown from the plan's launch site (that site's limits); unchanged for a free start. */
export function defForPlan(def: MissionDefinition, plan: MissionPlan): MissionDefinition {
  return plan.start.kind === 'launch' ? missionForSite(def, plan.start.site) : def;
}

/** "Ref 3,167 m/s, 2.9 d · limits 3,500 m/s, 7.0 d" for an offered site, or the reason it is not offered. */
export function siteSummary(def: MissionDefinition, site: string): string | null {
  const o = siteOption(def, site);
  if (!o) return null;
  if (!o.offered) return `Not offered: ${o.reason}`;
  const d = (x: number) => (x >= DAY ? `${(x / DAY).toFixed(1)} d` : `${(x / 3600).toFixed(1)} h`);
  return `Reference ${fmtDv(o.deltaV)}, ${d(o.time)} · limits ${fmtDv(o.maxDeltaV)}, ${d(o.maxTime)}`;
}
import { conformance, craftPerformance, launchOf, missionById, MISSIONS, SPACECRAFT_PRESETS } from './missions';
import { budget, dvMagnitude, elementsFromState, nodesOf, stateFromElements, type OrbitElements } from './nodes';
import { BODIES, bodyIndex } from './physics';
import type { AppState, Store } from './store';
import { calendarToTdb, DAY, formatCalendar, parseCalendar, tdbToCalendar } from './time';

export interface UiContext {
  store: Store<AppState>;
  editor: Editor;
  soi: ReadonlyMap<string, number>;
  /** Body whose sphere of influence holds the craft at mission time t (s after epoch), by id. */
  dominantBody(t: number): string;
  focusBody(id: string): void;
  /** Share URL for the current plan, or null if the plan is invalid. */
  shareUrl(): string | null;
  /** Open the planner overlay on a tab (optionally with a burn preselected). */
  openPlanner?(tab: 'transfer' | 'target' | 'chain', node?: number): void;
}

export function bodyName(id: string): string {
  const i = bodyIndex(id);
  return i >= 0 ? BODIES[i].name : id;
}

const fmtDv = (v: number) => (Number.isFinite(v) ? `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m/s` : '—');
const fmtKg = (v: number) => `${Math.round(v).toLocaleString('en-US')} kg`;

function numInput(title: string, step: string, onCommit: (v: number) => void, cls = ''): HTMLInputElement {
  const i = el('input', { type: 'text', title, className: `num ${cls}`, inputMode: 'decimal', enterKeyHint: 'done', spellcheck: false, autocomplete: 'off' });
  i.dataset.step = step;
  const commit = () => {
    const v = Number(i.value);
    if (i.value.trim() !== '' && Number.isFinite(v)) onCommit(v);
  };
  i.addEventListener('change', commit);
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      i.blur();
    }
  });
  return i;
}

function row(label: string, ...children: (Node | string)[]): HTMLElement {
  return el('label', { className: 'frow' }, el('span', { textContent: label }), el('div', { className: 'fctl' }, ...children));
}

// ---------------------------------------------------------------------------

export class MissionPanel {
  readonly root: HTMLElement;
  private readonly sel = el('select', { title: 'Mission', className: 'mission-select' });
  private readonly blurb = el('div', { className: 'blurb' });
  private readonly objectives = el('ul', { className: 'objectives' });
  private readonly score = el('div', { className: 'score' });
  private readonly notice = el('div', { className: 'notice' });
  private readonly rules = el('div', { className: 'error' });
  private readonly par = el('div', { className: 'hint' });

  constructor(private readonly ctx: UiContext) {
    // Grouped by chapter, in campaign order (a progression).
    let group: HTMLElement | null = null;
    for (const m of MISSIONS) {
      if (!group || group.getAttribute('label') !== m.chapter) {
        group = el('optgroup', { label: m.chapter });
        this.sel.append(group);
      }
      group.append(el('option', { value: m.id, textContent: m.title }));
    }
    this.sel.onchange = () => {
      if (ctx.store.get().plan.burns.length > 0 && !confirm('Start this mission with a fresh plan? The current plan stays in its share link only.')) {
        this.sel.value = ctx.store.get().missionId;
        return;
      }
      ctx.editor.selectMission(this.sel.value);
    };
    const reset = el('button', { className: 'btn small', textContent: 'Reset plan', title: 'Default launch and spacecraft, no burns' });
    reset.onclick = () => {
      if (confirm('Discard the current plan?')) ctx.editor.selectMission(ctx.store.get().missionId);
    };
    this.root = section('Mission', 'mission', this.notice, el('div', { className: 'row' }, this.sel, reset), this.blurb, this.objectives, this.rules, this.score, this.par);
    ctx.store.subscribe((s, p) => this.render(s, p));
    onDistanceMode(() => this.render(ctx.store.get(), null));
    this.render(ctx.store.get(), null);
  }

  private render(s: AppState, p: AppState | null): void {
    if (!p || s.notice !== p.notice) {
      this.notice.replaceChildren();
      if (s.notice) {
        const adopt = el('button', { className: 'btn small', textContent: 'Adopt for this build' });
        adopt.onclick = () => this.ctx.editor.adoptForThisBuild();
        const dismiss = el('button', { className: 'btn small', textContent: 'Dismiss' });
        dismiss.onclick = () => this.ctx.store.set({ notice: null });
        const mismatch = /physics model/.test(s.notice);
        this.notice.append(el('div', { textContent: s.notice }), el('div', { className: 'row' }, mismatch ? adopt : '', dismiss));
      }
      this.notice.style.display = s.notice ? '' : 'none';
    }
    if (!p || s.missionId !== p.missionId) {
      const m = missionById(s.missionId);
      setValue(this.sel, s.missionId);
      setText(this.blurb, m?.def ? briefingText(m.def, briefingDistance) : (m?.blurb ?? ''));
    }
    if (!p || s.replay !== p.replay || s.missionId !== p.missionId || s.plan !== p.plan) {
      const m = missionById(s.missionId);
      const ev = s.replay?.evaluation;
      const current = s.replay?.plan === s.plan;
      this.objectives.replaceChildren();
      if (m?.def) {
        const results = ev?.objectives ?? [];
        // Limits as for the plan's launch site: the same ones `evaluate` applies.
        const def = defForPlan(m.def, s.plan);
        for (const o of def.objectives) {
          const r = results.find((x) => x.objective === o) ?? results.find((x) => JSON.stringify(x.objective) === JSON.stringify(o));
          const state = !r ? 'pending' : r.ok ? 'ok' : 'no';
          const short = !!r && !!s.replay && tooShort(r, s.replay.result.outcome);
          const max = m.def.maxDuration;
          let extend: HTMLElement | null = null;
          if (short) {
            const canExtend = max !== undefined && s.plan.duration < max;
            extend = el('div', { className: 'too-short' }, el('span', { textContent: `Flight too short: it ends at ${(s.plan.duration / DAY).toFixed(2)} d while the orbit is still being held.${canExtend ? '' : ' It is already at the mission maximum: reach the orbit earlier.'}` }));
            if (canExtend) {
              const b = el('button', { className: 'btn small', type: 'button', textContent: `Extend to ${(max! / DAY).toFixed(1)} d (max)` });
              b.onclick = () => this.ctx.editor.setDuration(max!);
              extend.append(' ', b);
            }
          }
          this.objectives.append(
            el('li', { className: `obj ${state}${current ? '' : ' stale'}` },
              el('span', { className: 'mark', textContent: state === 'ok' ? '✓' : state === 'no' ? '✗' : '…' }),
              el('span', { className: 'otext' }, el('b', { textContent: objectiveText(o) }), el('br'), el('small', { textContent: convertText(r?.detail ?? '', objectiveBodies([o])[0] ?? null) }), extend)));
        }
        if (ev?.success) {
          const k = ev.keys;
          setText(this.score, `MISSION COMPLETE · score ${(k?.score ?? ev.score).toLocaleString('en-US')} · Δv ${k ? fmtDv(k.deltaV / 10) : fmtDv(ev.deltaV)} · time ${((k?.time ?? ev.missionTime) / DAY).toFixed(2)} d`);
        } else setText(this.score, ev ? (ev.ruleViolations?.length ? 'Not scored: the plan breaks the mission rules' : 'Objectives not met yet') : '');
        this.score.className = `score${ev?.success ? ' success' : ''}`;
        const sc = m.def.scoring;
        const siteNote = m.def.launchSites?.length ? ` Par is the reference site's solution and the same for every site; the Δv and time limits above are for the chosen site${s.plan.start.kind === 'launch' ? ` (${LAUNCH_SITES.find((x) => x.id === (s.plan.start as { site: string }).site)?.name ?? ''})` : ''}.` : '';
        setText(this.par, `Par (the author's solution): Δv ${fmtDv(sc.deltaVRef)}, ${(sc.timeRef / DAY).toFixed(1)} d.${siteNote} Matching par scores ${PAR_SCORE.toLocaleString('en-US')}; less Δv and less time score higher. Leaderboards also rank by Δv alone and by time alone.`);
        const issues = conformance(m, s.plan);
        setText(this.rules, issues.length ? `Mission rules: ${issues.map((i) => i.message).join('; ')}` : '');
      } else {
        setText(this.score, 'Sandbox: no objectives.');
        setText(this.par, '');
        setText(this.rules, '');
      }
    }
  }
}

/** A briefing's structured distance in the player's convention (altitude or radius). */
function briefingDistance(d: BriefingDistance): string {
  if (d.kind === 'altitude') return fromSurface(d.value, d.body);
  if (d.kind === 'radius') return fromCentre(d.value, d.body);
  return bandFromCentre(d.lo + bodyRadiusOf(d.body), d.hi + bodyRadiusOf(d.body), d.body);
}

const bodyRadiusOf = (id: string) => { const i = bodyIndex(id); return i >= 0 ? BODIES[i].refRadius : 0; };

function objectiveText(o: Objective): string {
  switch (o.kind) {
    case 'flyby': return `Fly by ${bodyName(o.body)}${o.minAltitude !== undefined || o.maxAltitude !== undefined ? ` at ${bandFromCentre((o.minAltitude ?? 0) + bodyRadiusOf(o.body), (o.maxAltitude ?? Infinity) + bodyRadiusOf(o.body), o.body)}` : ''}`;
    case 'visit': return `Pass within ${fromCentre(o.within, o.body)} of ${bodyName(o.body)}`;
    case 'orbit': return `Orbit ${bodyName(o.body)}: periapsis ${bandFromCentre(o.periapsis[0], o.periapsis[1], o.body)}, apoapsis ${bandFromCentre(o.apoapsis[0], o.apoapsis[1], o.body)}${o.inclination ? `, inclination ${o.inclination[0]}–${o.inclination[1]}°` : ''}, ${o.revolutions} revolutions`;
    case 'reentry': return `Enter ${bodyName(o.body)}'s atmosphere${o.maxSpeed !== undefined ? ` below ${(o.maxSpeed / 1000).toFixed(1)} km/s` : ''}`;
    case 'return': return `Return to ${bodyName(o.body)} (below ${fromSurface(o.maxAltitude, o.body)})`;
    case 'escape': return `Escape ${bodyName(o.body)} at ≥ ${o.minSpeed} m/s excess`;
    case 'sequence': return o.steps.map(objectiveText).join(', then ');
    case 'max-delta-v': return `Use at most ${fmtDv(o.max)}`;
    case 'max-time': return `Within ${(o.max / DAY).toFixed(1)} days`;
  }
}

// ---------------------------------------------------------------------------

export class StartPanel {
  readonly root: HTMLElement;
  private readonly kind = el('select', { title: 'How the flight starts' });
  private readonly launchBox = el('div', { className: 'launch-box' });
  private readonly orbitBox = el('div', { className: 'orbit-box' });
  // Launch.
  private readonly site = el('select', { title: 'Launch site' });
  /** What the chosen site costs or buys in this mission: its reference solution and its limits. */
  private readonly siteInfo = el('div');
  private siteKey = '';
  private readonly liftoff = el('input', { type: 'text', spellcheck: false, title: 'Liftoff, TDB: YYYY-MM-DD HH:MM[:SS]', className: 'date-input' });
  private readonly az: HTMLInputElement;
  private readonly alt: HTMLInputElement;
  /** Label of the parking-orbit field: "Parking alt km" or "Parking radius km" (the distance convention). */
  private readonly altLabel = el('span', { textContent: 'Parking alt km' });
  private readonly altNote = el('div', { className: 'hint' });
  private readonly targetInc: HTMLInputElement;
  private readonly incOut = el('div', { className: 'kv' });
  private readonly corridor = el('div', { className: 'hint' });
  private readonly azWarn = el('div', { className: 'error' });
  private readonly azChoices = el('div', { className: 'row wrap' });
  // Orbit.
  private readonly center = el('select', { title: 'Body the orbit is about' });
  private readonly epoch = el('input', { type: 'text', spellcheck: false, title: 'Start time, TDB', className: 'date-input' });
  private readonly orbitIn: Record<keyof OrbitElements, HTMLInputElement>;
  private readonly orbitOut = el('div', { className: 'hint' });
  private readonly duration: HTMLInputElement;
  private readonly err = el('div', { className: 'error' });
  private orbitEls: OrbitElements = { periAlt: 300e3, apoAlt: 300e3, incDeg: 0, raanDeg: 0, argPeDeg: 0, trueAnomalyDeg: 0 };
  private orbitCenter = 'earth';

  constructor(private readonly ctx: UiContext) {
    this.kind.append(el('option', { value: 'launch', textContent: 'Launch from a site' }), el('option', { value: 'state', textContent: 'Start in orbit (sandbox)' }));
    this.kind.onchange = () => {
      if (this.kind.value === 'state') this.commitOrbit();
      else {
        const m = missionById(ctx.store.get().missionId) ?? MISSIONS[0];
        ctx.editor.setLaunch({ ...m.launch, time: ctx.store.get().plan.epoch });
      }
    };
    for (const s of LAUNCH_SITES) this.site.append(el('option', { value: s.id, textContent: `${s.name} (${s.latDeg.toFixed(1)}°)` }));
    this.siteInfo.className = 'hint site-info';
    const launch = () => this.launch();
    this.site.onchange = () => {
      const l = launch();
      if (!l) return;
      const s = launchSite(this.site.value);
      // Keep the azimuth if allowed at the new site, else take the middle of its corridor.
      if (!azimuthAllowed(s, l.azimuthDeg)) l.azimuthDeg = (s.azimuthMinDeg + ((s.azimuthMaxDeg - s.azimuthMinDeg + 360) % 360) / 2) % 360;
      ctx.editor.setLaunch({ ...l, site: s.id });
    };
    this.liftoff.onchange = () => {
      const c = parseCalendar(this.liftoff.value);
      const l = launch();
      if (!c || !l) {
        this.err.textContent = 'Liftoff: use YYYY-MM-DD HH:MM[:SS] (TDB)';
        return;
      }
      this.err.textContent = '';
      ctx.editor.setLaunch({ ...l, time: calendarToTdb(c) });
    };
    this.az = numInput('Inertial launch azimuth, degrees clockwise from north', '0.1', (v) => {
      const l = launch();
      if (l) ctx.editor.setLaunch({ ...l, azimuthDeg: ((v % 360) + 360) % 360 });
    });
    this.alt = numInput('Parking orbit altitude above Earth’s reference (equatorial) radius, km', '1', (v) => {
      const l = launch();
      // The field follows the distance convention: radius from Earth's centre in radius mode.
      const altM = v * 1000 - (distanceMode() === 'radius' ? bodyRadius('earth') : 0);
      if (l && altM > 0) ctx.editor.setLaunch({ ...l, altitudeM: altM });
    });
    this.targetInc = numInput('Target inclination, degrees: shows the azimuths that reach it', '0.1', () => this.renderAzChoices(ctx.store.get().plan));
    const stepAz = (d: number) => {
      const l = launch();
      if (l) ctx.editor.setLaunch({ ...l, azimuthDeg: Math.round((((l.azimuthDeg + d) % 360) + 360) % 360 * 100) / 100 });
    };
    const stepTime = (d: number) => {
      const l = launch();
      if (l) ctx.editor.setLaunch({ ...l, time: l.time + d });
    };
    const b = (t: string, f: () => void, title = '') => {
      const x = el('button', { className: 'btn small', textContent: t, title, type: 'button' });
      x.onclick = f;
      return x;
    };
    this.launchBox.append(
      row('Site', this.site),
      this.siteInfo,
      this.corridor,
      row('Liftoff', this.liftoff),
      el('div', { className: 'row steps' }, b('−1h', () => stepTime(-3600)), b('−10m', () => stepTime(-600)), b('−1m', () => stepTime(-60)), b('+1m', () => stepTime(60)), b('+10m', () => stepTime(600)), b('+1h', () => stepTime(3600)), b('+1d', () => stepTime(DAY))),
      row('Azimuth °', b('−1', () => stepAz(-1)), b('−.1', () => stepAz(-0.1)), this.az, b('+.1', () => stepAz(0.1)), b('+1', () => stepAz(1))),
      this.azWarn,
      this.incOut,
      row('Target inc °', this.targetInc),
      this.azChoices,
      el('label', { className: 'frow' }, this.altLabel, el('div', { className: 'fctl' }, this.alt)),
      this.altNote,
    );

    fillBodySelect(this.center, (i) => BODIES[i].id);
    this.center.onchange = () => {
      this.orbitCenter = this.center.value;
      this.commitOrbit();
    };
    this.epoch.onchange = () => this.commitOrbit();
    const o = (k: keyof OrbitElements, label: string, step: string, scale: number) => {
      const i = numInput(label, step, (v) => {
        this.orbitEls = { ...this.orbitEls, [k]: v * scale };
        this.commitOrbit();
      });
      return i;
    };
    this.orbitIn = {
      periAlt: o('periAlt', 'Periapsis altitude, km', '1', 1000),
      apoAlt: o('apoAlt', 'Apoapsis altitude, km', '1', 1000),
      incDeg: o('incDeg', 'Inclination to the body equator, deg', '0.1', 1),
      raanDeg: o('raanDeg', 'Longitude of ascending node, deg', '1', 1),
      argPeDeg: o('argPeDeg', 'Argument of periapsis, deg', '1', 1),
      trueAnomalyDeg: o('trueAnomalyDeg', 'True anomaly at start, deg', '1', 1),
    };
    this.orbitBox.append(
      row('Body', this.center),
      row('Start', this.epoch),
      row('Pe alt km', this.orbitIn.periAlt),
      row('Ap alt km', this.orbitIn.apoAlt),
      row('Inc °', this.orbitIn.incDeg),
      row('LAN °', this.orbitIn.raanDeg),
      row('Arg Pe °', this.orbitIn.argPeDeg),
      row('True anom °', this.orbitIn.trueAnomalyDeg),
      this.orbitOut,
    );
    this.duration = numInput('Flight duration, days (simulation stops here)', '0.5', (v) => {
      if (v > 0) ctx.editor.setDuration(v * DAY);
    });
    this.root = section('Start', 'start', row('Start', this.kind), this.launchBox, this.orbitBox, row('Duration d', this.duration), this.err);
    ctx.store.subscribe((s, p) => {
      if (s.plan !== p.plan) this.render(s.plan);
    });
    onDistanceMode(() => this.render(ctx.store.get().plan));
    this.render(ctx.store.get().plan);
  }

  private launch() {
    return launchOf(this.ctx.store.get().plan);
  }

  private commitOrbit(): void {
    const c = parseCalendar(this.epoch.value);
    const plan = this.ctx.store.get().plan;
    const epoch = c ? calendarToTdb(c) : plan.epoch;
    const i = bodyIndex(this.orbitCenter);
    if (i < 0) return;
    const b = BODIES[i];
    const state = stateFromElements(b.gm, b.refRadius, b.pole, this.orbitEls);
    this.ctx.editor.setStateStart(b.id, epoch, state);
  }

  private renderAzChoices(plan: MissionPlan): void {
    this.azChoices.replaceChildren();
    const l = launchOf(plan);
    const inc = Number(this.targetInc.value);
    if (!l || this.targetInc.value.trim() === '' || !Number.isFinite(inc)) return;
    const s = launchSite(l.site);
    const r = azimuthForInclination(s, inc);
    if (!r) {
      this.azChoices.append(el('span', { className: 'error', textContent: `${inc}° is below this site's latitude: unreachable without a plane change` }));
      return;
    }
    for (const [label, az, ok] of [['Northerly', r.northerly, r.northerlyAllowed], ['Southerly', r.southerly, r.southerlyAllowed]] as const) {
      const btn = el('button', { className: `btn small${ok ? '' : ' bad'}`, textContent: `${label} ${az.toFixed(2)}°${ok ? '' : ' (outside range)'}`, type: 'button' });
      btn.onclick = () => this.ctx.editor.setLaunch({ ...l, azimuthDeg: Math.round(az * 1e4) / 1e4 });
      this.azChoices.append(btn);
    }
  }

  /** Site options for the current mission: offered ones with their reference and limits, the others disabled with the reason. */
  private syncSites(current: string): void {
    const missionId = this.ctx.store.get().missionId;
    const def = missionById(missionId)?.def;
    if (this.siteKey !== missionId) {
      this.siteKey = missionId;
      const allowed = def ? allowedSites(def) : undefined;
      for (const opt of [...this.site.options]) {
        const site = LAUNCH_SITES.find((x) => x.id === opt.value)!;
        const o = def ? siteOption(def, site.id) : undefined;
        const off = !!allowed && !allowed.includes(site.id);
        opt.disabled = off;
        const extra = o && o.offered ? ` · ref ${Math.round(o.deltaV).toLocaleString('en-US')} m/s, max ${o.maxDeltaV.toLocaleString('en-US')} m/s` : off ? ' · not offered' : '';
        opt.textContent = `${site.name} (${site.latDeg.toFixed(1)}°)${extra}`;
        opt.title = def ? (siteSummary(def, site.id) ?? '') : '';
      }
    }
    setText(this.siteInfo, def ? (siteSummary(def, current) ?? '') : '');
  }

  private render(plan: MissionPlan): void {
    const st = plan.start;
    setValue(this.kind, st.kind);
    this.launchBox.style.display = st.kind === 'launch' ? '' : 'none';
    this.orbitBox.style.display = st.kind === 'state' ? '' : 'none';
    setValue(this.duration, String(+(plan.duration / DAY).toFixed(6)));
    if (st.kind === 'launch') {
      const l = launchOf(plan)!;
      let site;
      try {
        site = launchSite(l.site);
      } catch {
        this.azWarn.textContent = `Unknown launch site ${l.site}`;
        return;
      }
      this.syncSites(l.site);
      setValue(this.site, l.site);
      setValue(this.liftoff, formatCalendar(tdbToCalendar(l.time)));
      setValue(this.az, String(+l.azimuthDeg.toFixed(4)));
      const radiusMode = distanceMode() === 'radius';
      setValue(this.alt, String(+((l.altitudeM + (radiusMode ? bodyRadius('earth') : 0)) / 1000).toFixed(3)));
      setText(this.altLabel, radiusMode ? 'Parking radius km' : 'Parking alt km');
      // A mission fixes the parking orbit (rules.launch): shown read-only.
      const fixed = missionById(this.ctx.store.get().missionId)?.def?.rules.launch;
      this.alt.disabled = !!fixed;
      this.alt.title = fixed ? `Fixed by this mission: parking orbit at ${fromSurface(fixed.altitudeM, 'earth')}` : `Parking orbit ${radiusMode ? 'radius from Earth’s centre' : 'altitude above Earth’s reference (equatorial) radius'}, km`;
      setText(this.altNote, fixed ? `Parking orbit fixed by this mission (${fromSurface(fixed.altitudeM, 'earth')}); ascent ${fixed.ascentTimeS} s, ${fixed.downrangeDeg}° downrange.` : '');
      setText(this.corridor, `Range-safety azimuths ${site.azimuthMinDeg}° → ${site.azimuthMaxDeg}° (clockwise)${site.azimuthApproximate ? ', approximate' : ''}`);
      const ok = azimuthAllowed(site, l.azimuthDeg);
      setText(this.azWarn, ok ? '' : `Azimuth ${l.azimuthDeg.toFixed(2)}° is outside ${site.name}'s range-safety corridor: launch refused`);
      // Live inclination: the same plane geometry the replay's launch uses.
      const pl = launchPlane(site, l.time, l.azimuthDeg);
      const c = pl.normal[0] * pl.pole[0] + pl.normal[1] * pl.pole[1] + pl.normal[2] * pl.pole[2];
      const inc = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
      this.incOut.innerHTML = `<span>Inclination</span><b class="inc-value">${inc.toFixed(2)}°</b><span>steer ${groundRelativeAzimuthDeg(site, l.azimuthDeg).toFixed(1)}° ground-rel. · insertion T+${simulationStartOffset(st)} s</span>`;
      this.renderAzChoices(plan);
    } else {
      const i = bodyIndex(st.center);
      if (i >= 0) {
        this.orbitCenter = st.center;
        setValue(this.center, st.center);
        setValue(this.epoch, formatCalendar(tdbToCalendar(plan.epoch)));
        const b = BODIES[i];
        const e = elementsFromState(b.gm, b.refRadius, b.pole, st.state);
        setText(this.orbitOut, `Two-body osculating: Pe ${fromSurface(e.periAlt, b.id)}, Ap ${Number.isFinite(e.apoAlt) ? fromSurface(e.apoAlt, b.id) : 'unbound'}, inc ${e.incDeg.toFixed(2)}° to ${b.name}'s equator`);
        for (const [k, inp] of Object.entries(this.orbitIn) as [keyof OrbitElements, HTMLInputElement][]) {
          const v = this.orbitEls[k];
          setValue(inp, String(+(k === 'periAlt' || k === 'apoAlt' ? v / 1000 : v).toFixed(4)));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class CraftPanel {
  readonly root: HTMLElement;
  private readonly preset = el('select', { title: 'Start from a preset spacecraft' });
  private readonly wet: HTMLInputElement;
  private readonly dry: HTMLInputElement;
  private readonly engines = el('div', { className: 'engines' });
  private readonly editBox = el('div', { className: 'craft-edit' });
  private readonly fixed = el('div', { className: 'craft-fixed' });
  private readonly perf = el('div', { className: 'craft-perf' });
  private readonly errs = el('div', { className: 'error' });
  private lastEngines = '';

  constructor(private readonly ctx: UiContext) {
    this.preset.append(el('option', { value: '', textContent: 'Start from a preset…' }));
    for (const p of SPACECRAFT_PRESETS) this.preset.append(el('option', { value: p.id, textContent: p.label }));
    this.preset.onchange = () => {
      const p = SPACECRAFT_PRESETS.find((x) => x.id === this.preset.value);
      if (p) ctx.editor.setSpacecraft(p.craft);
      this.preset.value = '';
    };
    const sc = () => ctx.store.get().plan.spacecraft;
    this.wet = numInput('Wet (fuelled) mass, kg', '100', (v) => ctx.editor.setSpacecraft({ ...sc(), wetMass: v }));
    this.dry = numInput('Dry mass, kg', '100', (v) => ctx.editor.setSpacecraft({ ...sc(), dryMass: v }));
    const add = el('button', { className: 'btn small', textContent: '+ Engine', type: 'button' });
    add.onclick = () => ctx.editor.setSpacecraft({ ...sc(), engines: [...sc().engines, { thrust: 1000, isp: 300 }] });
    this.editBox.append(this.preset, row('Wet kg', this.wet), row('Dry kg', this.dry), this.engines, add);
    this.root = section('Spacecraft', 'craft', this.fixed, this.editBox, this.perf, this.errs);
    ctx.store.subscribe((s, p) => {
      if (s.plan !== p.plan || s.missionId !== p.missionId) this.render();
    });
    this.render();
  }

  private render(): void {
    const st = this.ctx.store.get();
    const sc = st.plan.spacecraft;
    const entry = missionById(st.missionId);
    const locked = !!entry?.def;
    this.editBox.style.display = locked ? 'none' : '';
    this.fixed.style.display = locked ? '' : 'none';
    if (locked) {
      this.fixed.innerHTML =
        `<div class="hint">Fixed by the mission “${esc(entry!.title)}”. Edit the spacecraft in Sandbox.</div>` +
        `<div class="kv"><span>Wet mass</span><b>${fmtKg(sc.wetMass)}</b></div>` +
        `<div class="kv"><span>Dry mass</span><b>${fmtKg(sc.dryMass)}</b></div>` +
        sc.engines.map((e, i) => `<div class="kv"><span>Engine E${i + 1}</span><b>${(e.thrust / 1000).toLocaleString('en-US')} kN · Isp ${e.isp} s</b></div>`).join('');
    } else {
      setValue(this.wet, String(sc.wetMass));
      setValue(this.dry, String(sc.dryMass));
      const key = JSON.stringify(sc.engines);
      if (key !== this.lastEngines && !this.engines.contains(document.activeElement)) {
        this.lastEngines = key;
        this.engines.replaceChildren();
        sc.engines.forEach((e, i) => {
          const set = (patch: Partial<{ thrust: number; isp: number }>) => {
            const cur = this.ctx.store.get().plan.spacecraft;
            const engines = cur.engines.map((x, j) => (j === i ? { ...x, ...patch } : x));
            this.ctx.editor.setSpacecraft({ ...cur, engines });
          };
          const thrust = numInput(`Engine E${i + 1} thrust, kN`, '1', (v) => set({ thrust: v * 1000 }));
          const isp = numInput(`Engine E${i + 1} specific impulse, s`, '1', (v) => set({ isp: v }));
          thrust.value = String(e.thrust / 1000);
          isp.value = String(e.isp);
          const del = el('button', { className: 'btn small', textContent: '×', title: 'Remove engine', type: 'button', disabled: sc.engines.length < 2 });
          del.onclick = () => {
            const cur = this.ctx.store.get().plan.spacecraft;
            this.ctx.editor.setSpacecraft({ ...cur, engines: cur.engines.filter((_, j) => j !== i) });
          };
          this.engines.append(el('div', { className: 'engine' }, el('span', { textContent: `E${i + 1}` }), thrust, el('small', { textContent: 'kN' }), isp, el('small', { textContent: 's' }), del));
        });
      }
    }
    const perf = craftPerformance(sc);
    this.perf.innerHTML =
      `<div class="kv"><span>Propellant</span><b>${fmtKg(sc.wetMass - sc.dryMass)}</b></div>` +
      perf.map((p) => `<div class="kv"><span>E${p.engine + 1} thrust/weight (full, Earth g)</span><b>${Number.isFinite(p.twr) ? p.twr.toFixed(3) : '—'}</b></div>` +
        `<div class="kv"><span>E${p.engine + 1} total Δv (rocket equation)</span><b>${fmtDv(p.dv)}</b></div>`).join('');
    // Validation from the plan layer (spacecraft fields only).
    const errs = planErrors(st.plan).plan.filter((e) => /spacecraft|mass|engine|thrust|isp/i.test(e));
    setText(this.errs, errs.join('\n'));
  }
}

// ---------------------------------------------------------------------------

/** Small, medium, large steps (buttons ‹ ‹‹ ‹‹‹; keys with Alt, plain, Shift). Δv: trim to shape. Time: 1 s to 10 min. */
export const DV_LEVELS = [0.1, 1, 10] as const;
export const T_LEVELS = [1, 60, 600] as const;
const dvText = (v: number) => `${v} m/s`;
const tText = (v: number) => (v < 60 ? `${v} s` : `${v / 60} min`);
const AXES = ['Prograde', 'Normal', 'Radial out'] as const;

export class NodesPanel {
  readonly root: HTMLElement;
  private readonly list = el('div', { className: 'node-list' });
  private readonly detail = el('div', { className: 'node-detail' });
  private readonly parked = el('div', { className: 'parked' });
  private readonly planErr = el('div', { className: 'error' });
  // Detail controls.
  private readonly timeTuner: Tuner;
  private readonly dvTuners: Tuner[] = [];
  private readonly frameSel = el('select', { title: 'Reference body of the orbital frame (prograde, normal, radial are relative to it)' });
  private readonly engineSel = el('select', { title: 'Engine' });
  private readonly readout = el('div', { className: 'node-readout' });
  private readonly nodeErr = el('div', { className: 'error' });
  private readonly undoBtn = el('button', { className: 'btn small hist', type: 'button', textContent: '↶ Undo' });
  private readonly redoBtn = el('button', { className: 'btn small hist', type: 'button', textContent: '↷ Redo' });

  constructor(private readonly ctx: UiContext) {
    fillBodySelect(this.frameSel, (i) => BODIES[i].id, [{ value: '@inertial', label: 'Inertial (ICRF x y z)' }]);
    this.frameSel.onchange = () => {
      const i = ctx.store.get().selectedNode;
      if (i === null) return;
      const frame: PlanFrame = this.frameSel.value === '@inertial' ? { kind: 'inertial' } : { kind: 'orbital', body: this.frameSel.value };
      ctx.editor.updateNode(i, { frame });
    };
    this.engineSel.onchange = () => {
      const i = ctx.store.get().selectedNode;
      if (i !== null) ctx.editor.updateNode(i, { engine: Number(this.engineSel.value) });
    };
    const sel = () => ctx.store.get().selectedNode;
    const btn = (t: string, f: () => void, title = '') => {
      const b = el('button', { className: 'btn small', textContent: t, title, type: 'button' });
      b.onclick = f;
      return b;
    };
    this.timeTuner = new Tuner({
      label: 'Time',
      title: 'Burn centre, mission elapsed time: "T+1d 02:03:04", "3h 20m", or seconds',
      inputClass: 'met-input',
      inputMode: 'text',
      levels: T_LEVELS,
      levelText: tText,
      gesture: (open) => ctx.editor.gesture(open),
      nudge: (d) => { const i = sel(); if (i !== null) ctx.editor.nudgeTime(i, d); },
      commit: (text) => this.commitTime(text),
    });
    this.dvTuners = AXES.map((name, axis) => new Tuner({
      label: name,
      title: `${name} delta-v, m/s`,
      inputClass: 'num dv',
      inputMode: 'decimal',
      levels: DV_LEVELS,
      levelText: dvText,
      gesture: (open) => ctx.editor.gesture(open),
      zero: () => {
        const i = sel();
        const n = i !== null ? nodesOf(ctx.store.get().plan)[i]?.node : undefined;
        if (!n || i === null) return;
        const dv: [number, number, number] = [...n.dv];
        dv[axis] = 0;
        ctx.editor.updateNode(i, { dv });
      },
      nudge: (d) => { const i = sel(); if (i !== null) ctx.editor.nudgeDv(i, axis as 0 | 1 | 2, d); },
      commit: (text) => {
        const v = Number(text);
        const i = sel();
        if (text.trim() === '' || !Number.isFinite(v) || i === null) return 'Enter a number in m/s';
        const n = nodesOf(ctx.store.get().plan)[i]?.node;
        if (!n) return null;
        const dv: [number, number, number] = [...n.dv];
        dv[axis] = v;
        ctx.editor.updateNode(i, { dv });
        return null;
      },
      negate: () => {
        const i = sel();
        const n = i !== null ? nodesOf(ctx.store.get().plan)[i]?.node : undefined;
        if (!n || i === null) return;
        const dv: [number, number, number] = [...n.dv];
        dv[axis] = -dv[axis];
        ctx.editor.updateNode(i, { dv });
      },
    }));
    const actions = el('div', { className: 'row wrap' },
      btn('Go to node', () => { const i = sel(); if (i !== null) this.goTo(i); }),
      nodeAction('Disable', 'toggle', 'Disable this node (kept below, Enable brings it back)', () => { const i = sel(); if (i !== null) ctx.editor.disableNode(i); }),
      nodeAction('Delete node', 'danger', 'Delete this node (Delete key; Undo brings it back)', () => { const i = sel(); if (i !== null) ctx.editor.removeNode(i); }),
      btn('Target flyby…', () => { const i = sel(); if (i !== null) ctx.openPlanner?.('target', i); }, 'Correct this burn toward a closest-approach altitude at a body'));
    this.detail.append(this.timeTuner.root, ...this.dvTuners.map((t) => t.root), row('Frame', this.frameSel), row('Engine', this.engineSel), this.readout, this.nodeErr, actions);
    const addCursor = btn('+ Node at cursor', () => this.addAtCursor(), 'Add a burn at the time cursor (or click the trajectory)');
    const planner = btn('Transfer planner…', () => ctx.openPlanner?.('transfer'), 'Porkchop plots, departure burns, flyby targeting and chains');
    this.undoBtn.setAttribute('aria-label', 'Undo the last plan edit (Ctrl or ⌘ Z)');
    this.redoBtn.setAttribute('aria-label', 'Redo (Shift Ctrl or ⌘ Z)');
    this.undoBtn.onclick = () => ctx.editor.undo();
    this.redoBtn.onclick = () => ctx.editor.redo();
    const syncHistory = () => {
      this.undoBtn.disabled = !ctx.editor.history.canUndo;
      this.redoBtn.disabled = !ctx.editor.history.canRedo;
    };
    ctx.editor.onHistory(syncHistory);
    syncHistory();
    this.root = section('Maneuver nodes', 'nodes', this.planErr, el('div', { className: 'row wrap' }, addCursor, el('span', { className: 'hint', textContent: 'or pick a point on the trajectory' }), planner, el('span', { className: 'hist-group' }, this.undoBtn, this.redoBtn)), this.list, this.detail, this.parked);
    ctx.store.subscribe((s, p) => {
      if (s.plan !== p.plan || s.selectedNode !== p.selectedNode || s.replay !== p.replay || s.parked !== p.parked) this.render();
    });
    this.render();
  }


  private commitTime(text: string): string | null {
    const i = this.ctx.store.get().selectedNode;
    const v = parseDuration(text);
    if (i === null) return null;
    if (v === null) {
      const m = 'Time: use "T+1d 02:03:04.5", "2h 30m" or seconds after liftoff / start';
      this.nodeErr.textContent = m;
      return m;
    }
    this.ctx.editor.updateNode(i, { t: v });
    return null;
  }

  addAtCursor(): void {
    const s = this.ctx.store.get();
    const plan = s.plan;
    let t = s.t - plan.epoch;
    const lo = simulationStartOffset(plan.start) + 60;
    if (!(t >= lo && t <= plan.duration)) {
      const last = nodesOf(plan).at(-1);
      t = last ? last.node.t + 600 : lo + 600;
    }
    const body = this.ctx.dominantBody(t);
    this.ctx.editor.addNode(Math.round(t), { kind: 'orbital', body });
  }

  goTo(i: number): void {
    const s = this.ctx.store.get();
    const n = nodesOf(s.plan)[i];
    if (n) this.ctx.store.set({ t: s.plan.epoch + n.burn.start, paused: true, loadingTarget: s.plan.epoch + n.burn.start });
  }

  private render(): void {
    const s = this.ctx.store.get();
    const plan = s.plan;
    const infos = nodesOf(plan);
    const errs = planErrors(plan);
    const reports = s.replay && s.replay.plan === plan && s.replay.preview === null ? s.replay.result.burns : null;
    setText(this.planErr, errs.plan.join('\n'));
    // List.
    this.list.replaceChildren();
    if (infos.length === 0) this.list.append(el('div', { className: 'hint', textContent: 'No burns yet.' }));
    infos.forEach((x, i) => {
      const e = errs.burns.get(i);
      const frame = x.node.frame.kind === 'orbital' ? bodyName(x.node.frame.body) : 'inertial';
      const actual = reports?.[i];
      const r = el('div', { className: `node-row${s.selectedNode === i ? ' selected' : ''}${e ? ' invalid' : ''}`, dataset: { index: String(i) } },
        el('span', { className: 'nidx', textContent: `#${i + 1}` }),
        el('span', { className: 'nmet', textContent: formatMet(x.node.t, 0) }),
        el('span', { className: 'ndv', textContent: fmtDv(dvMagnitude(x.node.dv)) }),
        el('span', { className: 'nframe', textContent: frame }),
        actual ? el('span', { className: 'nact', textContent: `actual ${fmtDv(actual.deltaV)}` }) : null,
        e ? el('div', { className: 'nerr', textContent: e.join('; ') }) : null,
        x.short ? el('div', { className: 'nerr', textContent: 'Not enough propellant: this burn will be cut short' }) : null);
      r.onclick = () => this.ctx.store.set({ selectedNode: i });
      activatable(r, `Burn ${i + 1}`);
      r.append(el('span', { className: 'nrow-acts' },
        nodeAction('Disable', 'toggle', `Disable burn ${i + 1}`, () => this.ctx.editor.disableNode(i)),
        nodeAction('Delete', 'danger', `Delete burn ${i + 1}`, () => this.ctx.editor.removeNode(i))));
      this.list.append(r);
    });
    // Detail.
    const i = s.selectedNode;
    const x = i !== null ? infos[i] : undefined;
    this.detail.style.display = x ? '' : 'none';
    if (x && i !== null) {
      this.timeTuner.setValue(formatMet(x.node.t, 1));
      setValue(this.frameSel, x.node.frame.kind === 'orbital' ? x.node.frame.body : '@inertial');
      const engKey = plan.spacecraft.engines.map((e) => `${e.thrust}/${e.isp}`).join();
      if (this.engineSel.dataset.key !== engKey) {
        this.engineSel.dataset.key = engKey;
        this.engineSel.replaceChildren(...plan.spacecraft.engines.map((e, k) => el('option', { value: String(k), textContent: `E${k + 1}: ${(e.thrust / 1000).toLocaleString('en-US')} kN, ${e.isp} s` })));
      }
      setValue(this.engineSel, String(x.node.engine));
      x.node.dv.forEach((v, k) => this.dvTuners[k].setValue(String(+v.toFixed(4))));
      const axisNames = x.node.frame.kind === 'inertial' ? ['ICRF x', 'ICRF y', 'ICRF z'] : AXES;
      this.dvTuners.forEach((t, k) => t.setLabel(axisNames[k]));
      const rep = reports?.[i];
      const mdot = plan.spacecraft.engines[x.burn.engine]?.thrust / ((plan.spacecraft.engines[x.burn.engine]?.isp ?? 1) * 9.80665);
      this.readout.innerHTML =
        `<div class="kv"><span>Requested Δv</span><b>${fmtDv(dvMagnitude(x.node.dv))}</b></div>` +
        `<div class="kv"><span>Replay Δv (expended)</span><b class="${rep && Math.abs(rep.deltaV - dvMagnitude(x.node.dv)) > 0.05 * Math.max(1, dvMagnitude(x.node.dv)) ? 'warn' : ''}">${rep ? fmtDv(rep.deltaV) : s.replay?.plan === plan && s.replay.preview === null ? 'not flown' : '…'}</b></div>` +
        `<div class="kv"><span>Burn</span><b>${x.burn.duration.toFixed(2)} s${rep ? ` (flown ${rep.burnTime.toFixed(2)} s)` : ''}</b></div>` +
        `<div class="kv"><span>Ignition → cutoff</span><b>${esc(formatMet(x.burn.start, 1))} → ${esc(formatMet(x.burn.start + x.burn.duration, 1))}</b></div>` +
        `<div class="kv"><span>Mass</span><b>${fmtKg(x.m0)} → ${fmtKg(x.m1)}</b></div>` +
        `<div class="kv"><span>Propellant</span><b>${fmtKg(x.m0 - x.m1)}${rep ? ` (flown ${fmtKg(rep.propellant)})` : ''} · ${Number.isFinite(mdot) ? mdot.toFixed(2) : '—'} kg/s</b></div>`;
      setText(this.nodeErr, [...(errs.burns.get(i) ?? []), x.short ? 'Not enough propellant left for the requested Δv: the burn will run the tanks dry.' : ''].filter(Boolean).join('\n'));
    }
    // Parked.
    this.parked.replaceChildren();
    if (s.parked.length) {
      this.parked.append(el('div', { className: 'sub', textContent: 'Disabled (not flown)' }));
      s.parked.forEach((n, k) => {
        this.parked.append(el('div', { className: 'node-row parked-row' },
          el('span', { className: 'nidx', textContent: 'off' }),
          el('span', { className: 'nmet', textContent: formatMet(n.t, 0) }),
          el('span', { className: 'ndv', textContent: fmtDv(dvMagnitude(n.dv)) }),
          el('span', { className: 'nrow-acts' },
            nodeAction('Enable', 'toggle', `Enable the disabled node at ${formatMet(n.t, 0)}`, () => this.ctx.editor.enableParked(k)),
            nodeAction('Delete', 'danger', `Delete the disabled node at ${formatMet(n.t, 0)}`, () => this.ctx.editor.deleteParked(k)))));
      });
    }
  }
}

// ---------------------------------------------------------------------------

export class EventsPanel {
  readonly root: HTMLElement;
  private readonly list = el('div', { className: 'event-list' });
  private readonly summary = el('div', { className: 'hint' });
  private readonly planeList = el('div', { className: 'event-list plane-list' });
  listed: ListedEvent[] = [];
  private crossings: { list: readonly PlaneCrossing[]; epoch: number; label: string } = { list: [], epoch: 0, label: '' };

  constructor(private readonly ctx: UiContext, private readonly listOptions: () => Parameters<typeof listEvents>[2]) {
    this.root = section('Events', 'events', this.summary, this.list, this.planeList);
    onDistanceMode(() => this.render());
    ctx.store.subscribe((s, p) => {
      if (s.replay !== p.replay || s.selectedEvent !== p.selectedEvent) this.render();
    });
    this.render();
  }

  private render(): void {
    const s = this.ctx.store.get();
    const r = s.replay;
    this.list.replaceChildren();
    if (!r) {
      setText(this.summary, 'Waiting for the replay…');
      this.listed = [];
      return;
    }
    this.listed = listEvents(r.result.events, this.ctx.soi, this.listOptions());
    setText(this.summary, `${this.listed.length} of ${r.result.events.length} events (extrema of bodies whose sphere of influence the craft is in, crossings, and closest approaches)`);
    const epoch = r.plan.epoch;
    const row = (x: ListedEvent) => {
      const ev = x.ev;
      const focus = el('button', { className: 'btn small', textContent: '◎', title: `Focus camera on ${bodyName(ev.body)}`, type: 'button', ariaLabel: `Focus camera on ${bodyName(ev.body)}` });
      focus.onclick = (e) => {
        e.stopPropagation();
        this.ctx.focusBody(ev.body);
      };
      const rowEl = el('div', { className: `event-row ${x.failure ? 'failure' : ''} ${x.role} k-${ev.kind}${s.selectedEvent === x.index ? ' selected' : ''}`, dataset: { index: String(x.index) } },
        el('span', { className: 'emet', textContent: formatMet(ev.t - epoch, 0) }),
        el('span', { className: 'ename', textContent: eventLabel(x, bodyName) }),
        el('span', { className: 'eval', textContent: `${fromSurface(ev.altitude, ev.body)} · ${formatSpeed(ev.speed)}` }),
        focus);
      rowEl.onclick = () => this.ctx.store.set({ selectedEvent: x.index, t: ev.t, paused: true, loadingTarget: ev.t });
      activatable(rowEl);
      return rowEl;
    };
    const distant = this.listed.filter((x) => x.distant);
    for (const g of groupApsides(this.listed.filter((x) => !x.distant))) {
      if (g.length === 1) {
        this.list.append(row(g[0]));
        continue;
      }
      const key = `${g[0].ev.body}:${g[0].index}`;
      const open = this.expanded.has(key) || g.some((x) => x.index === s.selectedEvent);
      const alts = g.map((x) => x.ev.altitude);
      const sum = el('button', { className: 'event-row apsis-group', type: 'button', ariaExpanded: String(open) },
        el('span', { className: 'emet', textContent: formatMet(g[0].ev.t - epoch, 0) }),
        el('span', { className: 'ename', textContent: `${open ? '▾' : '▸'} ${g.length} apsides at ${bodyName(g[0].ev.body)} (near-circular)` }),
        el('span', { className: 'eval', textContent: `${fromSurface(Math.min(...alts), g[0].ev.body)} – ${fromSurface(Math.max(...alts), g[0].ev.body)} · until ${formatMet(g[g.length - 1].ev.t - epoch, 0)}` }));
      sum.onclick = () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.render();
      };
      this.list.append(sum);
      if (open) for (const x of g) this.list.append(row(x));
    }
    if (distant.length) {
      const open = this.expanded.has('distant') || distant.some((x) => x.index === s.selectedEvent);
      const sum = el('button', { className: 'event-row apsis-group distant-group', type: 'button', ariaExpanded: String(open) },
        el('span', { className: 'emet', textContent: '' }),
        el('span', { className: 'ename', textContent: `${open ? '▾' : '▸'} Distant bodies (${distant.length})` }),
        el('span', { className: 'eval', textContent: `closest points to ${distant.map((x) => bodyName(x.ev.body)).join(', ')}: not encounters, not drawn on the map` }));
      sum.onclick = () => {
        if (this.expanded.has('distant')) this.expanded.delete('distant');
        else this.expanded.add('distant');
        this.render();
      };
      this.list.append(sum);
      if (open) for (const x of distant) this.list.append(row(x));
    }
    this.renderCrossings();
  }
  private readonly expanded = new Set<string>();

  /** Ascending / descending node crossings of the reference plane (main.ts computes them from the replay). */
  setCrossings(list: readonly PlaneCrossing[], epoch: number, label: string): void {
    this.crossings = { list, epoch, label };
    this.renderCrossings();
  }

  private renderCrossings(): void {
    const { list, epoch, label } = this.crossings;
    this.planeList.replaceChildren();
    if (!list.length) return;
    this.planeList.append(el('div', { className: 'sub', textContent: `Nodes on ${label}` }));
    const row = (c: PlaneCrossing) => {
      const r = el('div', { className: `event-row pnode ${c.ascending ? 'asc' : 'desc'}` },
        el('span', { className: 'emet', textContent: formatMet(c.t - epoch, 0) }),
        el('span', { className: 'ename', textContent: c.ascending ? '▲ Ascending node' : '▼ Descending node' }),
        el('span', { className: 'eval', textContent: `${c.inclinationDeg.toFixed(2)}° relative inclination` }));
      r.onclick = () => this.ctx.store.set({ t: c.t, paused: true, loadingTarget: c.t });
      activatable(r);
      return r;
    };
    for (const g of groupCrossings(list)) {
      if (g.length === 1) {
        this.planeList.append(row(list[g[0]]));
        continue;
      }
      const key = `pn:${g[0]}`;
      const open = this.expanded.has(key);
      const a = list[g[0]], b = list[g[g.length - 1]];
      const sum = el('button', { className: 'event-row apsis-group', type: 'button', ariaExpanded: String(open) },
        el('span', { className: 'emet', textContent: formatMet(a.t - epoch, 0) }),
        el('span', { className: 'ename', textContent: `${open ? '▾' : '▸'} ${g.length} node crossings at ${a.inclinationDeg.toFixed(2)}°` }),
        el('span', { className: 'eval', textContent: `until ${formatMet(b.t - epoch, 0)}` }));
      sum.onclick = () => {
        if (open) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderCrossings();
      };
      this.planeList.append(sum);
      if (open) for (const i of g) this.planeList.append(row(list[i]));
    }
  }
}

/**
 * Runs of 4 or more consecutive periapsis / apoapsis events of one body whose
 * altitudes differ by under 2% of the orbit radius (a near-circular orbit,
 * where the apsides are numerical noise) become one group; everything else
 * stays a group of one. Pure.
 */
export function groupApsides(listed: readonly ListedEvent[]): ListedEvent[][] {
  const out: ListedEvent[][] = [];
  let run: ListedEvent[] = [];
  const flush = () => {
    if (run.length >= 4) out.push(run);
    else for (const x of run) out.push([x]);
    run = [];
  };
  for (const x of listed) {
    const apsis = x.role === 'event' && !x.failure && (x.ev.kind === 'periapsis' || x.ev.kind === 'apoapsis');
    if (!apsis) {
      flush();
      out.push([x]);
      continue;
    }
    if (run.length && run[0].ev.body !== x.ev.body) flush();
    const r = bodyIndex(x.ev.body);
    const R = r >= 0 ? BODIES[r].refRadius : 0;
    const alts = [...run.map((y) => y.ev.altitude), x.ev.altitude];
    const spread = Math.max(...alts) - Math.min(...alts);
    if (run.length && spread > 0.02 * (Math.min(...alts) + R)) flush();
    run.push(x);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------

const OUTCOME_TEXT: Record<string, string> = {
  completed: 'Flight completed',
  impact: 'IMPACT',
  atmosphere: 'Atmospheric entry',
  'invalid-plan': 'Invalid plan',
  'version-mismatch': 'Version mismatch',
  'unsupported-start': 'Unsupported start',
  'step-limit': 'Step limit reached',
  'event-limit': 'Event limit reached',
  'physics-error': 'Physics error',
  aborted: 'Stopped',
};

export class ResultsPanel {
  readonly root: HTMLElement;
  private readonly outcome = el('div', { className: 'outcome' });
  private readonly table = el('div', { className: 'budget' });
  private readonly burns = el('table', { className: 'burns' });
  private readonly share = el('div', { className: 'share' });
  private readonly digest = el('div', { className: 'digest', title: 'Replay digest: two players with the same digest flew bit-identical flights' });
  private readonly status = el('div', { className: 'status' });

  constructor(private readonly ctx: UiContext) {
    const copy = el('button', { className: 'btn small', textContent: 'Copy share link', type: 'button' });
    copy.onclick = async () => {
      const url = ctx.shareUrl();
      if (!url) {
        copy.textContent = 'Plan invalid: fix it first';
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
      } catch {
        prompt('Share link', url);
      }
      setTimeout(() => (copy.textContent = 'Copy share link'), 1500);
    };
    this.share.append(copy);
    this.root = section('Flight', 'results', this.status, this.outcome, this.table, this.burns, this.share, this.digest);
    ctx.store.subscribe((s, p) => {
      if (s.replay !== p.replay || s.plan !== p.plan || s.replayStatus !== p.replayStatus) this.render();
    });
    this.render();
  }

  private render(): void {
    const s = this.ctx.store.get();
    const r = s.replay;
    const current = r?.plan === s.plan;
    const errs = planErrors(s.plan);
    const invalid = errs.plan.length + errs.burns.size > 0;
    const preview = r?.preview ?? null;
    setText(this.status, invalid
      ? 'Plan has errors (see the nodes / start panels): showing the last valid flight.'
      : s.replayStatus === 'chunks' ? 'Preparing the ephemeris for this flight…'
      : preview !== null && current ? `Preview: first ${(preview / DAY).toFixed(1)} of ${(s.plan.duration / DAY).toFixed(1)} days flown; refining…`
      : s.replayStatus === 'running' || !current ? 'Replaying…' : '');
    this.status.className = `status${invalid ? ' error' : ''}`;
    if (!r) {
      setText(this.outcome, '');
      return;
    }
    const res = r.result;
    const bad = res.outcome !== 'completed' && !(res.outcome === 'atmosphere' && r.evaluation?.success);
    this.outcome.className = `outcome o-${res.outcome}${bad ? ' fail' : ''}${current ? '' : ' stale'}`;
    this.outcome.innerHTML = `<b>${esc(OUTCOME_TEXT[res.outcome] ?? res.outcome)}</b> ${res.reason ? `<span>${esc(res.reason)}</span>` : ''}`;
    const b = budget(r.plan);
    const sc = r.plan.spacecraft;
    const left = sc.wetMass - res.propellantUsed;
    const ve0 = sc.engines[0].isp * 9.80665;
    const remaining = ve0 * Math.log(Math.max(left, sc.dryMass) / sc.dryMass);
    this.table.innerHTML =
      (res.launch ? `<div class="kv"><span>Orbit insertion (replay)</span><b>${esc(formatMet(res.launch.t - r.plan.epoch, 0))}${res.launch.inclinationDeg !== undefined ? ` · inclination ${res.launch.inclinationDeg.toFixed(2)}°` : ''}</b></div>` : '') +
      `<div class="kv"><span>Δv used (replay)</span><b>${fmtDv(res.deltaV)}</b></div>` +
      `<div class="kv"><span>Δv requested</span><b>${fmtDv(b.requested)}</b></div>` +
      `<div class="kv"><span>Δv remaining (E1)</span><b>${fmtDv(remaining)}</b></div>` +
      `<div class="kv"><span>Propellant</span><b>${fmtKg(res.propellantUsed)} used · ${fmtKg(left - sc.dryMass)} left</b></div>` +
      `<div class="kv"><span>Mission elapsed</span><b>${esc(formatMet(res.elapsed, 0))}</b></div>` +
      `<div class="kv"><span>Ended</span><b>${Number.isFinite(res.finalT) ? esc(formatCalendar(tdbToCalendar(res.finalT), false)) + ' TDB' : '—'}</b></div>`;
    const nodes = nodesOf(r.plan);
    this.burns.innerHTML = res.burns.length
      ? `<tr><th>#</th><th>planned</th><th>flown</th><th>time</th><th>prop.</th></tr>` +
        res.burns.map((x, i) => `<tr><td>${i + 1}</td><td>${fmtDv(dvMagnitude(nodes[i]?.node.dv ?? [0, 0, 0]))}</td><td>${fmtDv(x.deltaV)}</td><td>${x.burnTime.toFixed(1)} s</td><td>${fmtKg(x.propellant)}</td></tr>`).join('')
      : '';
    setText(this.digest, `digest ${res.digest} · ${res.steps} steps · replay ${r.replayMs.toFixed(0)} ms · edit→redraw ${r.latencyMs.toFixed(0)} ms`);
  }
}

// ---------------------------------------------------------------------------

/** A clickable row reachable and operable from the keyboard. */
/** A node action button (Disable / Enable look alike; Delete in the danger style). Its click does not select the row. */
function nodeAction(text: string, kind: 'toggle' | 'danger', label: string, f: () => void): HTMLButtonElement {
  const b = el('button', { className: `btn small nact-btn ${kind}`, type: 'button', textContent: text });
  b.setAttribute('aria-label', label);
  b.onclick = (e) => {
    e.stopPropagation();
    f();
  };
  b.addEventListener('keydown', (e) => e.stopPropagation());
  return b;
}

function activatable(e: HTMLElement, label?: string): void {
  e.tabIndex = 0;
  e.setAttribute('role', 'button');
  if (label) e.setAttribute('aria-label', label);
  e.addEventListener('keydown', (k) => {
    if ((k.key === 'Enter' || k.key === ' ') && k.target === e) {
      k.preventDefault();
      e.click();
    }
  });
}
