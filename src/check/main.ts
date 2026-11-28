/**
 * Cross-engine determinism check page. Two independent checks, each in its own worker:
 *  1. the canonical integrator scenario (src/fixtures/determinism.ts), compared component by component;
 *  2. the model-2 mission replay (src/fixtures/model2-replay.ts) on the real ephemeris, compared by digest;
 *  3. the staged replay with a vehicle ascent (src/fixtures/staged-replay.ts), compared by digest and the ascent's bits.
 *
 * Machine-readable results for e2e/determinism.e2e.ts, always set, failure included, so a test
 * fails at once with the reason instead of waiting for a result that never comes:
 *  - body[data-result] "PASS" | "FAIL", body[data-error] (why, on a failure), body[data-ms] (worker time)
 *  - body[data-model2] JSON: Model2Result plus { verdict: "PASS" | "FAIL" }, or { verdict: "FAIL", error }
 *  - body[data-staged] JSON: StagedResult plus { verdict }, or { verdict: "FAIL", error }
 *  - body[data-core] JSON: CoreCheckResult plus { verdict }, or { verdict: "FAIL", error }
 */
import { EXPECTED_HEX, toHex } from '../fixtures/determinism';
import { DATA, DIGEST, MODEL } from '../fixtures/model2-replay';
import type { Model2Result } from './model2-worker';
import * as STAGED from '../fixtures/staged-replay';
import type { StagedResult } from './staged-worker';
import type { CheckResult } from './worker';
import type { CoreCheckResult } from './core-worker';

const NAMES = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'mass'];
const UNITS = ['m', 'm', 'm', 'm/s', 'm/s', 'm/s', 'kg'];

const $ = (id: string) => document.getElementById(id)!;
const pageStart = performance.now();

function hexToFloat(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let b = 0; b < 8; b++) view.setUint8(b, parseInt(hex.slice(2 * b, 2 * b + 2), 16));
  return view.getFloat64(0);
}

