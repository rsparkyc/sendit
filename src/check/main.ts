/**
 * Cross-engine determinism check page. Two independent checks, each in its own worker:
 *  1. the canonical integrator scenario (src/fixtures/determinism.ts), compared component by component;
 *  2. the model-2 mission replay (src/fixtures/model2-replay.ts) on the real ephemeris, compared by digest.
 *
 * Machine-readable results for e2e/determinism.e2e.ts, always set, failure included, so a test
 * fails at once with the reason instead of waiting for a result that never comes:
 *  - body[data-result] "PASS" | "FAIL", body[data-error] (why, on a failure), body[data-ms] (worker time)
 *  - body[data-model2] JSON: Model2Result plus { verdict: "PASS" | "FAIL" }, or { verdict: "FAIL", error }
 */
import { EXPECTED_HEX, toHex } from '../fixtures/determinism';
import { DATA, DIGEST, MODEL } from '../fixtures/model2-replay';
import type { Model2Result } from './model2-worker';
import type { CheckResult } from './worker';

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

function updateTitle(): void {
  const r = document.body.dataset.result;
  const m = model2Done ? (JSON.parse(document.body.dataset.model2!) as { verdict: string }).verdict : undefined;
  const all = r && m ? (r === 'PASS' && m === 'PASS' ? 'PASS' : 'FAIL') : 'Running…';
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

// Anything that escapes a handler fails what is still pending, with the reason.
const failAll = (message: string) => {
  fail(message);
  model2({ verdict: 'FAIL', error: message });
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
