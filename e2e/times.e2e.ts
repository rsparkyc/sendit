/**
 * Time-display audit by rendering (as distances.e2e.ts is for distances).
 * Loads several states at desktop and phone sizes, collects every visible
 * text (panels, the status bar, map labels, the timeline, the transfer
 * planner, hover and pinned trajectory readouts) in each time-display mode
 * (MET, UTC, TDB), and fails on any clock time or date that does not match
 * the active mode. Documented exceptions:
 *  - the transfer planner works in calendar dates: its dates stay absolute
 *    (UTC, or TDB in TDB mode) and, with a time of day, carry the mission
 *    elapsed time alongside ("… UTC · T+…"); plain day dates (porkchop axes,
 *    range fields) are allowed;
 *  - the "other mode" reference lines (data-time-other: the status bar's
 *    second line and the Time panel's calendar lines) and tooltips, which
 *    show the same instant in the other form on purpose.
 * It also checks that switching the mode changes them all together: the same
 * number of time-bearing texts in every mode, none left in the old form.
 * Screenshots go to test-results/times/.
 */
import { expect, test, type Page } from '@playwright/test';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/times';

test.skip(({ browserName }) => browserName !== 'chromium', 'audit runs in Chromium');

const SIZES = { desktop: { width: 1280, height: 720 }, phone: { width: 390, height: 844 } } as const;
type Mode = 'met' | 'utc' | 'tdb';

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page, mission: string): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.evaluate((m) => (window as any).sendit.editor.selectMission(m), mission);
  await settled(page);
}

async function setMode(page: Page, m: Mode): Promise<void> {
  const want = { met: 'MET', utc: 'UTC', tdb: 'TDB' }[m];
  for (let k = 0; k < 4; k++) {
    const txt = (await page.locator('.scrub-met').textContent()) ?? '';
    if (m === 'met' ? /^T[+−]/.test(txt.trim()) : txt.includes(want)) return;
    await page.evaluate(() => (document.querySelector('.scrub-met') as HTMLElement).click());
    await page.waitForTimeout(200);
  }
  throw new Error(`could not switch to ${m}`);
}

/** Hover and pin the drawn trajectory near mission time tm: the readouts' text. */
async function trajectoryReadouts(page: Page, tm: number): Promise<string[]> {
  const out: string[] = [];
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction((n) => (window as any).sendit.renders() >= n + 3, n0, { timeout: 15_000 }).catch(() => {});
  const p = await page.evaluate((t0) => {
    const w = (window as any).sendit;
    for (let k = 0; k < 40; k++) for (const t of [t0 + 120 * k, t0 - 120 * k]) {
      const q = w.screenAt(t, true);
      if (q && q.x > 40 && q.y > 40 && q.x < innerWidth - 40 && q.y < innerHeight - 40 && !document.elementFromPoint(q.x, q.y)?.closest('.panel, .dock, .sheet, .label, .tb, .timeline')) return q;
    }
    return null;
  }, tm);
  if (!p) return out;
  await page.mouse.move(p.x + 200, p.y + 200);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  const hover = page.locator('.hover-read');
  await hover.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await hover.isVisible()) out.push(`[hover] ${await hover.innerText()}`);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  const pop = page.locator('.tap-pop');
  if (await pop.isVisible()) out.push(`[pinned] ${await pop.innerText()}`);
  await page.keyboard.press('Escape');
  return out;
}

interface Text { s: string; where: 'ui' | 'planner' | 'other' }

/** Visible text, per row (label and value together). */
async function collect(page: Page): Promise<Text[]> {
  return page.evaluate(() => {
    const rows = new Map<Element, 'ui' | 'planner' | 'other'>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || ['SCRIPT', 'STYLE', 'OPTION'].includes(p.tagName) || !(n.nodeValue ?? '').trim()) continue;
      if (!p.checkVisibility({ opacityProperty: false, visibilityProperty: true })) continue;
      if (p.closest('.leaderboard, .lb')) continue; // submission dates of leaderboard entries: not mission times
      const where = p.closest('[data-time-other]') ? 'other' : p.closest('.planner') ? 'planner' : 'ui';
      rows.set(p.closest('.kv, tr, li, .event-row, .obj, label, .label, .row, .hint, .node-row, .sep-row') ?? p, where);
    }
    const join = (e: Element) => {
      const parts: string[] = [];
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue ?? '');
      return parts.join(' ').replace(/\s+/g, ' ');
    };
    return [...rows].map(([e, where]) => ({ s: join(e), where }));
  });
}

const MET = /T[+−-](?:\d+d )?\d{2}:\d{2}:\d{2}(?:\.\d+)?/g;
const ABS = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?: ?(UTC\*?|TDB))?/g;

