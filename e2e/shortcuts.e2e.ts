/**
 * Keyboard shortcuts and the "Shortcuts and gestures" dialog, plus the
 * timeline marks' tooltips:
 *  - J / K hold and tap move the time cursor at the warp rate; Shift+J / K
 *    step the warp like « / »; keys do nothing while typing; blur releases.
 *  - The dialog fits the viewport at five sizes and scrolls internally to its
 *    last row; Escape closes it and focus returns to the "?" button; every
 *    bound key is listed (from the same table that drives the handling).
 *  - Timeline marks: hover shows words and time; a click moves the cursor;
 *    the scrubber still drags with marks present.
 * Screenshots go to test-results/shortcuts/.
 */
import { expect, test, type Page } from '@playwright/test';
import { BINDINGS, comboCap } from '../src/app/shortcuts';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/shortcuts';

test.skip(({ browserName }) => browserName !== 'chromium', 'UI checks run in Chromium');

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
}

const T = (page: Page) => page.evaluate(() => { const s = (window as any).sendit.store.get(); return s.loadingTarget ?? s.t; });
const rate = (page: Page) => page.evaluate(() => { const s = (window as any).sendit.store.get(); return s.warpIndex; });
/** Put the cursor mid-flight so neither end clamps. */
async function middle(page: Page): Promise<void> {
  await page.evaluate(() => { const st = (window as any).sendit.store; const p = st.get().plan; const t = p.epoch + p.duration / 2; st.set({ t, paused: true, loadingTarget: t }); });
  await settled(page);
}