function cell(text: string, cls?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

let scenarioDone = false;
let model2Done = false;
let stagedDone = false;
let coreDone = false;

function updateTitle(): void {
  const r = document.body.dataset.result;
  const m = model2Done ? (JSON.parse(document.body.dataset.model2!) as { verdict: string }).verdict : undefined;
  const st = stagedDone ? (JSON.parse(document.body.dataset.staged!) as { verdict: string }).verdict : undefined;
  const co = coreDone ? (JSON.parse(document.body.dataset.core!) as { verdict: string }).verdict : undefined;
  const all = r && m && st && co ? (r === 'PASS' && m === 'PASS' && st === 'PASS' && co === 'PASS' ? 'PASS' : 'FAIL') : 'Running…';
  document.title = `${all}: sendit determinism check`;
}

function fail(message: string): void {
  if (scenarioDone) return;
  scenarioDone = true;
  const v = $('verdict');
  v.textContent = `FAIL: ${message}`;
  v.className = 'fail';
  document.body.dataset.error = message;
  document.body.dataset.ms = String(performance.now() - pageStart);
  document.body.dataset.result = 'FAIL';
  updateTitle();
}

function model2(r: (Model2Result & { verdict: 'PASS' | 'FAIL' }) | { verdict: 'FAIL'; error: string }): void {
  if (model2Done) return;
  model2Done = true;
  const v = $('m2-verdict');
  if ('error' in r) {
    v.textContent = `FAIL: ${r.error}`;
    $('m2-time').textContent = `${(performance.now() - pageStart).toFixed(0)} ms since page start`;
  } else {
    v.textContent = r.verdict;
    $('m2-digest').textContent = `model ${r.model}, data ${r.data}, digest ${r.digest}, ${r.outcome} (V8: model ${MODEL}, data ${DATA}, digest ${DIGEST})`;
    $('m2-time').textContent = `${r.totalMs.toFixed(0)} ms: checkpoint asset ${r.fetchMs.toFixed(0)} ms, ${r.chunks} chunk(s) ${r.chunkMs.toFixed(0)} ms, replay ${r.replayMs.toFixed(0)} ms`;
  }
  v.className = r.verdict === 'PASS' ? 'pass' : 'fail';
  document.body.dataset.model2 = JSON.stringify(r);
  updateTitle();
}

function staged(r: (StagedResult & { verdict: 'PASS' | 'FAIL' }) | { verdict: 'FAIL'; error: string }): void {
  if (stagedDone) return;
  stagedDone = true;
  const v = $('st-verdict');
  if ('error' in r) {
    v.textContent = `FAIL: ${r.error}`;
    $('st-time').textContent = `${(performance.now() - pageStart).toFixed(0)} ms since page start`;
  } else {
    v.textContent = r.verdict;
    const a = r.ascent;
    const w = STAGED.ASCENT_HEX;
    $('st-digest').textContent = `digest ${r.digest}, ${r.outcome}; ascent upper-stage propellant ${a.upperPropellant}, ascent delta-v ${a.deltaV}, total delta-v ${a.totalDeltaV} (V8: digest ${STAGED.DIGEST}; ${w.upperPropellant}, ${w.deltaV}, ${w.totalDeltaV})`;
    $('st-time').textContent = `${r.totalMs.toFixed(0)} ms: checkpoint asset ${r.fetchMs.toFixed(0)} ms, chunks ${r.chunkMs.toFixed(0)} ms, ascent and replay ${r.replayMs.toFixed(0)} ms`;
  }
  v.className = r.verdict === 'PASS' ? 'pass' : 'fail';
  document.body.dataset.staged = JSON.stringify(r);
  updateTitle();
}

function coreCheck(r: (CoreCheckResult & { verdict: 'PASS' | 'FAIL' }) | { verdict: 'FAIL'; error: string }): void {
  if (coreDone) return;
  coreDone = true;
  const v = $('core-verdict');
  if ('error' in r) {
    v.textContent = `FAIL: ${r.error}`;
  } else {
    const bad = r.cases.filter((c) => c.mismatch !== null || (c.pinned !== null && c.digest !== c.pinned)).length;
    v.textContent = r.verdict === 'PASS' ? `PASS (${r.cases.length} replays bit-identical)` : `FAIL (${bad} of ${r.cases.length} replays differ)`;
    const rows = $('core-rows');
    for (const c of r.cases) {
      const ok = c.mismatch === null && (c.pinned === null || c.digest === c.pinned);
      const tr = document.createElement('tr');
      const why = c.mismatch ?? (ok ? 'match' : `TypeScript digest ${c.digest}, V8 ${c.pinned}`);
      tr.append(cell(c.name), cell(c.digest), cell(c.coreDigest), cell(String(c.samples)), cell(ok ? (c.pinned ? 'match (and V8)' : 'match') : why, ok ? 'match' : 'mismatch'), cell(`${c.tsMs.toFixed(0)} / ${c.coreMs.toFixed(0)}`));
      rows.append(tr);
    }
    $('core-time').textContent = `${r.loadMs.toFixed(0)} ms (module ${(r.moduleBytes / 1024).toFixed(0)} KiB); all of it ${r.totalMs.toFixed(0)} ms`;
  }
  v.className = r.verdict === 'PASS' ? 'pass' : 'fail';
  document.body.dataset.core = JSON.stringify(r);
  updateTitle();
}

// Anything that escapes a handler fails what is still pending, with the reason.
const failAll = (message: string) => {
  fail(message);
  model2({ verdict: 'FAIL', error: message });
  staged({ verdict: 'FAIL', error: message });
  coreCheck({ verdict: 'FAIL', error: message });
};
addEventListener('error', (e) => failAll(`page error: ${e.message}`));
addEventListener('unhandledrejection', (e) => failAll(`unhandled rejection: ${String(e.reason)}`));

$('ua').textContent = navigator.userAgent;
updateTitle();

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onerror = (e) => fail(`worker error: ${e.message || 'could not load worker'}`);
worker.onmessageerror = () => fail('worker message could not be read');
worker.onmessage = (ev: MessageEvent<CheckResult | { error: string }>) => {
  if ('error' in ev.data) return fail(ev.data.error);
  const { y, ms } = ev.data;
  const hex = toHex(y);
  let allMatch = hex.length === EXPECTED_HEX.length;
  const rows = $('rows');
  for (let i = 0; i < EXPECTED_HEX.length; i++) {
    const ok = hex[i] === EXPECTED_HEX[i];
    allMatch &&= ok;
    const tr = document.createElement('tr');
    tr.append(cell(`${NAMES[i]} (${UNITS[i]})`), cell(hex[i] ?? '—'), cell(EXPECTED_HEX[i]));
    tr.append(cell(ok ? 'match' : 'MISMATCH', ok ? 'match' : 'mismatch'));
    let diff = '';
    if (!ok && hex[i] !== undefined) {
      const expected = hexToFloat(EXPECTED_HEX[i]);
      const d = y[i] - expected;
      diff = `${d.toExponential(3)} ${UNITS[i]} (rel ${(d / Math.abs(expected)).toExponential(2)})`;
    }
    tr.append(cell(diff));
    rows.append(tr);
  }
  scenarioDone = true;
  $('time').textContent = `${ms.toFixed(1)} ms`;
  const v = $('verdict');
  v.textContent = allMatch ? 'PASS' : 'FAIL';
  v.className = allMatch ? 'pass' : 'fail';
  if (!allMatch) document.body.dataset.error = 'final state differs from the V8 reference';
  document.body.dataset.ms = String(ms);
  document.body.dataset.result = v.textContent;
  updateTitle();
};
worker.postMessage(null);

const m2 = new Worker(new URL('./model2-worker.ts', import.meta.url), { type: 'module' });
const m2fail = (error: string) => model2({ verdict: 'FAIL', error });
m2.onerror = (e) => m2fail(`worker error: ${e.message || 'could not load worker'}`);
m2.onmessageerror = () => m2fail('worker message could not be read');
m2.onmessage = (ev: MessageEvent<Model2Result | { error: string }>) => {
  if ('error' in ev.data) return m2fail(ev.data.error);
  const r = ev.data;
  const ok = r.model === MODEL && r.data === DATA && r.digest === DIGEST && r.outcome === 'completed';
  model2({ ...r, verdict: ok ? 'PASS' : 'FAIL' });
};
m2.postMessage(null);

const st = new Worker(new URL('./staged-worker.ts', import.meta.url), { type: 'module' });
const stfail = (error: string) => staged({ verdict: 'FAIL', error });
st.onerror = (e) => stfail(`worker error: ${e.message || 'could not load worker'}`);
st.onmessageerror = () => stfail('worker message could not be read');
st.onmessage = (ev: MessageEvent<StagedResult | { error: string }>) => {
  if ('error' in ev.data) return stfail(ev.data.error);
  const r = ev.data;
  const w = STAGED.ASCENT_HEX;
  const ok = r.model === STAGED.MODEL && r.data === STAGED.DATA && r.digest === STAGED.DIGEST && r.outcome === 'completed' &&
    r.ascent.upperPropellant === w.upperPropellant && r.ascent.deltaV === w.deltaV && r.ascent.totalDeltaV === w.totalDeltaV;
  staged({ ...r, verdict: ok ? 'PASS' : 'FAIL' });
};
st.postMessage(null);

const co = new Worker(new URL('./core-worker.ts', import.meta.url), { type: 'module' });
const cofail = (error: string) => coreCheck({ verdict: 'FAIL', error });
co.onerror = (e) => cofail(`worker error: ${e.message || 'could not load worker'}`);
co.onmessageerror = () => cofail('worker message could not be read');
co.onmessage = (ev: MessageEvent<CoreCheckResult | { error: string }>) => {
  if ('error' in ev.data) return cofail(ev.data.error);
  const r = ev.data;
  const ok = r.cases.length > 0 && r.cases.every((c) => c.mismatch === null && (c.pinned === null || c.digest === c.pinned));
  coreCheck({ ...r, verdict: ok ? 'PASS' : 'FAIL' });
};
co.postMessage(null);
