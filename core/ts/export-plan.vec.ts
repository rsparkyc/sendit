/**
 * Plan codec vectors (core/fixtures/generated/plan.txt) for core/src/mission/plan.rs.
 *
 * Base plans: every campaign reference solution, the pinned staged and
 * model-2 fixtures, and hand-made format 1 (state, delivered launch) and
 * format 3 (direct, propulsion flags) plans. From each:
 *  - the TypeScript encoding S (the Rust decodes S and re-encodes it: S again);
 *  - field mutations (NaN, +-Infinity, -0, 0, negative, huge, tiny in every
 *    float64 field; integer fields in range; bad ids; unsorted burns and
 *    separations; flags on format 3) written with a raw, non-validating writer
 *    of the same wire format, so the decoder's rejections are compared, and
 *    validatePlanIssues (full and structural, with and without
 *    ascentFirstStage) on the plan as the bytes describe it;
 *  - byte mutations (each byte set to 0, 255, b ^ 1) and string corruptions
 *    (every truncation, invalid characters, non-canonical tails, over-long).
 * Strings and messages are written as UTF-8 hex.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { CAMPAIGN } from '../../src/mission/campaign';
import { decodePlan, encodePlan, LIMITS, toBase64Url, validatePlanIssues, type MissionPlan } from '../../src/mission/plan';
import { SOLUTIONS, solutionPlan } from '../../test/helpers/campaign-solutions';
import * as STAGED from '../../src/fixtures/staged-replay';
import * as M2 from '../../src/fixtures/model2-replay';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The wire format of plan.ts encodePlan, without any validation (DataView coercions). */
function rawEncode(p: any): Uint8Array {
  const out: number[] = [];
  const dv = new DataView(new ArrayBuffer(8));
  const u8 = (v: number) => { dv.setUint8(0, v); out.push(dv.getUint8(0)); };
  const u16 = (v: number) => { dv.setUint16(0, v, true); out.push(dv.getUint8(0), dv.getUint8(1)); };
  const u32 = (v: number) => { dv.setUint32(0, v, true); for (let i = 0; i < 4; i++) out.push(dv.getUint8(i)); };
  const f64 = (v: number) => { dv.setFloat64(0, v, true); for (let i = 0; i < 8; i++) out.push(dv.getUint8(i)); };
  const str = (s: string) => { u8(s.length); for (let i = 0; i < s.length; i++) u8(s.charCodeAt(i)); };
  u8(0x53); u8(p.format); u16(p.model); u32(parseInt(p.data, 16)); f64(p.epoch); f64(p.duration); f64(p.rtol);
  const st = p.start;
  if (st.kind === 'state') { u8(0); str(st.center); for (let i = 0; i < 6; i++) f64(st.state[i]); }
  else { u8(st.ascent === 'direct' ? 3 : st.ascent === 'vehicle' ? 2 : 1); str(st.site); u8(st.params.length); for (const x of st.params) f64(x); }
  const stage = (s: any) => {
    f64(s.wetMass); f64(s.dryMass); u8(s.engines.length);
    for (const e of s.engines) { f64(e.thrust); f64(e.isp); if (p.format === 3) u8((e.restartable === false ? 1 : 0) | (e.throttleable === false ? 2 : 0)); }
  };
  const burn = (b: any, withStage: boolean) => {
    f64(b.start); f64(b.duration); if (withStage) u8(b.stage); u8(b.engine);
    for (let i = 0; i < 3; i++) f64(b.direction[i]);
    if (b.frame.kind === 'inertial') u8(0); else { u8(1); str(b.frame.body); }
  };
  if (p.format === 1) { stage(p.spacecraft); u16(p.burns.length); for (const b of p.burns) burn(b, false); }
  else {
    const stages = [...p.lowerStages, p.spacecraft];
    u8(stages.length); for (const s of stages) stage(s);
    const seps = p.separations; const acts: [number, any][] = []; let j = 0;
    for (const b of p.burns) { while (j < seps.length && seps[j].time <= b.start) acts.push([1, seps[j++]]); acts.push([0, b]); }
    while (j < seps.length) acts.push([1, seps[j++]]);
    u16(acts.length);
    for (const [k, a] of acts) { u8(k); if (k === 0) burn(a, true); else f64(a.time); }
  }
  return Uint8Array.from(out);
}