test.describe('J / K time keys', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('hold, tap, warp steps, typing guard, blur release', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await fresh(page);
    await middle(page);
    await page.locator('#view').hover();
    const warpRate = async () => page.evaluate(async () => { const s = (window as any).sendit.store.get(); return s.warpIndex; });
    // Rate: measure what one second of playback gives at this warp (the same rate J / K use).
    const r = await page.evaluate(async () => {
      const st = (window as any).sendit.store;
      const t0 = st.get().t;
      st.set({ paused: false });
      const a = performance.now();
      await new Promise((res) => setTimeout(res, 500));
      st.set({ paused: true });
      const dt = (performance.now() - a) / 1000;
      const t1 = st.get().loadingTarget ?? st.get().t;
      st.set({ t: t0, loadingTarget: t0 });
      return (t1 - t0) / dt;
    });
    await settled(page);
    expect(r).toBeGreaterThan(0);

    // Hold, measured rather than assumed: on a slow runner the key is held longer than the waitForTimeout, so the
    // page records when it saw keydown and keyup and the distance is compared with rate × that held time. Slack:
    // a frame or two of latency at each end (the last frame before keyup may not have run), and r's own error.
    await page.evaluate(() => {
      const w = window as any;
      w.__keyAt = {};
      addEventListener('keydown', (e) => { if (!e.repeat) w.__keyAt[`down-${e.key}`] = performance.now(); }, true);
      addEventListener('keyup', (e) => { w.__keyAt[`up-${e.key}`] = performance.now(); }, true);
    });
    const hold = async (key: string, ms: number) => {
      const t0 = await T(page);
      await page.keyboard.down(key);
      await page.waitForTimeout(ms);
      await page.keyboard.up(key);
      const d = (await T(page)) - t0;
      const held = await page.evaluate((k) => { const a = (window as any).__keyAt; return (a[`up-${k}`] - a[`down-${k}`]) / 1000; }, key);
      return { d, held };
    };
    const SLACK = 0.1; // real seconds: about two frames at 30 fps at each end together, plus timer granularity
    const near = (d: number, held: number, what: string) => {
      const lo = r * Math.max(0.1, held - SLACK) * 0.85;
      const hi = r * Math.max(0.1, held + SLACK) * 1.15;
      expect(Math.abs(d), `${what}: moved ${d.toFixed(1)} s in ${held.toFixed(3)} s held at ${r.toFixed(1)} s/s; expected ${lo.toFixed(1)} … ${hi.toFixed(1)}`).toBeGreaterThan(lo);
      expect(Math.abs(d), `${what}: moved ${d.toFixed(1)} s in ${held.toFixed(3)} s held at ${r.toFixed(1)} s/s; expected ${lo.toFixed(1)} … ${hi.toFixed(1)}`).toBeLessThan(hi);
    };
    // Hold K ~1 s: forward by rate × held.
    let h = await hold('k', 1000);
    console.log(`hold K: ${h.d.toFixed(0)} s in ${h.held.toFixed(3)} s held at ${r.toFixed(0)} s/s`);
    expect(h.d).toBeGreaterThan(0);
    near(h.d, h.held, 'hold K');
    // Hold J: back.
    h = await hold('j', 1000);
    expect(h.d).toBeLessThan(0);
    near(h.d, h.held, 'hold J');
    // Tap: at least a tenth of a second's worth (the top-up), more only if the press itself lasted longer.
    let t0 = await T(page);
    await page.keyboard.press('k');
    let d = (await T(page)) - t0;
    const tapHeld = await page.evaluate(() => { const a = (window as any).__keyAt; return (a['up-k'] - a['down-k']) / 1000; });
    expect(d).toBeGreaterThan(r * 0.09);
    expect(d, `tap: moved ${d.toFixed(1)} s, press lasted ${tapHeld.toFixed(3)} s`).toBeLessThan(r * Math.max(0.1, tapHeld + SLACK) * 1.15 + r * 0.1);
    // Playing when K is pressed: playback pauses and stays paused.
    await page.evaluate(() => (window as any).sendit.store.set({ paused: false }));
    await page.keyboard.press('k');
    expect(await page.evaluate(() => (window as any).sendit.store.get().paused)).toBe(true);

    // Shift+K / Shift+J step the warp exactly as » / «.
    const warp = page.locator('.tb-clock .warp');
    const w0 = await warp.textContent();
    const i0 = await warpRate();
    await page.keyboard.press('Shift+K');
    const wUp = await warp.textContent();
    expect(await warpRate()).toBe(i0 + 1);
    await page.getByRole('button', { name: 'Slower time warp' }).click();
    expect(await warp.textContent()).toBe(w0);
    await page.getByRole('button', { name: 'Faster time warp' }).click();
    expect(await warp.textContent()).toBe(wUp);
    await page.keyboard.press('Shift+J');
    expect(await warp.textContent()).toBe(w0);
    expect(await rate(page)).toBe(i0);
    await expect(page.getByRole('button', { name: 'Faster time warp' })).toHaveAttribute('title', /Shift\+K/);

    // Typing: J / K go to the field.
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.id = 'probe-input';
      i.style.cssText = 'position:fixed;left:400px;top:300px;z-index:99999';
      document.body.append(i);
      const c = document.createElement('div');
      c.id = 'probe-ce';
      c.contentEditable = 'true';
      c.textContent = 'x';
      c.style.cssText = 'position:fixed;left:400px;top:340px;z-index:99999;background:#fff;color:#000';
      document.body.append(c);
    });
    t0 = await T(page);
    const wi = await rate(page);
    await page.locator('#probe-input').focus();
    await page.keyboard.press('k');
    await page.keyboard.press('Shift+K');
    await page.locator('#probe-ce').focus();
    await page.keyboard.press('j');
    expect(await T(page)).toBe(t0);
    expect(await rate(page)).toBe(wi);
    await expect(page.locator('#probe-input')).toHaveValue('kK');
    await page.evaluate(() => { document.getElementById('probe-input')!.remove(); document.getElementById('probe-ce')!.remove(); });

    // Window blur while K is held: motion stops even though keyup never comes.
    await page.locator('#view').hover();
    await page.keyboard.down('k');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const tb = await T(page);
    await page.waitForTimeout(500);
    expect(await T(page)).toBe(tb);
    await page.keyboard.up('k');
    expect(errors).toEqual([]);
  });
});

