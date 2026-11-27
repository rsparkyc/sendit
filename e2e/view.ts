/**
 * Shared e2e helpers for finding things on the 3D map without assuming a viewing direction.
 *
 * Body-centred frames are pole-up (frames.ts / orientation.ts), so a fixed camera azimuth / elevation does not
 * look at the trajectory from the same side in every frame or mission. Tests that need "a trajectory point I can
 * click" search for one instead: a few camera directions, a few candidate mission times, and a point counts only
 * if it is drawn (not behind a body), inside the canvas with a margin, and the canvas itself is the top element
 * there (a label's clickable text or a panel would take the click otherwise).
 */
import { expect, type Page } from '@playwright/test';

/** Wait until the app has drawn `k` more frames. */
export async function frames(page: Page, k = 2): Promise<void> {
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction(([n, kk]) => (window as any).sendit.renders() >= n + kk, [n0, k] as const, { timeout: 10_000 });
}

/** Wait until the camera has stopped moving (focus glides and zoom smoothing take seconds) and that view is drawn. */
export async function settleCamera(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).sendit.camera.settled(), undefined, { timeout: 30_000 });
  await frames(page);
}

export interface Spot { x: number; y: number; t: number; azimuth: number; elevation: number }

/** Camera directions tried in turn after the current one: from above and below the orbit plane, then edge-on-ish. */
const VIEWS: readonly [number, number][] = [
  [0, 1.2], [Math.PI, 1.2], [0, -1.2], [Math.PI, -1.2],
  [0, 0.6], [Math.PI / 2, 0.6], [Math.PI, 0.6], [(3 * Math.PI) / 2, 0.6],
  [0, -0.6], [Math.PI / 2, -0.6], [Math.PI, -0.6], [(3 * Math.PI) / 2, -0.6],
];

/**
 * A clickable trajectory point at one of `times` (mission seconds, in order of preference), trying the current camera
 * direction first and then the VIEWS. Leaves the camera at the direction found, settled. `margin` keeps the point
 * away from the canvas edges (px).
 */
export async function clickableTrajectoryPoint(page: Page, times: readonly number[], opts: { margin?: number } = {}): Promise<Spot> {
  const margin = opts.margin ?? 40;
  const tried: string[] = [];
  const views: ([number, number] | null)[] = [null, ...VIEWS];
  for (const v of views) {
    if (v) await page.evaluate(([a, e]) => { const c = (window as any).sendit.camera; c.azimuth = a; c.elevation = e; }, v);
    await settleCamera(page);
    const r = await page.evaluate(({ ts, m }) => {
      const w = (window as any).sendit;
      const canvas = document.getElementById('view')!;
      const b = canvas.getBoundingClientRect();
      const why: string[] = [];
      for (const t of ts) {
        const q = w.screenAt(t, true);
        if (!q) { why.push(`${t}: hidden`); continue; }
        if (q.x < b.left + m || q.x > b.right - m || q.y < b.top + m || q.y > b.bottom - m) { why.push(`${t}: off canvas (${Math.round(q.x)}, ${Math.round(q.y)})`); continue; }
        const top = document.elementFromPoint(q.x, q.y);
        if (top !== canvas) { why.push(`${t}: under ${top ? `${top.tagName}.${(top as HTMLElement).className}` : 'nothing'}`); continue; }
        return { spot: { x: q.x, y: q.y, t, azimuth: w.camera.azimuth, elevation: w.camera.elevation }, why: '' };
      }
      return { spot: null, why: `az ${w.camera.azimuth.toFixed(2)} el ${w.camera.elevation.toFixed(2)}: ${why.join('; ')}` };
    }, { ts: [...times], m: margin });
    if (r.spot) return r.spot;
    tried.push(r.why);
  }
  expect(null, `a clickable trajectory point at t = ${times.join(', ')} s; tried\n  ${tried.join('\n  ')}`).not.toBeNull();
  throw new Error('unreachable');
}
