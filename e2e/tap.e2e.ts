/**
 * The tap layer (src/app/tap.ts installTapLayer) on one representative control per area, on a touch tablet
 * (Chromium, CDP touch input): a tap acts exactly once when the browser drops the tap's click, and exactly once
 * when the click arrives 1.5 s late; a vertical swipe that starts on a step button scrolls the panel and does
 * not activate it. floating.e2e.ts covers the onTap layout controls the same way.
 */
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { clickableTrajectoryPoint, frames } from './view';

const BASE = 'http://localhost:4173';

test.skip(({ browserName }) => browserName !== 'chromium', 'drives touch through CDP Input.dispatchTouchEvent');
test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: devices['iPad Mini'].userAgent });

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page): Promise<void> {
  // The leaderboard API is not served by the preview: answer 404 at once so probing is quick and quiet.
  await page.route('**/api/leaderboard/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
}

async function touch(page: Page, points: { x: number; y: number }[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...points[0], id: 1 }] });
  for (const p of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Show a side-column tab (tap it if not shown; reopen the column) and assert it. */
async function showSide(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.tap();
  const show = page.getByRole('button', { name: 'Show panels' });
  if (await show.isVisible()) await show.tap();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * The control's centre after scrolling it into view, checked to be the top element there (a panel or label over it
 * would take the tap), and a counter of the click events that reach it (the app's onclick handlers run on exactly
 * these: a swallowed click never reaches the target).
 */
async function aim(page: Page, loc: Locator): Promise<{ x: number; y: number }> {
  await loc.scrollIntoViewIfNeeded();
  await frames(page);
  const r = await loc.evaluate((e) => {
    const b = e.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const top = document.elementFromPoint(x, y);
    (window as any).__hits = 0;
    e.addEventListener('click', () => (window as any).__hits++);
    return { x, y, ok: !!top && e.contains(top), top: top ? `${top.tagName}.${(top as HTMLElement).className}` : 'nothing' };
  });
  expect(r.ok, `the control is not on top at its centre (${Math.round(r.x)}, ${Math.round(r.y)}): ${r.top} is`).toBe(true);
  return r;
}
const hits = (page: Page) => page.evaluate(() => (window as any).__hits as number);

type Mode = 'dropped' | 'late';
/** Make the browser's own (trusted, pointer) clicks vanish, or hold them back for later delivery. */
const interfere = (page: Page, mode: Mode) => page.evaluate((m) => {
  const w = window as any;
  w.__held = [];
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || e.detail === 0) return;
    if (m === 'late') w.__held.push(e.target);
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}, mode);
/** Deliver the held click (detail 1) to its original target, as a browser running 1.5 s behind would. */
const deliverLate = (page: Page) => page.evaluate(() => {
  const t = (window as any).__held.shift() as HTMLElement | undefined;
  if (!t) return 'no click was held';
  t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
  return `${t.tagName}.${t.className}`;
});

interface Case {
  name: string;
  /** Bring the control on screen; returns it and a probe of the state its action changes. */
  setup(page: Page): Promise<{ control: Locator; state: () => Promise<unknown> }>;
  /** Wait until the action has visibly happened (after the tap). */
  acted(page: Page, before: unknown, state: () => Promise<unknown>): Promise<void>;
}

const store = (page: Page) => page.evaluate(() => { const s = (window as any).sendit.store.get(); return { paused: s.paused, t: s.t, nodes: (window as any).sendit.nodesOf().length }; });

async function withNode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as any).sendit;
    w.store.set({ paused: true });
    w.editor.addNode(3000, { kind: 'orbital', body: 'earth' }, [100, 0, 0]);
  });
  await settled(page);
  await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0, selectedSeparation: null }));
}

const changed = async (page: Page, before: unknown, state: () => Promise<unknown>, what: string) => {
  await expect.poll(async () => JSON.stringify(await state()), { message: `${what} did not change from ${JSON.stringify(before)}`, timeout: 10_000 }).not.toBe(JSON.stringify(before));
};

