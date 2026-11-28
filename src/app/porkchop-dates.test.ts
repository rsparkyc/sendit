import { describe, expect, it } from 'vitest';
import { BODIES } from './physics';
import { initialPlan, missionById } from './missions';
import { earliestDeparture, missionDeadline, suggestDates, transferBodies } from './porkchop-dates';
import { calendarToTdb, DAY } from './time';

const at = (y: number, m: number, d: number) => calendarToTdb({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 });

describe('porkchop default dates', () => {
  it('Earth to Mars from September 2026 brackets the late-2026 window', () => {
    const s = suggestDates(BODIES, 'earth', 'mars', at(2026, 9, 1))!;
    expect(s.window).not.toBeNull();
    // The real minimum-C3 departure is in October-November 2026.
    expect(s.window!).toBeGreaterThan(at(2026, 10, 1));
    expect(s.window!).toBeLessThan(at(2026, 12, 15));
    const [d0, d1, a0, a1] = s.range;
    expect(d0).toBeGreaterThanOrEqual(at(2026, 9, 1));
    expect(d0).toBeLessThan(s.window!);
    expect(d1).toBeGreaterThan(s.window!);
    expect(a0).toBeLessThan(s.window! + s.tof);
    expect(a1).toBeGreaterThan(s.window! + s.tof);
  });

  it('a closed window is skipped for the next one (sandbox launch in January 2027)', () => {
    const s = suggestDates(BODIES, 'earth', 'mars', at(2027, 1, 10))!;
    expect(s.window!).toBeGreaterThan(at(2028, 9, 1));
    expect(s.window!).toBeLessThan(at(2029, 2, 1));
  });

  it('moons stand for their planet; same planet gives nothing', () => {
    expect(suggestDates(BODIES, 'earth', 'moon', at(2027, 1, 1))).toBeNull();
    expect(suggestDates(BODIES, 'moon', 'io', at(2027, 1, 1))).not.toBeNull();
  });

  it('missions: bodies from the objectives, ranges from liftoff, arrivals by the time limit', () => {
    for (const [id, arr] of [['venus-flyby', 'venus'], ['mars-flyby', 'mars'], ['mars-orbit', 'mars'], ['venus-to-mercury', 'venus'], ['jupiter-saturn', 'jupiter']] as const) {
      const m = missionById(id)!;
      const plan = initialPlan(m, 'x');
      const tb = transferBodies(BODIES, m.def, plan);
      expect(tb).toEqual({ departure: 'earth', arrival: arr });
      const dl = missionDeadline(m.def, plan.epoch);
      expect(dl).toBeLessThanOrEqual(plan.epoch + m.def!.maxDuration);
      const s = suggestDates(BODIES, tb.departure!, tb.arrival!, plan.epoch, dl)!;
      expect(s.window, id).not.toBeNull();
      const [d0, d1, a0, a1] = s.range;
      expect(d0, id).toBeGreaterThanOrEqual(plan.epoch);
      expect(d1 - d0, id).toBeGreaterThanOrEqual(10 * DAY);
      expect(a1 - a0, id).toBeGreaterThanOrEqual(10 * DAY);
      expect(a1, id).toBeLessThanOrEqual(dl);
      expect(s.window! + s.tof, id).toBeLessThanOrEqual(dl);
    }
  });

  it('missions without a planetary target leave the arrival choice alone', () => {
    const m = missionById('lunar-orbit')!;
    expect(transferBodies(BODIES, m.def, initialPlan(m, 'x'))).toEqual({ departure: 'earth', arrival: null });
    expect(missionDeadline(null, 0)).toBe(Infinity);
  });

  it('earliest departure: the view time only when it is on a later date than liftoff', () => {
    const lift = at(2028, 3, 20) + 13 * 3600;
    // Same date (minutes or hours later): liftoff.
    expect(earliestDeparture(lift, lift + 600, Infinity)).toEqual({ t: lift, fromView: false });
    expect(earliestDeparture(lift, lift + 10 * 3600, Infinity)).toEqual({ t: lift, fromView: false });
    // Before liftoff: liftoff.
    expect(earliestDeparture(lift, lift - 5 * DAY, Infinity)).toEqual({ t: lift, fromView: false });
    // A later date, even less than a day later: the view time.
    const late = at(2028, 3, 20) + 23.5 * 3600;
    expect(earliestDeparture(late, late + 3600, Infinity)).toEqual({ t: late + 3600, fromView: true });
    expect(earliestDeparture(lift, lift + 30 * DAY, Infinity)).toEqual({ t: lift + 30 * DAY, fromView: true });
    // Past the mission's deadline: liftoff.
    expect(earliestDeparture(lift, lift + 30 * DAY, lift + 20 * DAY)).toEqual({ t: lift, fromView: false });
  });
});
