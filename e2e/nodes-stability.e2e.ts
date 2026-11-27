/**
 * The Maneuver nodes panel holds still while a burn is edited: with a node of
 * a staged plan selected, step-button clicks and a drag of the strip run
 * edit → replay pending → replay done cycles, sampled every animation frame.
 * No control (step buttons, strips, value fields, Disable / Delete, the row's
 * buttons) may move by more than 0.5 px, the clicked button stays the same
 * element and keeps focus, and the dock's scroll position does not change.
 * Run at the dock's narrowest and widest (360 and 460 px).
 */
import { expect, test, type Page } from '@playwright/test';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';

test.skip(({ browserName }) => browserName !== 'chromium', 'UI checks run in Chromium');

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

/** Watched elements: what the user can click, and the rows / readouts around them (reported, not asserted). */
const CONTROLS = ['.nodes .tn-step', '.nodes .tn-pad', '.nodes .tuner input', '.nodes .tn-zero', '.nodes .tn-neg', '.nodes .node-detail .btn', '.nodes .node-detail select', '.nodes .nact-btn', '.nodes .sep-offer', '.nodes .hist', '.topbar button', '.topbar a'];
const CONTEXT = ['.nodes .node-row', '.nodes .node-readout .kv', '.nodes .tuner', '.nodes', '#hud section', '#hud section > *', '.nodes > *', '.nodes .node-detail > *', '.nodes .node-list > *', '#hud section:not(.nodes) button', '#hud section:not(.nodes) select', '#hud section:not(.nodes) input', '#hud section:not(.nodes) .kv', '#hud .event-row', '#hud .scrubber'];

interface Report {
  moved: { sel: string; i: number; dx: number; dy: number; dw: number; dh: number; text: string }[];
  replaced: string[];
  scroll: number[];
  shifts: number;
  sources: string[];
  frames: number;
}

async function startRecorder(page: Page): Promise<void> {
  await page.evaluate(({ controls, context }) => {
    const all = [...controls.map((s: string) => [s, true] as const), ...context.map((s: string) => [s, false] as const)];
    const base = new Map<string, { el: Element; r: DOMRect }>();
    for (const [sel] of all) document.querySelectorAll(sel).forEach((e, i) => base.set(`${sel}|${i}`, { el: e, r: e.getBoundingClientRect() }));
    const panel = document.querySelector('.nodes') as HTMLElement;
    let sc: HTMLElement | null = panel;
    while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    const rec = { moved: new Map<string, { dx: number; dy: number; dw: number; dh: number; text: string }>(), replaced: new Set<string>(), scroll: new Set<number>([sc?.scrollTop ?? 0]), shifts: 0, frames: 0, stop: false, sources: new Set<string>(), scrollers: new Map<HTMLElement, Set<number>>() };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { rec.shifts += (e as any).value; for (const s of (e as any).sources ?? []) { const n = s.node as Element | null; rec.sources.add(n ? (n.nodeType === 1 ? n.tagName + '.' + n.className : 'text:' + (n.textContent || '').slice(0, 20) + ' in ' + (n.parentElement?.className ?? '')) : '?'); } } }).observe({ type: 'layout-shift', buffered: false } as any);
    const frame = () => {
      if (rec.stop) return;
      rec.frames++;
      rec.scroll.add(Math.round((sc?.scrollTop ?? 0) * 10) / 10);
      document.querySelectorAll('#hud *').forEach((e) => { const h = e as HTMLElement; if (h.scrollHeight > h.clientHeight + 1) { const v = rec.scrollers.get(h) ?? new Set<number>(); v.add(Math.round(h.scrollTop)); rec.scrollers.set(h, v); } });
      // Each watched element by identity: a rebuilt element counts as replaced, not as moved.
      for (const [k, b] of base) {
        const e = b.el;
        if (!e.isConnected) { rec.replaced.add(k); continue; }
        const r = e.getBoundingClientRect();
        const d = { dx: r.x - b.r.x, dy: r.y - b.r.y, dw: r.width - b.r.width, dh: r.height - b.r.height, text: (e.textContent || (e as HTMLInputElement).value || '').trim().slice(0, 40) };
        const m = Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));
        const prev = rec.moved.get(k);
        if (m > 0.5 && (!prev || m > Math.max(Math.abs(prev.dx), Math.abs(prev.dy), Math.abs(prev.dw), Math.abs(prev.dh)))) rec.moved.set(k, d);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    (window as any).__rec = rec;
  }, { controls: CONTROLS, context: CONTEXT });
}

