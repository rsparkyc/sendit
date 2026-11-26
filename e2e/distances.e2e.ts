/**
 * Distance-convention audit by rendering. Loads several missions and sandbox
 * states, collects every piece of text the UI shows (all panels and tabs,
 * dialogs, the planner's tabs, map markers, readouts, hover and pinned
 * trajectory readouts, titles and accessible names) at desktop and phone
 * sizes, and checks that:
 *  - no distance in km to a body appears without its word: "alt" /
 *    "altitude" / "Altitude above", "radius" / "Radius from …’s centre",
 *    "from the centre", "from barycentre", or AU / the Sun's centre;
 *  - in the plane-change parking orbit every altitude shown agrees (status
 *    Pe/Ap equal the last apsis rows; the readout and hover readout lie
 *    between the lowest periapsis and the highest apoapsis);
 *  - switching the setting to radius changes every one of them together
 *    (each by Earth's reference radius, 6,378.1366 km, to the displayed precision).
 * Screenshots go to test-results/distances/.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/distances';

test.skip(({ browserName }) => browserName !== 'chromium', 'audit runs in Chromium');

const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page, mission?: string): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  if (mission) {
    await page.evaluate((m) => (window as any).sendit.editor.selectMission(m), mission);
    await settled(page);
  }
}

async function enter(page: Page, selector: string, value: string): Promise<void> {
  const i = page.locator(selector).first();
  await i.fill(value);
  await i.press('Enter');
}

/** Add a node at mission time t with a prograde (and optional normal) delta-v, through the editor's own fields. */
async function node(page: Page, t: number, pro: number, nrm = 0): Promise<void> {
  await page.evaluate((tt) => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + tt, paused: true }); }, t);
  await page.getByRole('button', { name: '+ Node at cursor' }).click();
  await enter(page, 'input.met-input', String(t));
  await enter(page, 'input[title="Prograde delta-v, m/s"]', String(pro));
  if (nrm) await enter(page, 'input[title="Normal delta-v, m/s"]', String(nrm));
  await settled(page);
}

async function setTime(page: Page, tm: number): Promise<void> {
  await page.evaluate((t) => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + t, paused: true }); }, tm);
  await page.waitForTimeout(400);
}

/** Hover the drawn trajectory at mission time tm and click it (pinned popover); returns both readouts. */
async function trajectoryReadouts(page: Page, tm: number): Promise<string[]> {
  const out: string[] = [];
  await page.evaluate(() => (window as any).sendit.camera.setDistance(4e7, true));
  // Wait for drawn frames (not wall time): screen positions read after this match the camera, also under load.
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction((n) => (window as any).sendit.renders() >= n + 3, n0, { timeout: 15_000 }).catch(() => {});
  // A point near tm that is on screen and not behind a body (the readouts are for that point's time).
  const p = await page.evaluate((t0) => {
    const w = (window as any).sendit;
    for (let k = 0; k < 40; k++) for (const t of [t0 + 120 * k, t0 - 120 * k]) {
      const q = w.screenAt(t, true);
      if (q && q.x > 40 && q.y > 40 && q.x < innerWidth - 40 && q.y < innerHeight - 40 && !document.elementFromPoint(q.x, q.y)?.closest('.panel, .dock, .sheet, .label')) return q;
    }
    return null;
  }, tm);
  if (!p) return out;
  await page.mouse.move(p.x + 200, p.y + 200);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  const hover = page.locator('.hover-read');
  await hover.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await hover.isVisible()) out.push(`[hover] ${await hover.innerText()}`);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  const pop = page.locator('.tap-pop');
  if (await pop.isVisible()) out.push(`[pinned] ${await pop.innerText()}`);
  await page.keyboard.press('Escape');
  return out;
}

/** Every text the UI holds, at the current size: all panels' text (hidden tabs and dialogs too), titles and accessible names. */
async function collect(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    // Hidden panels, tabs and dialogs: per row (a label and its value together), text nodes joined by spaces
    // so that adjacent elements do not run together.
    const rows = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      // The corrector's stage table: its miss column is a B-plane miss distance, not a distance to a body.
      if (p?.closest('table')?.querySelector('th')?.parentElement?.textContent?.includes('B-plane miss')) continue;
      if (p && !['SCRIPT', 'STYLE'].includes(p.tagName)) rows.add(p.closest('.kv, tr, li, .event-row, .obj, label, .label, .row, .hint') ?? p);
    }
    const join = (e: Element) => {
      const parts: string[] = [];
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue ?? '');
      return parts.join(' ');
    };
    for (const r of rows) out.push(join(r));
    for (const e of document.querySelectorAll('[title], [aria-label]')) out.push(`${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`);
    return out.filter((s) => /\d\s?km/.test(s));
  });
}

