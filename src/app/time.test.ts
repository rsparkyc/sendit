import { describe, expect, it } from 'vitest';
import { calendarToTdb, formatCalendar, formatRate, parseCalendar, taiMinusUtc, tdbToCalendar, utcIsPredicted, tdbToUtc, utcMsToTdb } from './time';

const cal = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => ({ year, month, day, hour, minute, second });

describe('time', () => {
  it('J2000 is 2000-01-01 12:00:00 TDB', () => {
    expect(tdbToCalendar(0)).toEqual(cal(2000, 1, 1, 12));
    expect(calendarToTdb(cal(2000, 1, 1, 12))).toBe(0);
  });

  it('matches Julian dates', () => {
    // JD 2460676.5 = 2025-01-01 00:00 -> (JD - 2451545) days from J2000.
    expect(calendarToTdb(cal(2025, 1, 1))).toBe((2460676.5 - 2451545) * 86400);
    // JD 2415020.5 = 1900-01-01 00:00 (before the Unix epoch, Gregorian).
    expect(calendarToTdb(cal(1900, 1, 1))).toBe((2415020.5 - 2451545) * 86400);
    // Leap day handling.
    expect(calendarToTdb(cal(2024, 3, 1)) - calendarToTdb(cal(2024, 2, 28))).toBe(2 * 86400);
    expect(calendarToTdb(cal(2100, 3, 1)) - calendarToTdb(cal(2100, 2, 28))).toBe(86400);
  });

  it('round-trips calendar <-> seconds including fractional seconds and far dates', () => {
    for (const t of [0, 1.5, -1e9, 8.123456e8, 3.15e9, -3.15e9]) {
      const c = tdbToCalendar(t);
      expect(calendarToTdb(c)).toBeCloseTo(t, 3);
    }
    expect(calendarToTdb(cal(50, 6, 1))).toBeLessThan(calendarToTdb(cal(100, 1, 1)));
  });

  it('leap seconds: TAI-UTC table', () => {
    expect(taiMinusUtc(Date.UTC(1971, 0, 1))).toBeNull();
    expect(taiMinusUtc(Date.UTC(1972, 0, 1))).toBe(10);
    expect(taiMinusUtc(Date.UTC(2016, 11, 31, 23, 59, 59))).toBe(36);
    expect(taiMinusUtc(Date.UTC(2017, 0, 1))).toBe(37);
    expect(taiMinusUtc(Date.UTC(2040, 0, 1))).toBe(37);
    expect(utcIsPredicted(calendarToTdb(cal(2040, 1, 1)))).toBe(true);
    expect(utcIsPredicted(calendarToTdb(cal(2020, 1, 1)))).toBe(false);
  });

  it('UTC = TDB - 32.184 s - (TAI-UTC)', () => {
    // 2020-01-01 00:00:00 UTC = 00:01:09.184 TT.
    const t = calendarToTdb(cal(2020, 1, 1, 0, 1, 9.184));
    const u = tdbToUtc(t)!;
    expect(u.year).toBe(2020);
    expect(u.hour).toBe(0);
    expect(u.minute).toBe(0);
    expect(u.second).toBeCloseTo(0, 6);
    // J2000 itself: 2000-01-01 11:58:55.816 UTC.
    const j = tdbToUtc(0)!;
    expect([j.hour, j.minute]).toEqual([11, 58]);
    expect(j.second).toBeCloseTo(55.816, 6);
    expect(tdbToUtc(calendarToTdb(cal(1960, 1, 1)))).toBeNull();
    // Across the 2016-12-31 leap second: 2017-01-01 00:00:00 UTC = 00:01:09.184 TT.
    const after = tdbToUtc(calendarToTdb(cal(2017, 1, 1, 0, 1, 9.184)))!;
    expect([after.year, after.month, after.day, after.hour, after.minute]).toEqual([2017, 1, 1, 0, 0]);
    expect(after.second).toBeCloseTo(0, 6);
    expect(utcMsToTdb(Date.UTC(2020, 0, 1))).toBeCloseTo(t, 6);
  });

  it('parses dates strictly', () => {
    expect(parseCalendar('2031-07-04')).toEqual(cal(2031, 7, 4));
    expect(parseCalendar('2031-07-04 13:05')).toEqual(cal(2031, 7, 4, 13, 5));
    expect(parseCalendar(' 2031-07-04T13:05:09.5 TDB ')).toEqual(cal(2031, 7, 4, 13, 5, 9.5));
    expect(parseCalendar('2031-02-30')).toBeNull();
    expect(parseCalendar('2031-13-01')).toBeNull();
    expect(parseCalendar('yesterday')).toBeNull();
  });

  it('formats', () => {
    expect(formatCalendar(cal(2027, 1, 10, 3, 4, 5.9))).toBe('2027-01-10 03:04:05');
    expect(formatCalendar(cal(2027, 1, 10, 3, 4, 5), false)).toBe('2027-01-10 03:04');
    expect(formatRate(1)).toBe('1 s/s');
    expect(formatRate(86400)).toBe('1 d/s');
    expect(formatRate(365.25 * 86400)).toBe('1 yr/s');
  });
});
