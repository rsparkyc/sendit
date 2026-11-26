/**
 * The planning aids end to end in Node, through exactly what the planner
 * worker runs (planner-core.ts): porkchop -> launch opportunity -> departure
 * node -> staged corrector -> scoring replay, for Earth->Mars and
 * Earth->Venus 2026, and "target this flyby" on a lunar transfer burn.
 * The closest approach is always the one measured in the real replay.
 */
import { describe, expect, it } from 'vitest';
import { geocentricLatitudeDeg, launchSite, type MissionPlan } from './mission-layer';
import { initialPlan, MISSIONS, SPACECRAFT_PRESETS, withLaunch } from './missions';
import { addNode, setSpacecraft } from './nodes';
import { ReplayEphemeris } from './physics';
import { plannerCore } from './planner-core';
import { porkchopRequest } from './porkchop-view';
import type { FromPlanner } from './protocol';
import { calendarToTdb } from './time';
import { defaultInclination, launchOpportunities } from './transfer';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };
const eph = new ReplayEphemeris();
eph.installCheckpoints(new Uint8Array(readFileSync(new URL('../physics/data/checkpoints-1950-2100.bin', import.meta.url))));
const out: FromPlanner[] = [];
const core = plannerCore(eph, (m) => out.push(m));
const DAY = 86400;
const CRAFT = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CRAFT ?? 0);
const date = (y: number, mo: number, d: number) => calendarToTdb({ year: y, month: mo, day: d, hour: 0, minute: 0, second: 0 });
const take = <T extends FromPlanner['type']>(type: T) => {
  const m = out.filter((x) => x.type === type || x.type === 'error').at(-1);
  if (!m || m.type === 'error') throw new Error(m ? (m as { message: string }).message : `no ${type}`);
  return m as Extract<FromPlanner, { type: T }>;
};

async function transfer(arrival: string, dep: [number, number], arr: [number, number], altitude: number) {
  const t0 = performance.now();
  await core.porkchop(1, porkchopRequest('earth', arrival, dep[0], dep[1], arr[0], arr[1], 160, 160));
  const pc = take('porkchop');
  const g = pc.grid;
  let k = -1;
  for (let q = 0; q < g.c3.length; q++) if (Number.isFinite(g.c3[q]) && (k < 0 || g.c3[q] < g.c3[k])) k = q;
  const i = k % g.nDep;
  const j = (k - i) / g.nDep;
  const tDep = g.depTimes[i];
  const tArr = g.arrTimes[j];
  const v = g.vInfDep[k];
  const dla = g.dla[k];
  const rla = g.rla[k];
  const vInf = [v * Math.cos(dla) * Math.cos(rla), v * Math.cos(dla) * Math.sin(rla), v * Math.sin(dla)];
  // Launch from the Cape into a plane containing the asymptote.
  const site = 'cape-canaveral';
  const inc = defaultInclination(geocentricLatitudeDeg(launchSite(site)), (dla * 180) / Math.PI);
  const ops = launchOpportunities(site, vInf, tDep, inc, tDep - 2 * DAY, tDep).filter((o) => o.allowed && o.t < tDep - 3 * 3600);
  const op = ops.at(-1)!;
  let plan: MissionPlan = setSpacecraft(initialPlan(MISSIONS[0], eph.physics ? '00000000' : ''), SPACECRAFT_PRESETS[CRAFT].craft);
  plan = withLaunch(plan, { site, time: op.t, azimuthDeg: op.azimuthDeg, altitudeM: 200e3 });
  plan = { ...plan, data: (await import('./mission-layer')).makeWorld(eph.physics, (await import('./physics')).BODY_DATA).fingerprint };
  core.departure({ type: 'departure', id: 2, plan, departure: 'earth', vInf, tDep, tArr });
  const d = take('departure');
  await core.correct({ type: 'correct', id: 3, plan: d.plan, missionId: 'sandbox', burn: d.index, target: { body: arrival, altitude, theta: null, tArr } });
  const c = take('correct');
  const ms = performance.now() - t0;
  console.log(`${arrival}: porkchop ${pc.ms.toFixed(0)} ms, min C3 ${(g.c3[k] / 1e6).toFixed(2)} km2/s2 dep ${new Date(Date.UTC(2000, 0, 1, 12) + tDep * 1000).toISOString().slice(0, 10)}, ` +
    `launch ${new Date(Date.UTC(2000, 0, 1, 12) + op.t * 1000).toISOString().slice(0, 16)} az ${op.azimuthDeg.toFixed(2)} inc ${inc.toFixed(1)} (${ops.length} allowed opportunities), departure dv ${d.dv.toFixed(0)} m/s asym err ${d.asymptoteErrorDeg.toFixed(3)} deg (${d.ms.toFixed(0)} ms); ` +
    `corrector ${c.ok} ${c.message} predicted ${((c.predicted ?? NaN) / 1e3).toFixed(1)} km; stages ${c.stages.map((s) => `${s.label}: ${s.converged ? 'ok' : 'NO'} ${(s.miss / 1e3).toFixed(2)} km ${s.iterations} it ${s.ms.toFixed(0)} ms`).join('; ')}; total ${(c.ms).toFixed(0)} ms corrector, ${ms.toFixed(0)} ms all`);
  return { g, k, tDep, c, d };
}