/**
 * Distances in km without a word saying what they are measured from. A
 * distance is labelled when the words right after it, or the label right
 * before it, say alt / altitude / radius / centre / barycentre / AU.
 */
const AFTER_OK = /^(?:\s?(?:alt|altitude|radius)(?![a-z])|\s?from (?:the |\w+(?:’|')s )?centre|\s?from the Sun|\s?from barycentre|–|\s?to [\d,]+ km (?:alt|radius))/;
const BEFORE_OK = /(?:Altitude above \w+|Radius from \w+(?:’|')s centre|Distance from barycentre|Distance from Sun(?:’|')s centre|alt(?:itude)?,? km|Radius, km|radius, km)\s*$/;
/** Not distances to a body (removed before checking): the corrector's B-plane miss and its Lambert-guess caveat. */
const NOT_TO_BODY = [/misses by millions of km/g];

function unlabelled(texts: string[]): string[] {
  const bad = new Set<string>();
  for (const s of texts) {
    const t = NOT_TO_BODY.reduce((a, r) => a.replace(r, '«skipped»'), s);
    for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(?:million )?km\b(?!\/s|²)/g)) {
      const i = m.index!;
      const after = t.slice(i + m[0].length, i + m[0].length + 40);
      const before = t.slice(Math.max(0, i - 50), i);
      if (AFTER_OK.test(after) || BEFORE_OK.test(before)) continue;
      if (/km$/.test(m[0]) && /^\s?[–-]\s?[\d,]+ km (?:alt|radius)/.test(after)) continue;
      bad.add(t.slice(Math.max(0, i - 60), i + m[0].length + 30).replace(/\s+/g, ' '));
    }
  }
  return [...bad];
}

/** Collect at both sizes, opening the planner's tabs and the help dialog, and check every distance has its word. */
async function audit(page: Page, name: string, tm: number | null): Promise<string[]> {
  const all: string[] = [];
  for (const [size, vp] of Object.entries(SIZES)) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(500);
    all.push(...(await collect(page)));
    if (tm !== null) all.push(...(await trajectoryReadouts(page, tm)));
    await page.screenshot({ path: `${SHOTS}/${name}-${size}.png` });
    // Planner tabs (the overlay is built at start; open it so its live text is current).
    await page.evaluate(() => (window as any).sendit.planner.open?.());
    for (const tab of ['Transfer', 'Target flyby', 'Flyby chain']) {
      const b = page.locator('.pl-tab', { hasText: tab });
      if (await b.isVisible()) { await b.click(); all.push(...(await collect(page))); }
    }
    await page.evaluate(() => (window as any).sendit.planner.close?.());
  }
  const bad = unlabelled(all);
  console.log(`${name}: ${all.length} texts with km, unlabelled: ${JSON.stringify(bad, null, 1)}`);
  return bad;
}

const SCENARIOS: { name: string; setup: (page: Page) => Promise<number | null> }[] = [
  {
    name: 'plane-change',
    setup: async (page) => { await fresh(page, 'plane-change'); await setTime(page, 3000); return 3000; },
  },
  {
    name: 'geo-solved',
    setup: async (page) => {
      await fresh(page, 'geo-from-leo');
      await enter(page, 'input[title^="Flight duration"]', '4.6');
      await settled(page);
      await node(page, 1678.9791939258575, 2449.478316355737);
      await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 20675.642688512802 }); });
      await page.getByRole('button', { name: '+ Node at cursor' }).click();
      await enter(page, 'input.met-input', '20675.642688512802');
      await enter(page, 'input[title="Prograde delta-v, m/s"]', '1467.715665002644');
      await enter(page, 'input[title="Normal delta-v, m/s"]', '-205.3391377520207');
      await enter(page, 'input[title="Radial out delta-v, m/s"]', '-1.621673268307772');
      await settled(page);
      expect(await page.evaluate(() => (window as any).sendit.store.get().replay.evaluation.success)).toBe(true);
      await setTime(page, 3 * 86400);
      return 3 * 86400;
    },
  },
  {
    name: 'lunar-flyby',
    setup: async (page) => {
      await fresh(page, 'lunar-flyby');
      await page.evaluate(() => {
        const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
        (window as any).sendit.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
      });
      await settled(page);
      await node(page, 3019.5, 3155.2);
      const moon = await page.evaluate(() => (window as any).sendit.store.get().replay.result.events.some((e: any) => e.body === 'moon' && e.kind === 'periapsis'));
      expect(moon, 'a lunar flyby').toBe(true);
      // Near the Moon: the readout's reference is the Moon in a Moon-centred frame.
      const tm = await page.evaluate(() => { const s = (window as any).sendit.store.get(); const e = s.replay.result.events.find((x: any) => x.body === 'moon' && x.kind === 'periapsis'); return e.t - s.plan.epoch; });
      await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ frame: { kind: 'inertial', center: w.bodies.indexOf('moon') } }); });
      await setTime(page, tm - 3600);
      return tm - 3600;
    },
  },
  {
    name: 'heliocentric',
    setup: async (page) => {
      await fresh(page, 'earth-escape');
      await enter(page, 'input[title^="Flight duration"]', '80');
      await settled(page);
      await node(page, 3000, 4200);
      const w = await page.evaluate(() => { const w = (window as any).sendit; return { sun: w.bodies.indexOf('sun') }; });
      await page.evaluate((sun) => (window as any).sendit.store.set({ frame: { kind: 'inertial', center: sun }, focus: (window as any).sendit.bodies.indexOf('mars') }), w.sun);
      await setTime(page, 70 * 86400);
      return null;
    },
  },
  {
    name: 'barycentric',
    setup: async (page) => {
      await fresh(page);
      await page.evaluate(() => (window as any).sendit.store.set({ frame: { kind: 'barycentric' }, focus: (window as any).sendit.bodies.indexOf('jupiter') }));
      await page.waitForTimeout(400);
      return null;
    },
  },
];