const SIZES = {
  'desktop-1440': { viewport: { width: 1440, height: 900 } },
  'desktop-1280': { viewport: { width: 1280, height: 720 } },
  'tablet-820': { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
  'phone-390': { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  'phone-landscape-844': { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
} as const;

for (const [name, opts] of Object.entries(SIZES)) {
  test.describe(`shortcuts dialog ${name}`, () => {
    test.use(opts);
    test('fits the viewport, scrolls to the last row, lists every bound key, closes', async ({ page }) => {
      await fresh(page);
      const help = page.locator('.tb-help');
      const viaButton = await help.isVisible();
      if (viaButton) await help.click();
      else await page.keyboard.press('Shift+Slash');
      const dlg = page.locator('dialog.keys');
      await expect(dlg).toBeVisible();
      const vp = page.viewportSize()!;
      const out = await dlg.evaluate((d, vp) => {
        const bad: string[] = [];
        const r = d.getBoundingClientRect();
        if (r.left < 0 || r.top < 0 || r.right > vp.width + 0.5 || r.bottom > vp.height + 0.5) bad.push(`dialog ${JSON.stringify(r)}`);
        const body = d.querySelector('.keys-body') as HTMLElement;
        if (body.scrollWidth > body.clientWidth + 1) bad.push(`horizontal overflow ${body.scrollWidth} > ${body.clientWidth}`);
        // Nothing sticks out sideways (vertical overflow is the internal scroll).
        for (const e of d.querySelectorAll('*')) {
          const b = e.getBoundingClientRect();
          if (b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5)) bad.push(`${e.tagName}.${e.className} ${b.left}-${b.right}`);
        }
        body.scrollTop = body.scrollHeight;
        return bad;
      }, vp);
      expect(out).toEqual([]);
      await page.waitForTimeout(50);
      const last = await dlg.evaluate((d) => {
        const body = d.querySelector('.keys-body') as HTMLElement;
        const rows = body.querySelectorAll('.krow');
        const lr = rows[rows.length - 1].getBoundingClientRect();
        const br = body.getBoundingClientRect();
        return { lastBottom: lr.bottom, bodyBottom: br.bottom, top: lr.top };
      });
      expect(last.lastBottom).toBeLessThanOrEqual(last.bodyBottom + 1);
      expect(last.top).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: `${SHOTS}/${name}-dialog-bottom.png` });
      // Every bound key is listed, in its binding's row.
      for (const b of BINDINGS) {
        const row = dlg.locator(`.krow[data-action="${b.id}"]`);
        await expect(row, b.id).toHaveCount(1);
        const caps = (await row.locator('kbd').allTextContents()).map((s) => s.toUpperCase());
        for (const cb of b.combos) expect(caps, `${b.id} ${comboCap(cb)}`).toContain(comboCap(cb).toUpperCase());
      }
      // Touch devices list touch gestures first.
      const order = await dlg.locator('.kblock h3').allTextContents();
      if (opts.hasTouch === true) expect(order[0]).toMatch(/touch/i);
      else expect(order[0]).toMatch(/keys/i);
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
      if (viaButton) await expect(help).toBeFocused();
    });
  });
}

test.describe('shortcuts dialog: close paths and focus trap', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('Close button and backdrop close it; Tab stays inside', async ({ page }) => {
    await fresh(page);
    const help = page.locator('.tb-help');
    const dlg = page.locator('dialog.keys');
    await help.click();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.keys'))).toBe(true);
    }
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(dlg).toBeHidden();
    await expect(help).toBeFocused();
    await help.click();
    await page.mouse.click(8, 400); // the backdrop, left of the dialog
    await expect(dlg).toBeHidden();
  });
});

