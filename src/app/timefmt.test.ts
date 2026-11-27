import { describe, expect, it } from 'vitest';
import { bothTimes, fmtTime, otherTime, parseTime } from './timefmt';
import { calendarToTdb } from './time';

const EP = calendarToTdb({ year: 2027, month: 1, day: 10, hour: 12, minute: 0, second: 0 });

describe('time display convention', () => {
  it('MET: round trip including negative times', () => {
    for (const t of [0, 3069.5, -600, 86400 * 3 + 3723]) {
      const s = fmtTime(t, 1, 'met', EP);
      expect(parseTime(s, 'met', EP)).toBeCloseTo(t, 6);
    }
    expect(fmtTime(-600, 0, 'met', EP)).toBe('T−00:10:00');
  });

  it('UTC: labelled, 69.184 s behind TDB in 2027, round trip (and typed MET still works)', () => {
    const s = fmtTime(3600, 0, 'utc', EP);
    expect(s).toMatch(/^2027-01-10 12:58:5\d UTC\*?$/);
    expect(Math.abs(parseTime(s, 'utc', EP)! - 3600)).toBeLessThan(1);
    expect(parseTime(fmtTime(3600.25, 2, 'utc', EP), 'utc', EP)).toBeCloseTo(3600.25, 1); // shown to the hundredth
    expect(parseTime('T+01:00:00', 'utc', EP)).toBe(3600);
    expect(parseTime('2027-01-10 13:00:00 TDB', 'utc', EP)).toBeCloseTo(3600, 6);
  });

  it('TDB: what the simulation uses; a free-orbit start counts from its own epoch', () => {
    const freeEpoch = EP + 12345.5;
    expect(fmtTime(0, 0, 'tdb', freeEpoch)).toBe('2027-01-10 15:25:46 TDB'); // rounded to the second shown
    expect(parseTime('2027-01-10 15:25:45', 'tdb', freeEpoch)).toBeCloseTo(-0.5, 6);
    expect(parseTime(fmtTime(-7200, 1, 'tdb', freeEpoch), 'tdb', freeEpoch)).toBeCloseTo(-7200, 6);
  });

  it('the other form is always available', () => {
    expect(otherTime(60, 'met', EP)).toMatch(/UTC/);
    expect(otherTime(60, 'utc', EP)).toBe('T+00:01:00 MET');
    expect(bothTimes(60, EP)).toMatch(/^T\+00:01:00 · 2027-01-10/);
  });
});