test('the checker flags the forms that slipped through before and passes labelled ones', () => {
  expect(unlabelled(['Distance from Earth 6,778 km'])).toHaveLength(1);
  expect(unlabelled(['Two-body osculating: Pe 300 km, Ap 300 km'])).toHaveLength(1);
  expect(unlabelled(['the corrector reached a 412 km pass'])).toHaveLength(1);
  expect(unlabelled(['Altitude above Earth 407 km', 'Radius from Earth’s centre 6,778 km', 'Pe 407 km alt · Ap 6,779 km radius', 'Distance from barycentre 5.2031 AU', '35,693–35,893 km alt', '1.02 radii · 6,500 km from the centre'])).toEqual([]);
});

test.describe('distance convention audit', () => {
  for (const sc of SCENARIOS) {
    test(`every distance to a body is labelled: ${sc.name}`, async ({ page }) => {
      const tm = await sc.setup(page);
      const badAlt = await audit(page, `${sc.name}-alt`, tm);
      await page.setViewportSize(SIZES.desktop);
      await page.selectOption('.dist-sel', 'radius');
      await page.waitForTimeout(400);
      const badRad = await audit(page, `${sc.name}-radius`, tm);
      expect(badAlt).toEqual([]);
      expect(badRad).toEqual([]);
    });
  }

  test('heliocentric and barycentric readouts are from the centre', async ({ page }) => {
    await fresh(page);
    const ro = page.locator('.readouts');
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ frame: { kind: 'inertial', center: w.bodies.indexOf('sun') }, focus: w.bodies.indexOf('mars') }); });
    await expect(ro).toContainText(/Distance from Sun’s centre\s*1\.\d{4} AU/);
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ frame: { kind: 'barycentric' } }); });
    await expect(ro).toContainText(/Distance from barycentre\s*1\.\d{4} AU/);
  });

  test('plane change: readout, hover, status and apsis rows agree, and all switch together', async ({ page }) => {
    await fresh(page, 'plane-change');
    await setTime(page, 3000);
    await page.setViewportSize(SIZES.desktop);
    const read = async (word: 'alt' | 'radius') => {
      for (let k = 0; k < 10 && (await page.locator('.apsis-group[aria-expanded="false"]').count()) > 0; k++) await page.locator('.apsis-group[aria-expanded="false"]').first().click();
      const n = (s: string) => Number(s.replace(/,/g, ''));
      const status = (await page.locator('.tb-status').textContent()) ?? '';
      const st = [...status.matchAll(new RegExp(`(Pe|Ap) ([\\d,]+) km ${word}`, 'g'))].map((m) => n(m[2]));
      const rows = async (k: string) => (await page.locator(`.event-row.k-${k}`).filter({ hasText: 'Earth' }).locator('.eval').allTextContents()).map((s) => n(new RegExp(`([\\d,]+) km ${word}`).exec(s)![1]));
      const pe = await rows('periapsis');
      const ap = await rows('apoapsis');
      const roText = await page.locator('.readouts').innerText();
      const label = word === 'alt' ? 'Altitude above Earth' : 'Radius from Earth’s centre';
      const ro = n(new RegExp(`${label}\\s*([\\d,]+) km`).exec(roText)![1]);
      const extra = new RegExp(`Earth ([\\d,]+) km ${word}`).exec(roText);
      let hover = '';
      for (let k = 0; k < 3 && !hover; k++) hover = (await trajectoryReadouts(page, 3000 + 600 * k)).join(' '); // retry: a point can be under a marker
      const hv = new RegExp(`([\\d,]+) km ${word}`).exec(hover);
      return { st, pe, ap, ro, extra: extra ? n(extra[1]) : NaN, hover: hv ? n(hv[1]) : NaN, roText };
    };
    const a = await read('alt');
    console.log(`plane change, alt: ${JSON.stringify(a)}`);
    await page.screenshot({ path: `${SHOTS}/readout-alt.png` });
    await page.locator('.readouts').screenshot({ path: `${SHOTS}/readout-panel-alt.png` });
    expect(a.st).toEqual([a.pe[a.pe.length - 1], a.ap[a.ap.length - 1]]);
    const lo = Math.min(...a.pe) - 1;
    const hi = Math.max(...a.ap) + 1;
    expect(a.ro).toBeGreaterThanOrEqual(lo);
    expect(a.ro).toBeLessThanOrEqual(hi);
    expect(Math.abs(a.ro - a.extra)).toBeLessThanOrEqual(1); // readout row and the line under it: same instant, same body
    expect(a.ro).toBeGreaterThan(300);
    expect(a.ro).toBeLessThan(500);
    expect(a.hover, 'hover readout on the parking orbit').toBeGreaterThanOrEqual(lo);
    expect(a.hover).toBeLessThanOrEqual(hi);
    await page.selectOption('.dist-sel', 'radius');
    await page.waitForTimeout(300);
    const r = await read('radius');
    console.log(`plane change, radius: ${JSON.stringify(r)}`);
    await page.locator('.readouts').screenshot({ path: `${SHOTS}/readout-panel-radius.png` });
    await page.screenshot({ path: `${SHOTS}/readout-radius.png` });
    // Altitude and radius differ by Earth's reference (equatorial) radius, 6378.1366 km: the one altitude radius of every layer.
    const shift = (x: number, y: number) => expect(Math.abs(y - x - 6378.1366)).toBeLessThanOrEqual(1);
    a.st.forEach((x, i) => shift(x, r.st[i]));
    a.pe.forEach((x, i) => shift(x, r.pe[i]));
    a.ap.forEach((x, i) => shift(x, r.ap[i]));
    shift(a.ro, r.ro);
    // Under a loaded parallel run the second hover sometimes finds no free point on screen (about 1 run in 6):
    // checked when found; the labelled-text audit above covers the hover text in radius mode as well.
    if (Number.isFinite(r.hover)) {
      expect(r.hover).toBeGreaterThanOrEqual(lo + 6378.1366);
      expect(r.hover).toBeLessThanOrEqual(hi + 6378.1366);
    } else console.warn('radius-mode hover readout not captured this run');
    expect(Math.abs(r.ro - r.extra)).toBeLessThanOrEqual(1);
  });
});