async function stopRecorder(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const rec = (window as any).__rec;
    rec.stop = true;
    return {
      moved: [...rec.moved.entries()].map(([k, d]: [string, any]) => ({ sel: k.split("|")[0], i: Number(k.split("|")[1]), ...d })),
      replaced: [...rec.replaced],
      scroll: [...rec.scroll],
      shifts: rec.shifts, sources: [...rec.sources, ...[...rec.scrollers.entries()].filter(([, v]: any) => v.size > 1).map(([e, v]: any) => 'scroll ' + e.className + ' ' + [...v].join('/'))],
      frames: rec.frames,
    };
  });
}

for (const width of [360, 460]) {
  test.describe(`nodes panel holds still, dock ${width} px`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('step clicks and a drag move no control', async ({ page }) => {
      test.setTimeout(400_000);
      page.on('dialog', (d) => void d.accept());
      await page.goto(`${BASE}/`);
      await page.evaluate((w) => { localStorage.clear(); localStorage.setItem('sendit.layout.v1', JSON.stringify({ widths: { left: w, right: w } })); }, width);
      await page.goto(`${BASE}/`);
      await settled(page);
      await page.evaluate(() => (window as any).sendit.editor.selectMission('geo-from-leo'));
      await settled(page);
      await solveGeo(page);
      await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0, selectedSeparation: null }));
      await settled(page);
      const step = page.locator('.nodes .tuner').nth(1).locator('.tn-step.inc').first(); // Prograde, small step
      await step.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const b = (await step.boundingBox())!;
      const handle = await step.elementHandle();
      await startRecorder(page);
      // Clicks at a fixed screen point, as a user does: if the button moved, the click lands elsewhere.
      const dvOf = () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0] as number);
      const dv0 = await dvOf();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let k = 0; k < 4; k++) {
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(k === 3 ? 0 : 250);
      }
      await settled(page);
      await page.waitForTimeout(200);
      // Every click landed on the button: four small steps.
      expect(await dvOf()).toBeCloseTo(dv0 + 4 * 0.1, 2);
      // The button under the pointer is still the one first clicked.
      const sameEl = await handle!.evaluate((e, p) => e.isConnected && document.elementFromPoint(p.x, p.y)?.closest('button') === e, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const focused = await handle!.evaluate((e) => document.activeElement === e);
      // Drag the strip (Normal axis) 60 px right and back, slowly.
      const pad = page.locator('.nodes .tuner').nth(2).locator('.tn-pad');
      const pb = (await pad.boundingBox())!;
      await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
      await page.mouse.down();
      for (let k = 1; k <= 10; k++) { await page.mouse.move(pb.x + pb.width / 2 + k * 6, pb.y + pb.height / 2); await page.waitForTimeout(60); }
      for (let k = 9; k >= 0; k--) { await page.mouse.move(pb.x + pb.width / 2 + k * 6, pb.y + pb.height / 2); await page.waitForTimeout(60); }
      await page.mouse.up();
      await settled(page);
      await page.waitForTimeout(200);
      const rep = await stopRecorder(page);
      console.log(`dock ${width}: ${rep.frames} frames, layout shift ${rep.shifts.toFixed(4)}, scroll ${JSON.stringify(rep.scroll)}`);
      for (const m of rep.moved) console.log(`  moved ${m.sel}[${m.i}] dx ${m.dx.toFixed(1)} dy ${m.dy.toFixed(1)} dw ${m.dw.toFixed(1)} dh ${m.dh.toFixed(1)} "${m.text}"`);
      for (const r of rep.sources) console.log(`  shift source ${r}`);
      for (const r of rep.replaced) console.log(`  replaced ${r}`);
      const dv = await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0]);
      console.log(`  prograde now ${dv}`);
      const controlsMoved = rep.moved.filter((m) => CONTROLS.includes(m.sel));
      expect(controlsMoved).toEqual([]);
      expect(rep.replaced.filter((r) => /tn-step|tn-pad|tuner input|nact-btn/.test(r))).toEqual([]);
      expect(sameEl).toBe(true);
      expect(focused).toBe(true);
      expect(rep.scroll.length).toBe(1);
    });
  });
}
