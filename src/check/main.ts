import { EXPECTED_HEX, toHex } from '../fixtures/determinism';
import type { CheckResult } from './worker';

const NAMES = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'mass'];
const UNITS = ['m', 'm', 'm', 'm/s', 'm/s', 'm/s', 'kg'];

const $ = (id: string) => document.getElementById(id)!;

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

function fail(message: string): void {
  const v = $('verdict');
  v.textContent = `FAIL: ${message}`;
  v.className = 'fail';
}

$('ua').textContent = navigator.userAgent;
document.title = 'Running… sendit determinism check';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onerror = (e) => fail(`worker error: ${e.message || 'could not load worker'}`);
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
  $('time').textContent = `${ms.toFixed(1)} ms`;
  const v = $('verdict');
  v.textContent = allMatch ? 'PASS' : 'FAIL';
  v.className = allMatch ? 'pass' : 'fail';
  document.title = `${v.textContent}: sendit determinism check`;
  document.body.dataset.result = v.textContent;
};
worker.postMessage(null);