const CASES: Case[] = [
  {
    // Zoom − / + are hidden on touch layouts (pinch zooms there); "Flight start" is the timeline button shown.
    name: 'timeline flight start',
    async setup(page) {
      await page.evaluate(() => { const w = (window as any).sendit; const s = w.store.get(); w.store.set({ paused: true, t: s.plan.epoch + 5000 }); });
      await settled(page);
      return { control: page.locator('.panel.scrubber > button[aria-label="Flight start"]'), state: async () => (await store(page)).t };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the time cursor'); },
  },
  {
    name: 'play / pause',
    async setup(page) {
      await page.evaluate(() => (window as any).sendit.store.set({ paused: true }));
      return { control: page.locator('.tb-clock > button').first(), state: async () => (await store(page)).paused };
    },
    async acted(page, before, state) { await changed(page, before, state, 'paused'); },
  },
  {
    name: 'node time step',
    async setup(page) {
      await withNode(page);
      await showSide(page, 'Nodes');
      return { control: page.getByRole('button', { name: /^Time: \+/ }).first(), state: () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t) };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the node time'); },
  },
  {
    name: 'Add node here',
    async setup(page) {
      await page.evaluate(() => { const w = (window as any).sendit; w.camera.setDistance(4e7, true); w.store.set({ paused: true }); });
      const p = await clickableTrajectoryPoint(page, [3000, 2000, 4000]);
      await touch(page, [{ x: p.x, y: p.y }]);
      await expect(page.locator('.tap-pop')).toBeVisible();
      return { control: page.locator('.tap-pop').getByRole('button', { name: 'Add node here' }), state: async () => (await store(page)).nodes };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the node count'); },
  },
  {
    name: 'Start panel liftoff step',
    async setup(page) {
      await page.evaluate(() => (window as any).sendit.editor.selectMission('lunar-flyby'));
      await settled(page);
      await showSide(page, 'Start');
      return { control: page.getByRole('button', { name: '+1m', exact: true }), state: () => page.evaluate(() => JSON.stringify((window as any).sendit.store.get().plan.start)) };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the liftoff time'); },
  },
  {
    name: 'Planner compute',
    async setup(page) {
      await showSide(page, 'Nodes');
      await page.getByRole('button', { name: 'Transfer planner…' }).tap();
      await expect(page.locator('.planner')).toBeVisible();
      return { control: page.locator('.planner').getByRole('button', { name: 'Compute porkchop' }), state: () => page.locator('.planner .pl-status').textContent() };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the planner status'); },
  },
  {
    name: 'Leaderboard view',
    async setup(page) {
      await page.evaluate(() => (window as any).sendit.editor.selectMission('lunar-flyby'));
      await settled(page);
      await showSide(page, 'Results');
      return { control: page.locator('section.leaderboard').getByRole('button', { name: 'Leaderboard', exact: true }), state: () => page.locator('dialog.lb').evaluate((d) => (d as HTMLDialogElement).open) };
    },
    async acted(page, before, state) { await changed(page, before, state, 'the leaderboard dialog'); },
  },
];

for (const mode of ['dropped', 'late'] as const) {
  for (const c of CASES) {
    test(`${c.name}: a tap whose click is ${mode === 'dropped' ? 'dropped' : 'delivered 1.5 s late'} acts exactly once`, async ({ page }) => {
      const errors = watch(page);
      await fresh(page);
      const { control, state } = await c.setup(page);
      const at = await aim(page, control);
      const before = await state();
      await interfere(page, mode);
      await touch(page, [at]);
      await c.acted(page, before, state);
      if (mode === 'late') {
        await page.waitForTimeout(1500); // the delay being simulated, not a wait for the app
        expect(await deliverLate(page)).not.toBe('no click was held');
      }
      await frames(page, 3);
      expect(await hits(page), `click events that reached ${c.name} (state before ${JSON.stringify(before)}, now ${JSON.stringify(await state())})`).toBe(1);
      expect(errors).toEqual([]);
    });
  }
}

test('a vertical swipe that starts on a node step button scrolls the panel and does not step', async ({ page }) => {
  const errors = watch(page);
  await fresh(page);
  await withNode(page);
  await showSide(page, 'Nodes');
  const control = page.getByRole('button', { name: /^Time: \+/ }).first();
  const at = await aim(page, control);
  const scroller = await control.evaluate((e) => {
    let p = e.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (!p) return null;
    (window as any).__scroller = p;
    return { top: p.scrollTop, max: p.scrollHeight - p.clientHeight, cls: p.className };
  });
  expect(scroller, 'no scrollable panel around the step button').not.toBeNull();
  const t0 = await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t);
  // Swipe up (content scrolls down) if there is room below, else down.
  const dir = scroller!.max - scroller!.top > 60 ? -1 : 1;
  await touch(page, Array.from({ length: 9 }, (_, k) => ({ x: at.x, y: at.y + dir * k * 10 })));
  await frames(page, 3);
  const top = await page.evaluate(() => (window as any).__scroller.scrollTop);
  expect(Math.abs(top - scroller!.top), `the panel (${scroller!.cls}) did not scroll: ${JSON.stringify(scroller)} -> ${top}`).toBeGreaterThan(10);
  expect(await hits(page), 'clicks that reached the step button').toBe(0);
  expect(await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t)).toBe(t0);
  expect(errors).toEqual([]);
});