test.describe('timeline marks', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('hover explains a mark, a click moves the cursor there, the scrubber still drags', async ({ page }) => {
    await fresh(page);
    // Lunar flyby with its departure burn: apsides and a closest approach on the timeline.
    await page.evaluate(() => (window as any).sendit.editor.selectMission('lunar-flyby'));
    await settled(page);
    await page.evaluate(() => {
      const w = (window as any).sendit;
      const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
      w.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
    });
    await settled(page);
    await page.evaluate(() => (window as any).sendit.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3155.2, 0, 0]));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: null }));
    const mark = page.locator('.scrub-ticks .tick.event:not(.many), .scrub-ticks .tick.closest:not(.many)').first();
    await expect(mark).toBeAttached({ timeout: 30_000 });
    const times = (await mark.getAttribute('data-times'))!.split(',').map(Number);
    await mark.hover();
    const tip = page.locator('.tl-tip');
    await expect(tip).toBeVisible();
    const text = (await tip.textContent()) ?? '';
    expect(text).toMatch(/Periapsis|Apoapsis|Closest approach|sphere of influence|atmosphere/);
    // Its time in the current time mode, as the timeline's own readout writes it.
    await page.evaluate(({ t }) => { const st = (window as any).sendit.store; st.set({ t, paused: true, loadingTarget: t }); }, { t: times[0] });
    await settled(page);
    const met = ((await page.locator('.scrub-met').textContent()) ?? '').replace(/ MET$/, '');
    expect(text).toContain(met);
    await mark.hover();
    await expect(tip).toBeVisible();
    const sb = (await page.locator('.scrubber').boundingBox())!;
    await page.screenshot({ path: `${SHOTS}/timeline-tip.png`, clip: { x: sb.x, y: Math.max(0, sb.y - 110), width: sb.width, height: sb.height + 110 } });
    // Move away, then click the mark: the cursor goes to it.
    await page.evaluate(() => { const st = (window as any).sendit.store; const p = st.get().plan; st.set({ t: p.epoch, loadingTarget: p.epoch }); });
    await settled(page);
    await page.locator('.scrub-ticks .tick.event:not(.many), .scrub-ticks .tick.closest:not(.many)').first().click();
    await settled(page);
    expect(await page.evaluate(() => (window as any).sendit.store.get().t)).toBeCloseTo(times[0], 3);
    // Drag along the scrubber (through the marks' strip and on the handle): time follows.
    const rb = (await page.locator('input.scrub').boundingBox())!;
    const y = rb.y + rb.height / 2;
    await page.mouse.move(rb.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.6, y, { steps: 8 });
    await page.mouse.up();
    await settled(page);
    const t = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return (s.t - s.plan.epoch) / ((Number.isFinite(s.replay.result.finalT) ? s.replay.result.finalT : s.plan.epoch + s.plan.duration) - s.plan.epoch); });
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(0.7);
    // A drag that starts on a mark scrubs too.
    const mb = (await page.locator('.scrub-ticks [data-tip]').first().boundingBox())!;
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.9, mb.y + mb.height / 2, { steps: 8 });
    await page.mouse.up();
    await settled(page);
    const t2 = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return (s.t - s.plan.epoch) / ((Number.isFinite(s.replay.result.finalT) ? s.replay.result.finalT : s.plan.epoch + s.plan.duration) - s.plan.epoch); });
    expect(t2).toBeGreaterThan(0.8);
  });
});

test.describe('timeline marks: separation marker', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('still drags with the marks clickable around it', async ({ page }) => {
    test.setTimeout(300_000);
    await fresh(page);
    await page.evaluate(() => (window as any).sendit.editor.selectMission('geo-from-leo'));
    await settled(page);
    await solveGeo(page);
    await expect(page.locator('.tick.sep')).toHaveCount(1);
    const before = await page.evaluate(() => (window as any).sendit.store.get().plan.separations[0].time);
    const tk = (await page.locator('.tick.sep').boundingBox())!;
    await page.mouse.move(tk.x + tk.width / 2, tk.y + tk.height / 2);
    await page.mouse.down();
    await page.mouse.move(tk.x + tk.width / 2 + 30, tk.y + tk.height / 2, { steps: 5 });
    await page.mouse.up();
    // As vehicles.e2e.ts checks it: the plan's separation time moved (one edit).
    expect(await page.evaluate(() => (window as any).sendit.store.get().plan.separations[0].time)).toBeGreaterThan(before);
  });
});
