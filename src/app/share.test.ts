import { describe, expect, it } from 'vitest';
import { formatMet, parseDuration } from './dom';
import { listEvents } from './events-view';
import { encodePlan, makePlan, PHYSICS_MODEL, type MissionPlan, type TrajectoryEvent } from './mission-layer';
import { addNode } from './nodes';
import { parsePlanHash, parseSavedEditor, planHash, serializeEditor, versionNotice } from './share';

const FP = 'abcdef01';
const plan: MissionPlan = addNode(
  makePlan({ data: FP, epoch: 852_000_000.123456789, duration: 7 * 86400, rtol: 1e-10, start: { kind: 'launch', site: 'kourou', params: [852_000_000.123456789, 62.766923275745306, 200e3, 540, 13.5, 0] }, spacecraft: { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] }, burns: [] }),
  { t: 3069.5, dv: [3167.2345678, 0.1, -0.3], frame: { kind: 'orbital', body: 'earth' }, engine: 0 },
).plan;

describe('share link', () => {
  it('round-trips a plan exactly (bit for bit) with its mission', () => {
    const h = planHash('lunar-flyby', plan)!;
    expect(h.startsWith('#m=lunar-flyby&p=')).toBe(true);
    const back = parsePlanHash(h, FP);
    expect(back.error).toBeNull();
    expect(back.mismatch).toBeNull();
    expect(back.missionId).toBe('lunar-flyby');
    expect(back.plan).toEqual(plan);
    expect(Object.is(back.plan!.burns[0].duration, plan.burns[0].duration)).toBe(true);
  });

  it('refuses to encode an invalid plan', () => {
    expect(planHash('sandbox', { ...plan, duration: -1 })).toBeNull();
  });

  it('reports malformed links clearly', () => {
    const bad = parsePlanHash('#m=sandbox&p=@@@', FP);
    expect(bad.plan).toBeNull();
    expect(bad.error).toMatch(/Could not load the shared plan: .*invalid character/);
    const truncated = parsePlanHash(`#p=${encodePlan(plan).slice(0, 40)}`, FP);
    expect(truncated.error).toMatch(/truncated|length|canonical/);
  });

  it('flags a plan from another physics build as a version mismatch (format errors are load errors)', () => {
    const other = parsePlanHash(planHash('sandbox', { ...plan, data: '00000000' })!, FP);
    expect(other.plan).not.toBeNull();
    expect(other.mismatch).toMatch(/version mismatch/);
    const model = parsePlanHash(planHash('sandbox', { ...plan, model: PHYSICS_MODEL + 1 })!, FP);
    expect(model.mismatch).toMatch(/physics model/);
    // A future plan format: the decoder refuses it.
    const enc = encodePlan(plan);
    const bytes = Uint8Array.from(atob(enc.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (enc.length % 4)) % 4)), (c) => c.charCodeAt(0));
    bytes[1] = 99;
    const future = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parsePlanHash(`#p=${future}`, FP).error).toMatch(/unsupported plan format 99/);
  });

  it('says a plan made under an older physics model (a link or saved work) was made for an older version', () => {
    const old = { ...plan, model: PHYSICS_MODEL - 1, data: '2cb83544' };
    const link = parsePlanHash(planHash('lunar-flyby', old)!, FP);
    expect(link.plan).not.toBeNull();
    expect(link.mismatch).toMatch(/^This link was made for an older version of the game \(physics model 1, data 2cb83544\)/);
    expect(link.mismatch).toMatch(/refused \(outcome: version mismatch\)/);
    expect(versionNotice(old, FP, 'saved')).toMatch(/^Your saved plan was made for an older version of the game/);
    expect(versionNotice({ ...plan, model: PHYSICS_MODEL + 1 }, FP, 'saved')).toMatch(/a newer version/);
    expect(versionNotice(plan, FP, 'saved')).toBeNull();
    // The editor's adopt button keys on this wording.
    expect(link.mismatch).toMatch(/physics model/);
  });

  it('view-only hashes are not errors', () => {
    expect(parsePlanHash('#t=2027-01-01&frame=bary', FP)).toEqual({ missionId: null, plan: null, error: null, mismatch: null });
  });

  it('local storage keeps even an invalid working plan', () => {
    const invalid = { ...plan, duration: -5 };
    const s = parseSavedEditor(serializeEditor('geo-from-leo', invalid, [{ t: 1, dv: [1, 2, 3], frame: { kind: 'inertial' }, engine: 0 }]))!;
    expect(s.plan).toEqual(invalid);
    expect(s.parked[0].dv).toEqual([1, 2, 3]);
    expect(parseSavedEditor('{nope')).toBeNull();
    expect(parseSavedEditor(JSON.stringify({ v: 2 }))).toBeNull();
  });
});

describe('time entry', () => {
  it('parses the formats players type and round-trips formatMet', () => {
    expect(parseDuration('3600')).toBe(3600);
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('2d 4h')).toBe(2 * 86400 + 4 * 3600);
    expect(parseDuration('01:30:00')).toBe(5400);
    expect(parseDuration('T+1d 02:00:00.5')).toBe(86400 + 7200.5);
    expect(parseDuration('-90s')).toBe(-90);
    expect(parseDuration('soon')).toBeNull();
    expect(formatMet(2879.96, 1)).toBe('T+00:48:00.0');
    for (const t of [0, 59.9, 3069.5, 86400 * 3 + 3723.4]) expect(parseDuration(formatMet(t, 1))).toBeCloseTo(t, 6);
  });
});

describe('event list', () => {
  const ev = (kind: TrajectoryEvent['kind'], body: string, t: number, distance: number): TrajectoryEvent => ({ kind, body, t, distance, altitude: distance - 1e6, speed: 1000, rel: [distance, 0, 0, 0, 1000, 0], mass: 1 });
  it('keeps extrema inside a body’s SOI, crossings, failures, and one closest approach per nearby body', () => {
    const soi = new Map([['earth', 9e8], ['moon', 6.6e7], ['jupiter', 4.8e10]]);
    const events = [
      ev('periapsis', 'earth', 1, 6.6e6),
      ev('periapsis', 'jupiter', 2, 6e11), // far: dropped
      ev('periapsis', 'moon', 3, 3e8), // outside SOI: candidate closest
      ev('periapsis', 'moon', 4, 2e8), // closer: wins
      ev('enter', 'moon', 5, 6.6e7),
      ev('impact', 'moon', 6, 1.7e6),
    ];
    const l = listEvents(events, soi);
    expect(l.map((x) => `${x.role}:${x.ev.kind}:${x.ev.body}`)).toEqual(['event:periapsis:earth', 'closest:periapsis:moon', 'event:enter:moon', 'event:impact:moon']);
    expect(l.at(-1)!.failure).toBe(true);
    // A minimum far outside the Moon's SOI is not an encounter unless the Moon is a target.
    expect(l[1].distant).toBe(true);
    expect(listEvents(events, soi, { targets: ['moon'] })[1].distant).toBe(false);
    // Reentry missions: atmosphere entry is not a failure.
    expect(listEvents([ev('atmosphere-entry', 'earth', 1, 6.5e6)], soi, { failureKinds: ['impact'] })[0].failure).toBe(false);
  });
});