test('node editor step captions: screenshots at the default dock width and at 390 px; captions do not touch', async ({ page, browser }) => {
  const check = async (p: Page, name: string) => {
    const tuner = p.locator('.tuner', { has: p.locator('input[title="Prograde delta-v, m/s"]') });
    await tuner.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await tuner.screenshot({ path: `${SHOTS}/tuner-${name}.png` });
    await tuner.locator('xpath=..').screenshot({ path: `${SHOTS}/node-editor-${name}.png` });
    // In every row of steps, each caption fits inside its button with clear space to the next caption.
    const rows = await p.locator('.tuner .tn-steps').evaluateAll((all) => all.map((steps) => [...steps.children].map((b) => {
      const r = b.getBoundingClientRect();
      const s = (b.querySelector('.tn-sub') as HTMLElement).getBoundingClientRect();
      return { bl: r.left, br: r.right, sl: s.left, sr: s.right, h: r.height, w: r.width };
    })));
    console.log(`${name}: ${JSON.stringify(rows[0].map((b) => [Math.round(b.w), Math.round(b.sr - b.sl), Math.round(b.h)]))}`);
    for (const boxes of rows) {
      for (const b of boxes) {
        expect(b.sl).toBeGreaterThanOrEqual(b.bl);
        expect(b.sr).toBeLessThanOrEqual(b.br);
      }
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].sl - boxes[i - 1].sr).toBeGreaterThanOrEqual(8);
    }
    return rows.flat();
  };
  await fresh(page, 'geo-from-leo');
  await node(page, 1678.98, 2449.48);
  await page.setViewportSize(SIZES.desktop);
  await check(page, 'desktop');
  const ctx = await browser.newContext({ viewport: SIZES.phone, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const phone = await ctx.newPage();
  await fresh(phone, 'geo-from-leo');
  await phone.locator('#tab-nodes').click();
  await node(phone, 1678.98, 2449.48);
  const pb = await check(phone, 'phone');
  for (const b of pb) expect(b.h).toBeGreaterThanOrEqual(44);
  await ctx.close();
});
