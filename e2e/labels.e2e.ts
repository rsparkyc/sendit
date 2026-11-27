/**
 * Map label management near a body (label-layout.ts): the solved
 * geostationary mission looking at Earth, and a lunar flyby looking at the
 * Moon, at desktop and phone sizes. Visible label texts never overlap each
 * other or sit on the globe; co-located markers collapse into one cluster
 * that expands on a tap and stays tappable. Screenshots go to
 * test-results/labels/ (LABELS_SHOTS=<dir> overrides; LABELS_NO_ASSERT=1
 * only takes the screenshots, for comparing with an older build).
 */
import { expect, test, type Page } from '@playwright/test';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = process.env.LABELS_SHOTS ?? 'test-results/labels';
const ASSERT = !process.env.LABELS_NO_ASSERT;

test.skip(({ browserName }) => browserName !== 'chromium', 'screenshots in Chromium');

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function frames(page: Page, k = 4): Promise<void> {
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction(([n, kk]) => (window as any).sendit.renders() >= n + kk, [n0, k] as const);
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

/** Visible label text boxes and the screen disc of a body. */
async function geometry(page: Page, body: string) {
  return page.evaluate((b) => {
    const w = (window as any).sendit;
    const boxes = [...document.querySelectorAll<HTMLElement>('#labels .label .text')]
      .filter((e) => e.offsetParent !== null && e.style.display !== 'none' && (e.textContent ?? '').length > 0 && !e.closest('.label')!.classList.contains('occluded') && getComputedStyle(e.closest('.label')!).display !== 'none')
      .map((e) => { const r = e.getBoundingClientRect(); const pad = document.documentElement.classList.contains('touch') ? 8 : 0; return { text: e.textContent, x0: r.left + pad, y0: r.top + pad, x1: r.right - pad, y1: r.bottom - pad, body: /^\d+$/.test(e.closest<HTMLElement>('.label')!.dataset.key ?? '') }; });
    const disc = w.bodyDisc ? w.bodyDisc(b) : null;
    return { boxes, disc };
  }, body);
}

async function check(page: Page, body: string, name: string): Promise<void> {
  await frames(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  if (!ASSERT) return;
  const { boxes, disc } = await geometry(page, body);
  expect(boxes.length, 'some labels shown').toBeGreaterThan(0);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      const ov = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) > 1 && Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0) > 1;
      expect(ov, `"${a.text}" overlaps "${c.text}"`).toBe(false);
    }
  if (disc && disc.r > 8) {
    for (const b of boxes) {
      if (b.body) continue;
      const cx = Math.max(b.x0, Math.min(disc.x, b.x1)), cy = Math.max(b.y0, Math.min(disc.y, b.y1));
      expect(Math.hypot(cx - disc.x, cy - disc.y), `"${b.text}" on the globe`).toBeGreaterThanOrEqual(disc.r - 1);
    }
  }
}

for (const [size, vp] of [['desktop', { width: 1280, height: 720 }], ['phone', { width: 390, height: 844 }]] as const) {
  test.describe(size, () => {
    // Set up at desktop size (the editor's fields are all on screen), then resize to the size under test.
    test.use({ viewport: { width: 1280, height: 720 } });

    test(`geostationary mission after its solve, near Earth (${size})`, async ({ page }) => {
      await fresh(page, 'geo-from-leo');
      await solveGeo(page);
      await page.evaluate(() => {
        const w = (window as any).sendit;
        const s = w.store.get();
        w.store.set({ focus: -1, t: s.plan.epoch + 2040, paused: true, loadingTarget: s.plan.epoch + 2040 });
        w.camera.setDistance(4e7, true);
        w.camera.elevation = 1.25; // from above the orbit plane, so the departure's markers are in front of the globe
      });
      await page.setViewportSize(vp);
      await settled(page);
      await check(page, 'earth', `geo-${size}`);
      if (!ASSERT) return;
      // A cluster, if any, expands on a tap and its members become visible.
      const cl = page.locator('.label.cluster').first();
      if (await cl.count()) {
        const key = await cl.getAttribute('data-key');
        // The tap path (map tap or label tap -> labelPick): the first tap on a cluster expands it.
        await page.evaluate((k) => (window as any).sendit.pickLabel(k), key);
        await frames(page);
        await expect(page.locator(`.label[data-key="${key}"]`)).not.toHaveClass(/cluster/);
        await page.screenshot({ path: `${SHOTS}/geo-${size}-cluster-expanded.png` });
      }
    });

    test(`lunar flyby near the Moon (${size})`, async ({ page }) => {
      await fresh(page, 'lunar-flyby');
      await page.evaluate(() => {
        const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
        (window as any).sendit.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
      });
      await settled(page);
      await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 3019.5, paused: true }); });
      await page.getByRole('button', { name: '+ Node at cursor' }).click();
      for (const [sel, v] of [['input.met-input', '3019.5'], ['input[title="Prograde delta-v, m/s"]', '3155.2']]) {
        const i = page.locator(sel).first();
        await i.fill(v);
        await i.press('Enter');
      }
      await settled(page);
      await page.evaluate(() => {
        const w = (window as any).sendit;
        const s = w.store.get();
        const e = s.replay.result.events.find((x: any) => x.body === 'moon' && x.kind === 'periapsis');
        w.store.set({ frame: { kind: 'inertial', center: w.bodies.indexOf('moon') }, focus: w.bodies.indexOf('moon'), t: e.t, paused: true, loadingTarget: e.t });
        w.camera.setDistance(4e7, true);
      });
      await page.setViewportSize(vp);
      await settled(page);
      await check(page, 'moon', `lunar-${size}`);
    });
  });
}
