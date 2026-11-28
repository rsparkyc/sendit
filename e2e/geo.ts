/**
 * The geostationary mission solved through the editor UI, the way a player
 * would fly the mission's reference approach: parking orbit at the
 * reference's altitude, the upper stage flies the transfer burn, "separate"
 * drops it after cutoff, and the satellite circularises and removes the
 * inclination. The burn values are re-derived in the page from the
 * reference solution in test/fixtures/campaign-solutions.json (tests may
 * read it; the UI never shows it): each burn becomes a node (time, delta-v)
 * on the current plan, typed in like any other node.
 */
import { expect, type Page } from '@playwright/test';
import solutions from '../test/fixtures/campaign-solutions.json' with { type: 'json' };

type Sol = { params: number[]; duration: number; burns: unknown[]; separations: { time: number }[] };

async function enter(page: Page, selector: string, value: string): Promise<void> {
  const i = page.locator(selector).first();
  // Phone layout: the input lives in a tab; open the one that holds it.
  for (const name of ['Start', 'Nodes']) {
    if (await i.isVisible()) break;
    const tab = page.getByRole('tab', { name });
    if (await tab.count()) await tab.first().click();
  }
  await i.fill(value);
  await i.press('Enter');
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

/** The reference's nodes on the current plan: [{ t, dv, stage }]. */
export async function referenceNodes(page: Page, mission: string): Promise<{ t: number; dv: [number, number, number]; stage: number }[]> {
  const site = await page.evaluate(() => (window as any).sendit.store.get().plan.start.site as string);
  const s = (solutions as unknown as Record<string, Record<string, Sol>>)[mission][site];
  return page.evaluate(([b, sp]) => (window as any).sendit.nodesOfBurns(b, sp), [s.burns, s.separations] as const);
}

export function referenceOf(mission: string, site: string): Sol {
  return (solutions as unknown as Record<string, Record<string, Sol>>)[mission][site];
}

/** Type one node in through the node editor. */
async function typeNode(page: Page, t: number, dv: readonly number[]): Promise<void> {
  const add = page.getByRole('button', { name: '+ Node at cursor' });
  if (!(await add.isVisible())) { const tab = page.getByRole('tab', { name: 'Nodes' }); if (await tab.count()) await tab.first().click(); }
  await add.click();
  await enter(page, 'input.met-input', String(t));
  await enter(page, 'input[title="Prograde delta-v, m/s"]', String(dv[0]));
  await enter(page, 'input[title="Normal delta-v, m/s"]', String(dv[1]));
  await enter(page, 'input[title="Radial out delta-v, m/s"]', String(dv[2]));
  await settled(page);
}

/**
 * Solve geo-from-leo through the UI. `durationDays` defaults to the reference's
 * flight (rounded up). Returns the stage of each burn as the plan has them.
 */
export async function solveGeo(page: Page, durationDays?: number): Promise<number[]> {
  const site = await page.evaluate(() => (window as any).sendit.store.get().plan.start.site as string);
  const ref = referenceOf('geo-from-leo', site);
  await enter(page, 'input[title^="Flight duration"]', String(durationDays ?? Math.ceil((ref.duration / 86400) * 100) / 100));
  await settled(page);
  // The reference's parking altitude (the field follows the altitude convention by default).
  await enter(page, 'input.parking-alt', String(ref.params[2] / 1000));
  await settled(page);
  const nodes = await referenceNodes(page, 'geo-from-leo');
  expect(nodes.length).toBe(2);
  // 1. The upper stage flies the transfer burn.
  await typeNode(page, nodes[0].t, nodes[0].dv);
  // 2. Separate it after cutoff (it still holds propellant, so nothing separates by itself).
  await page.locator('.sep-offer').first().click();
  await settled(page);
  await expect(page.locator('.sep-row')).toHaveCount(1);
  // 3. The satellite circularises and removes the inclination.
  await typeNode(page, nodes[1].t, nodes[1].dv);
  return page.evaluate(() => (window as any).sendit.nodesOf().map((x: { stage: number }) => x.stage));
}

/**
 * Drag the solved plan's separation marker later on the timeline, to a time that keeps the plan valid: half way
 * between where it is and the start of the satellite's burn (the second burn span). Dropping it inside that burn
 * gives a plan with errors ("still firing at separations[0]"), which the app never replays. The points come from
 * the drawn marker and span, checked with elementFromPoint. Returns the separation time before the drag.
 */
export async function dragSeparationLater(page: Page): Promise<number> {
  const pts = await page.evaluate(() => {
    // Scroll and measure in one task: the timeline rebuilds its ticks on store changes (e.g. playback time), so a
    // Playwright handle to the marker can be detached between calls (WebKit). Any later rebuild redraws it in place.
    const tk = document.querySelector('.tick.sep') as HTMLElement;
    tk.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const burn = document.querySelectorAll('.span.burn')[1] as HTMLElement | undefined;
    const a = tk.getBoundingClientRect();
    const x0 = a.left + a.width / 2, y = a.top + a.height / 2;
    const top = document.elementFromPoint(x0, y);
    return { x0, y, x1: burn ? burn.getBoundingClientRect().left : NaN, onTop: !!top && (top === tk || tk.contains(top)), top: top?.className ?? null, seps: JSON.stringify((window as any).sendit.store.get().plan.separations) };
  });
  const msg = `separation drag points ${JSON.stringify(pts)}`;
  expect(pts.onTop, msg).toBe(true);
  expect(pts.x1 - pts.x0, msg).toBeGreaterThan(8); // room to move past the 3 px drag threshold
  const before = await page.evaluate(() => (window as any).sendit.store.get().plan.separations[0].time as number);
  const x = (pts.x0 + pts.x1) / 2;
  await page.mouse.move(pts.x0, pts.y);
  await page.mouse.down();
  await page.mouse.move(x, pts.y, { steps: 5 });
  await page.mouse.up();
  return before;
}

/**
 * Drag the solved plan's separation marker into the middle of the satellite's burn (the second burn span) and
 * check, before releasing, that the drag preview already shows it snapped outside the drawn span. Returns the burn
 * (mission seconds) the drop aimed into and the separation time before the drag. Positions come from the drawn
 * marker and span, not from timing.
 */
export async function dragSeparationIntoBurn(page: Page): Promise<{ start: number; end: number; before: number }> {
  // Zoom the timeline to the separation and the burn, so the burn is wide enough to aim inside.
  await page.evaluate(() => {
    const sd = (window as any).sendit;
    const p = sd.store.get().plan, b = p.burns[1], t = p.separations[0].time;
    const t0 = Math.min(t, b.start), t1 = Math.max(t, b.start + b.duration), m = (t1 - t0) * 0.05;
    sd.timeline.setWindow([p.epoch + t0 - m, p.epoch + t1 + m]);
  });
  const pts = await page.evaluate(() => {
    // Scroll and measure in one task: the timeline rebuilds its ticks on store changes (e.g. playback time), so a
    // Playwright handle to the marker can be detached between calls (WebKit). Any later rebuild redraws it in place.
    const tk = document.querySelector('.tick.sep') as HTMLElement;
    tk.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const span = document.querySelectorAll('.span.burn')[1] as HTMLElement;
    const a = tk.getBoundingClientRect(), s = span.getBoundingClientRect();
    const p = (window as any).sendit.store.get().plan;
    const b = p.burns[1];
    return { x0: a.left + a.width / 2, y: a.top + a.height / 2, left: s.left, right: s.right, start: b.start as number, end: (b.start + b.duration) as number, before: p.separations[0].time as number };
  });
  const msg = `separation into burn ${JSON.stringify(pts)}`;
  expect(pts.right - pts.left, msg).toBeGreaterThan(8); // a burn wide enough to aim inside
  const x = (pts.left + pts.right) / 2;
  await page.mouse.move(pts.x0, pts.y);
  await page.mouse.down();
  await page.mouse.move(x, pts.y, { steps: 5 });
  // Live preview: the marker sits at the burn's edge, not under the pointer inside it.
  const cx = await page.evaluate(() => { const r = document.querySelector('.tick.sep')!.getBoundingClientRect(); return r.left + r.width / 2; });
  expect(cx <= pts.left + 1 || cx >= pts.right - 1, `${msg} preview at ${cx}`).toBe(true);
  await page.mouse.up();
  return { start: pts.start, end: pts.end, before: pts.before };
}