/** Texts with a time that does not match the mode, and the number of time-bearing texts. */
function violations(texts: Text[], m: Mode): { bad: string[]; count: number; with: string[] } {
  const bad: string[] = [];
  const withTime: string[] = [];
  let count = 0;
  for (const { s, where } of texts) {
    if (where === 'other') continue;
    const mets = [...s.matchAll(MET)];
    const abss = [...s.matchAll(ABS)];
    if (mets.length || abss.length) { count++; withTime.push(s.slice(0, 120)); }
    for (const a of abss) {
      const withClock = /\d{2}:\d{2}/.test(a[0]);
      if (where === 'planner') {
        // Planner: absolute in every mode; a time of day carries its scale and MET alongside.
        if (!withClock) continue;
        const scale = a[1] ?? '';
        const next = s.slice(a.index! + a[0].length, a.index! + a[0].length + 4);
        if ((m === 'tdb' ? scale !== 'TDB' : !scale.startsWith('UTC')) || !/^ · T/.test(next)) bad.push(`[planner] ${s}`);
        continue;
      }
      if (m === 'met') bad.push(`[absolute in MET mode] ${s}`);
      else if (!withClock) bad.push(`[date without a clock] ${s}`);
      else if (m === 'utc' && !(a[1] ?? '').startsWith('UTC') && !/before 1972/.test(s)) bad.push(`[not UTC] ${s}`);
      else if (m === 'tdb' && a[1] !== 'TDB') bad.push(`[not TDB] ${s}`);
    }
    if (m !== 'met' && where === 'ui') for (const x of mets) {
      // A planner-style "date · T+…" pair outside the planner is not allowed either; bare MET is wrong in absolute modes.
      bad.push(`[MET in ${m} mode] ${s.slice(Math.max(0, x.index! - 40), x.index! + 40)}`);
    }
  }
  return { bad: [...new Set(bad)], count, with: withTime };
}

async function audit(page: Page, name: string, tm: number): Promise<void> {
  const counts: Record<string, number> = {};
  const state = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return { t: s.t, selectedNode: s.selectedNode, selectedEvent: s.selectedEvent, selectedSeparation: s.selectedSeparation, paused: true }; });
  for (const [size, vp] of Object.entries(SIZES)) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    for (const m of ['met', 'utc', 'tdb'] as Mode[]) {
      // The same state in every mode (picking a trajectory point moves the cursor; Escape drops a selection).
      await page.evaluate((st) => (window as any).sendit.store.set(st), state);
      await setMode(page, m);
      await page.waitForTimeout(300);
      const texts = await collect(page);
      const uiCount = violations(texts, m).count;
      for (const r of await trajectoryReadouts(page, tm)) texts.push({ s: r, where: 'ui' });
      // The planner (open over the map), its transfer tab.
      await page.evaluate(() => (window as any).sendit.planner.open?.());
      await page.waitForTimeout(300);
      texts.push(...(await collect(page)).filter((t) => t.where === 'planner'));
      await page.screenshot({ path: `${SHOTS}/${name}-${size}-${m}-planner.png` });
      await page.evaluate(() => (window as any).sendit.planner.close?.());
      await page.screenshot({ path: `${SHOTS}/${name}-${size}-${m}.png` });
      const v = violations(texts, m);
      console.log(`${name} ${size} ${m}: ${v.count} time-bearing texts${process.env.TIMES_DEBUG ? `\n  ${v.with.join('\n  ')}` : ''}`);
      expect(v.bad, `${name} ${size} ${m}`).toEqual([]);
      counts[`${size}-${m}`] = uiCount;
    }
    // Toggling changes them all together: the same set of time-bearing texts in every mode.
    expect(counts[`${size}-utc`], `${name} ${size}`).toBe(counts[`${size}-met`]);
    expect(counts[`${size}-tdb`], `${name} ${size}`).toBe(counts[`${size}-met`]);
  }
  await setMode(page, 'met');
}

test('pure formatter rules: the audit flags wrong forms', () => {
  expect(violations([{ s: 'Ended 2027-01-10 12:00:00 TDB', where: 'ui' }], 'met').bad).toHaveLength(1);
  expect(violations([{ s: 'Ended T+1d 00:00:00', where: 'ui' }], 'utc').bad).toHaveLength(1);
  expect(violations([{ s: 'Ended 2027-01-10 12:00:00 UTC', where: 'ui' }], 'utc').bad).toHaveLength(0);
  expect(violations([{ s: 'at 2027-01-10 12:00 UTC · T+00:34:00', where: 'planner' }], 'met').bad).toHaveLength(0);
  expect(violations([{ s: 'at 2027-01-10 12:00 TDB', where: 'planner' }], 'met').bad).toHaveLength(1);
});

test('geostationary mission, solved: every point in time follows the time-display setting', async ({ page }) => {
  test.setTimeout(400_000);
  await fresh(page, 'geo-from-leo');
  await page.setViewportSize(SIZES.desktop);
  await solveGeo(page);
  await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 2400, paused: true }); w.camera.setDistance(4e7, true); });
  await page.waitForTimeout(400);
  await audit(page, 'geo', 2400);
});

test('lunar flyby: every point in time follows the time-display setting', async ({ page }) => {
  test.setTimeout(400_000);
  await fresh(page, 'lunar-flyby');
  await page.setViewportSize(SIZES.desktop);
  await page.evaluate(() => {
    const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
    (window as any).sendit.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
  });
  await settled(page);
  await page.evaluate(() => (window as any).sendit.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3155.2, 0, 0]));
  await settled(page);
  await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 3 * 86400, paused: true }); w.camera.setDistance(4e8, true); });
  await page.waitForTimeout(400);
  await audit(page, 'lunar', 3 * 86400);
});
