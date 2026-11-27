import { describe, expect, it } from 'vitest';
import { clampAzimuth, clampToIntervals, corridorIntervals, corridorLabel, inCorridor } from './launch-limits';

describe('clampToIntervals', () => {
  it('single interval: inside kept, outside to the nearest edge, edges exact', () => {
    const iv = [[35, 120]] as const;
    expect(clampToIntervals(60, iv)).toBe(60);
    expect(clampToIntervals(35, iv)).toBe(35);
    expect(clampToIntervals(120, iv)).toBe(120);
    expect(clampToIntervals(500, iv)).toBe(120);
    expect(clampToIntervals(-80, iv)).toBe(35);
  });
  it('multiple intervals: a drag stays on the side it came from, a click goes to the nearest', () => {
    const iv = [[0, 10], [20, 30]] as const;
    expect(clampToIntervals(19, iv)).toBe(20); // nearest
    expect(clampToIntervals(19, iv, 5)).toBe(10); // came from the left interval
    expect(clampToIntervals(11, iv, 25)).toBe(20); // came from the right interval
    expect(clampToIntervals(15, iv, 25)).toBe(20);
    expect(clampToIntervals(25, iv, 5)).toBe(25); // landed inside another: kept
    expect(clampToIntervals(40, iv, 5)).toBe(10);
  });
  it('no intervals: unchanged', () => expect(clampToIntervals(7, [])).toBe(7));
});

describe('clampAzimuth', () => {
  const cc = { azimuthMinDeg: 35, azimuthMaxDeg: 120 };
  const wrap = { azimuthMinDeg: -10.5, azimuthMaxDeg: 93.5 };
  it('inside kept; boundaries exact', () => {
    expect(clampAzimuth(cc, 80)).toBe(80);
    expect(clampAzimuth(cc, 35)).toBe(35);
    expect(clampAzimuth(cc, 120)).toBe(120);
    expect(clampAzimuth(cc, 120.0001)).toBe(120);
  });
  it('nearest edge round the circle', () => {
    expect(clampAzimuth(cc, 150)).toBe(120);
    expect(clampAzimuth(cc, 20)).toBe(35);
    expect(clampAzimuth(cc, 300)).toBe(35); // 95° to 35 clockwise, 180° back to 120
    expect(clampAzimuth(cc, 250)).toBe(120);
  });
  it('a step from inside stops on its side', () => {
    expect(clampAzimuth(cc, 121, 120)).toBe(120);
    expect(clampAzimuth(cc, 34, 35)).toBe(35);
    expect(clampAzimuth(cc, 300, 119)).toBe(35); // shortest turn from 119 to 300 is backwards
  });
  it('wrap through north (min negative)', () => {
    expect(inCorridor(wrap, 355)).toBe(true);
    expect(inCorridor(wrap, 349.5)).toBe(true);
    expect(inCorridor(wrap, 349)).toBe(false);
    expect(clampAzimuth(wrap, 355)).toBe(355);
    expect(clampAzimuth(wrap, 340)).toBe(349.5);
    expect(clampAzimuth(wrap, 100)).toBe(93.5);
    expect(clampAzimuth(wrap, 348, 351)).toBe(349.5);
    expect(clampAzimuth(wrap, -11)).toBe(349.5);
  });
  it('full circle allows everything', () => {
    expect(clampAzimuth({ azimuthMinDeg: 0, azimuthMaxDeg: 360 }, 200)).toBe(200);
  });
});

describe('corridorIntervals / label', () => {
  it('unwrapped chart intervals', () => {
    expect(corridorIntervals({ azimuthMinDeg: 35, azimuthMaxDeg: 120 }, 18, 137)).toEqual([[35, 120]]);
    expect(corridorIntervals({ azimuthMinDeg: 0, azimuthMaxDeg: 195 }, -39, 234)).toEqual([[0, 195]]);
    expect(corridorIntervals({ azimuthMinDeg: 0, azimuthMaxDeg: 195 }, -200, 400)).toEqual([[-360, -165], [0, 195], [360, 555]]);
    expect(corridorIntervals({ azimuthMinDeg: 0, azimuthMaxDeg: 360 }, 0, 10)).toEqual([]);
  });
  it('label', () => {
    expect(corridorLabel({ azimuthMinDeg: -10.5, azimuthMaxDeg: 93.5 })).toBe('349.5°–93.5°');
  });
});