/** The plan in the shape decodePlan produces (format 2/3: stage on every burn, lowerStages, separations; flags only on format 3, only when false). */
function canon(p: any): MissionPlan {
  const eng = (e: any) => ({ thrust: e.thrust, isp: e.isp, ...(p.format === 3 && e.restartable === false ? { restartable: false } : {}), ...(p.format === 3 && e.throttleable === false ? { throttleable: false } : {}) });
  const stg = (s: any) => ({ wetMass: s.wetMass, dryMass: s.dryMass, engines: s.engines.map(eng) });
  const st = p.start.kind === 'state' ? { kind: 'state', center: p.start.center, state: [...p.start.state] }
    : { kind: 'launch', site: p.start.site, params: [...p.start.params], ...(p.start.ascent ? { ascent: p.start.ascent } : {}) };
  const lower = p.format === 1 ? [] : (p.lowerStages ?? []);
  const burns = p.burns.map((b: any) => {
    const o: any = { start: b.start, duration: b.duration, engine: b.engine, direction: [...b.direction], frame: b.frame.kind === 'inertial' ? { kind: 'inertial' } : { kind: 'orbital', body: b.frame.body } };
    return p.format === 1 ? o : { start: o.start, duration: o.duration, stage: b.stage ?? lower.length, engine: o.engine, direction: o.direction, frame: o.frame };
  });
  const base: any = { format: p.format, model: p.model, data: p.data, epoch: p.epoch, duration: p.duration, rtol: p.rtol, start: st, spacecraft: stg(p.spacecraft), burns };
  if (p.format !== 1) { base.lowerStages = lower.map(stg); base.separations = (p.separations ?? []).map((s: any) => ({ time: s.time })); }
  return base;
}

