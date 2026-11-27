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
  await page.locator('.tick.sep').scrollIntoViewIfNeeded();
  const pts = await page.evaluate(() => {
    const tk = document.querySelector('.tick.sep') as HTMLElement;
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