describe('planning aids end to end (real N-body replay)', () => {
  it('Earth to Mars 2026: minimum near Nov 2026 at C3 9-11, refined to a 500 km flyby measured in the replay', async () => {
    const { g, k, tDep, c } = await transfer('mars', [date(2026, 9, 1), date(2026, 12, 31)], [date(2027, 6, 1), date(2027, 11, 1)], 500e3);
    expect(g.c3[k] / 1e6).toBeGreaterThan(8.5);
    expect(g.c3[k] / 1e6).toBeLessThan(11.5);
    expect(tDep).toBeGreaterThan(date(2026, 10, 20));
    expect(tDep).toBeLessThan(date(2026, 11, 20));
    expect(c.ok).toBe(true);
    expect(Math.abs(c.measured!.altitude - 500e3)).toBeLessThan(50e3);
  }, 300_000);

  it('Earth to Venus 2026 refined to a 1000 km flyby', async () => {
    const { c } = await transfer('venus', [date(2026, 3, 1), date(2026, 8, 31)], [date(2026, 6, 1), date(2027, 2, 1)], 1000e3);
    expect(c.ok).toBe(true);
    expect(Math.abs(c.measured!.altitude - 1000e3)).toBeLessThan(50e3);
  }, 300_000);

  it('target this flyby: a trans-lunar burn retargeted to 300 km at the Moon, earlier burns untouched', async () => {
    const { makeWorld } = await import('./mission-layer');
    const { BODY_DATA } = await import('./physics');
    let plan = initialPlan(MISSIONS[0], makeWorld(eph.physics, BODY_DATA).fingerprint);
    plan = withLaunch(plan, { site: 'kourou', time: calendarToTdb({ year: 2027, month: 1, day: 10, hour: 20, minute: 23, second: 4 }), azimuthDeg: 62.7669, altitudeM: 200e3 });
    // A small trim burn first (must stay bit-identical), then a trans-lunar burn that misses.
    plan = addNode(plan, { t: 1500, dv: [2, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    plan = addNode(plan, { t: 3019.5, dv: [3100, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    await core.correct({ type: 'correct', id: 4, plan, missionId: 'sandbox', burn: 1, target: { body: 'moon', altitude: 300e3, theta: null, tArr: null } });
    const c = take('correct');
    console.log(`moon: ${c.ok} ${c.message}; ${c.stages.map((s) => `${s.label}: ${s.converged ? 'ok' : 'NO'} ${(s.miss / 1e3).toFixed(2)} km ${s.ms.toFixed(0)} ms`).join('; ')}; ${c.ms.toFixed(0)} ms`);
    expect(c.ok).toBe(true);
    expect(c.plan!.burns[0]).toBe(plan.burns[0]);
    expect(Math.abs(c.measured!.altitude - 300e3)).toBeLessThan(30e3);
  }, 300_000);
});