it('plan codec vectors', () => {
  const fp = STAGED.DATA;
  const bases: any[] = [];
  for (const m of CAMPAIGN) for (const site of Object.keys(SOLUTIONS[m.id] ?? {})) bases.push(solutionPlan(m, site, fp));
  bases.push({ ...STAGED.PLAN, format: 2, model: STAGED.MODEL, data: fp });
  bases.push({ ...M2.PLAN, format: 1, model: M2.MODEL, data: fp });
  const sc = { wetMass: 2000, dryMass: 800, engines: [{ thrust: 400, isp: 310 }, { thrust: 22, isp: 220 }] };
  bases.push({ format: 1, model: 2, data: fp, epoch: 8.5e8, duration: 86400, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: [7e6, 0, -0, 0, 7546.05, 0] }, spacecraft: sc,
    burns: [{ start: 100, duration: 50, engine: 1, direction: [0, 1, 0], frame: { kind: 'inertial' } }, { start: 1000, duration: 5, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'moon' } }] });
  bases.push({ format: 2, model: 2, data: fp, epoch: 8.5e8, duration: 86400, rtol: 1e-9, start: { kind: 'launch', site: 'baikonur', params: [8.5e8, 63, 200e3, 540, 13.5, 1], ascent: 'vehicle' },
    lowerStages: [{ wetMass: 3e5, dryMass: 2e4, engines: [{ thrust: 4e6, isp: 300 }] }], spacecraft: sc, separations: [{ time: 600 }, { time: 700 }],
    burns: [{ start: 650, duration: 30, stage: 0, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }, { start: 900, duration: 10, stage: 1, engine: 1, direction: [0, 0, 1], frame: { kind: 'inertial' } }] });
  bases.push({ format: 3, model: 2, data: fp, epoch: 9e8, duration: 3 * 86400, rtol: 1e-10, start: { kind: 'launch', site: 'kourou', params: [9e8, 90, 1.2e7, 300e3, 900], ascent: 'direct' },
    lowerStages: [{ wetMass: 4e5, dryMass: 2.4e4, engines: [{ thrust: 8e6, isp: 311, restartable: false, throttleable: false }] }, { wetMass: 1e5, dryMass: 4e3, engines: [{ thrust: 9.8e5, isp: 348, throttleable: false }] }],
    spacecraft: { wetMass: 3000, dryMass: 1200, engines: [{ thrust: 400, isp: 320, restartable: false }, { thrust: 20, isp: 220 }] }, separations: [{ time: 1000 }],
    burns: [{ start: 2000, duration: 30, stage: 2, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }, { start: 5000, duration: 30, stage: 2, engine: 1, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] });
  bases.push({ format: 1, model: 2, data: fp, epoch: 8.6e8, duration: 86400, rtol: 1e-10, start: { kind: 'launch', site: 'cape-canaveral', params: [8.6e8, 45, 300e3] }, spacecraft: sc, burns: [] });

  const L: string[] = [];
  const decodeRec = (s: string) => {
    try { const p = decodePlan(s); L.push(`decode ok ${encodePlan(p)}`); return p; }
    catch (e) { L.push(`decode err ${hex((e as Error).message)}`); return null; }
  };
  const issuesRec = (p: MissionPlan) => {
    const ns = p.format === 1 ? 1 : 1 + (p.lowerStages?.length ?? 0);
    for (const mode of ['full', 'structural'] as const)
      for (const afs of [undefined, 0, 1, ns - 1]) {
        const is = validatePlanIssues(p, { launch: mode, ...(afs === undefined ? {} : { ascentFirstStage: afs }) });
        L.push(`issues ${mode} ${afs ?? -1} ${is.length}`);
        for (const i of is) L.push(`issue ${i.code} ${hex(i.path)} ${i.burn ?? -1} ${hex(i.message)}`);
      }
  };
  const specials = [NaN, Infinity, -Infinity, -0, 0, -1, 1e300, 1e-300, 0.5, 3e7];
  let n = 0;
  const emitObj = (o0: any) => {
    const o = canon(o0);
    const s = toBase64Url(rawEncode(o));
    L.push(`plan ${n++} ${s}`);
    decodeRec(s);
    issuesRec(o);
  };
  for (const b0 of bases) {
    const b = canon(b0);
    const s = encodePlan(b);
    L.push(`plan ${n++} ${s}`);
    const p = decodeRec(s)!;
    issuesRec(p);
    // Field mutations.
    const paths: (string | number)[][] = [];
    const walk = (v: any, path: (string | number)[]) => {
      if (typeof v === 'number') paths.push(path);
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], [...path, Array.isArray(v) ? Number(k) : k]);
    };
    walk(b, []);
    const set = (path: (string | number)[], x: any) => {
      const c = structuredClone(b) as any;
      let o = c;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path[path.length - 1]] = x;
      return c;
    };
    for (const path of paths) {
      const last = path[path.length - 1];
      if (last === 'format') { for (const f of [1, 2, 3]) if (f !== b.format) emitObj(set(path, f)); continue; }
      if (last === 'model') { emitObj(set(path, 1)); emitObj(set(path, 65535)); continue; }
      if (last === 'engine' || last === 'stage') { for (const x of [0, 1, 2, 5]) emitObj(set(path, x)); continue; }
      for (const x of specials) emitObj(set(path, x));
    }
    for (const bad of ['', 'Earth', 'a'.repeat(LIMITS.maxIdLength + 1), 'no-such-site', 'x y']) {
      if (b.start.kind === 'state') emitObj(set(['start', 'center'], bad)); else emitObj(set(['start', 'site'], bad));
      if (b.burns.some((x: any) => x.frame.kind === 'orbital')) emitObj(set(['burns', b.burns.findIndex((x: any) => x.frame.kind === 'orbital'), 'frame', 'body'], bad));
    }
    if (b.burns.length > 1) { const c = structuredClone(b) as any; c.burns.reverse(); emitObj(c); }
    if (b.format !== 1 && b.separations!.length > 0) { const c = structuredClone(b) as any; c.separations.push({ time: c.separations[0].time - 1 }); emitObj(c); }
    if (b.format !== 1) {
      const c = structuredClone(b) as any; c.format = 3;
      for (const st of [...c.lowerStages, c.spacecraft]) for (const e of st.engines) { e.restartable = false; e.throttleable = false; }
      emitObj(c);
      const d = structuredClone(c); d.spacecraft.engines = []; emitObj(d);
    }
    { const c = structuredClone(b) as any; c.data = 'deadbeef'; emitObj(c); }
    { const c = structuredClone(b) as any; c.spacecraft.dryMass = c.spacecraft.wetMass * 2; emitObj(c); }
    { const c = structuredClone(b) as any; c.spacecraft.engines = Array.from({ length: LIMITS.maxEngines + 1 }, () => ({ thrust: 1, isp: 1 })); emitObj(c); }
    // Byte mutations.
    const bytes = rawEncode(b);
    for (let i = 0; i < bytes.length; i++)
      for (const v of [0, 255, bytes[i] ^ 1]) {
        const c = bytes.slice(); c[i] = v;
        L.push(`plan ${n++} ${toBase64Url(c)}`);
        decodeRec(toBase64Url(c));
      }
    {
      const c = new Uint8Array(bytes.length + 2); c.set(bytes); L.push(`plan ${n++} ${toBase64Url(c)}`); decodeRec(toBase64Url(c));
    }
    // String corruptions.
    const strs = [];
    for (let k = 0; k < s.length; k++) strs.push(s.slice(0, k));
    for (const ch of ['=', '+', '/', 'é', ' ', '.']) strs.push(s.slice(0, 7) + ch + s.slice(8));
    strs.push(s + 'A', s + 'AA', s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'), s + 'x'.repeat(LIMITS.maxEncodedLength));
    for (const x of strs) { L.push(`plan ${n++} ${x.length ? hex(x) : '-'} hex`); decodeRec(x); }
  }
  writeFileSync(OUT + 'plan.txt', L.join('\n') + '\n');
  console.log(`plan.txt: ${n} strings`);
});
