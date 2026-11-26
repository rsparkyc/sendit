import { describe, expect, it } from 'vitest';
import { axisLabel, axisStep, clampWindow, cluster, MIN_WINDOW, niceStep, zoomWindow } from './timeline';
import { drawnEnd } from './view-settings';

describe('timeline math', () => {
  it('picks nice steps that change unit with zoom', () => {
    expect(niceStep(10 * 86400, 10)).toBe(86400);
    expect(niceStep(6 * 60, 8)).toBe(60);
    expect(niceStep(30, 8)).toBe(5);
    expect(axisLabel(3 * 86400, 86400)).toBe('3d');
    expect(axisLabel(86400 + 5 * 3600, 3600)).toBe('1d 5h');
    expect(axisLabel(2 * 3600 + 7 * 60, 60)).toBe('2:07');
    expect(axisLabel(3019, 1)).toBe('50:19');
  });
  it('zooms about a time and clamps to the flight', () => {
    const [w0, w1] = zoomWindow(0, 1000, 250, 0.5, 0, 1000);
    expect(w1 - w0).toBe(500);
    expect(w0).toBe(125); // 250 stays at a quarter of the window
    expect(zoomWindow(0, 100, 50, 1e-6, 0, 1000)[1] - zoomWindow(0, 100, 50, 1e-6, 0, 1000)[0]).toBe(MIN_WINDOW);
    expect(zoomWindow(0, 1000, 500, 10, 0, 1000)).toEqual([0, 1000]);
    expect(clampWindow(900, 1100, 0, 1000)).toEqual([800, 1000]);
  });
  it('axis labels never crowd: long flights get coarse steps', () => {
    for (const [span, W] of [[2 * 365.25 * 86400, 360], [30 * 86400, 300], [10 * 86400, 1200], [3 * 3600, 360], [400 * 86400, 800]]) {
      const st = axisStep(0, span, 0, W);
      let longest = 0;
      for (let m = 0; m <= span; m += st) longest = Math.max(longest, axisLabel(m, st).length);
      expect((W * st) / span).toBeGreaterThanOrEqual(longest * 7 + 16);
    }
    expect(axisStep(0, 3 * 86400, 0, 300)).toBeGreaterThanOrEqual(86400 / 2);
  });
  it('clusters close ticks', () => {
    const g = cluster([{ x: 10 }, { x: 12 }, { x: 40 }, { x: 13 }], 5);
    expect(g.map((x) => x.length)).toEqual([3, 1]);
  });
});

describe('drawn span after the last burn', () => {
  const P = 5400;
  it('auto: an orbit draws three revolutions with a faint rest, an escape draws to the end', () => {
    expect(drawnEnd({ span: 'auto', spanDays: 1 }, 1000, P, 1e6)).toEqual({ t: 1000 + 3 * P, faintRest: true });
    expect(drawnEnd({ span: 'auto', spanDays: 1 }, 1000, NaN, 1e6)).toEqual({ t: 1e6, faintRest: false });
  });
  it('presets', () => {
    expect(drawnEnd({ span: 'rev1', spanDays: 1 }, 1000, P, 1e6).t).toBe(1000 + P);
    expect(drawnEnd({ span: 'time', spanDays: 2 }, 1000, P, 1e6).t).toBe(1000 + 2 * 86400);
    expect(drawnEnd({ span: 'all', spanDays: 2 }, 1000, P, 1e6).t).toBe(1e6);
    expect(drawnEnd({ span: 'rev3', spanDays: 2 }, 1000, P, 2000).t).toBe(2000);
  });
});

import { convertText, setDistanceMode } from './units';
describe('distance text conversion', () => {
  it('rewrites mission-layer distances and times into the chosen convention', () => {
    setDistanceMode('alt');
    expect(convertText('held 3 revolutions (rp 42158 km, ra 42164 km)', 'earth')).toBe('held 3 revolutions (rp 35,787 km alt, ra 35,793 km alt)');
    expect(convertText('took 252011 of 604800 s', null)).toBe('took 2.92 of 7.0 days');
    setDistanceMode('radius');
    expect(convertText('closest approach 1801.0 km altitude', 'moon')).toMatch(/km radius$/);
    setDistanceMode('alt');
  });
});
