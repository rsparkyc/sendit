// Runs the Rust core as WebAssembly in Node: the parity suite against the
// generated fixtures, or the benchmark. No wasm-bindgen: the module's plain
// exports (core/src/wasm.rs) are called directly.
//
//   node core/scripts/run-wasm.mjs parity [module.wasm] [--simd]
//   node core/scripts/run-wasm.mjs bench  [module.wasm] [--simd]
//
// Default module: core/target/wasm/wasm32-unknown-unknown/release/sendit_core.wasm
// (build with core/scripts/build.sh). --simd enables the f64x2 positions() path
// (requires a module built with +simd128).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('..', import.meta.url));
const fx = (process.env.SENDIT_FIXTURES ?? core + 'fixtures/generated') + '/';
const [mode = 'parity', wasmArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const simd = process.argv.includes('--simd');
const wasmPath = wasmArg ?? core + 'target/wasm/wasm32-unknown-unknown/release/sendit_core.wasm';

let onStepCalls = 0;
let mem;
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
  env: {
    on_step: (t, yPtr) => {
      // A typical consumer: read the state (a view on WebAssembly memory) and keep going.
      onStepCalls++;
      const y = new Float64Array(mem.buffer, yPtr, 7);
      return y[6] > 0 ? 1 : 1;
    },
  },
});
const X = instance.exports;
mem = X.memory;

function put(bytes) {
  const p = X.alloc(bytes.length);
  new Uint8Array(X.memory.buffer, p, bytes.length).set(bytes);
  return p;
}
function report() {
  return new TextDecoder().decode(new Uint8Array(X.memory.buffer, X.report_ptr(), X.report_len()));
}
function loadWorld() {
  const w = readFileSync(fx + 'world.txt');
  X.set_world(put(w), w.length);
  const line = w.toString().split('\n').find((l) => l.startsWith('chunks '));
  const dv = new DataView(new ArrayBuffer(8));
  const num = (h) => {
    dv.setUint32(0, parseInt(h.slice(0, 8), 16));
    dv.setUint32(4, parseInt(h.slice(8), 16));
    return dv.getFloat64(0);
  };
  const toks = line.split(/\s+/).filter(Boolean).slice(1).map(num);
  const ks = toks.slice(1);
  for (const k of ks) {
    const b = readFileSync(`${fx}chunk_${k}.bin`);
    const p = put(b);
    X.add_chunk(k, p, b.length);
    X.dealloc(p, b.length);
  }
  if (simd) X.set_simd(1);
  return { text: w.toString(), num };
}

if (mode === 'parity') {
  loadWorld();
  const sections = [
    [0, 'dmath.txt'], [1, 'dop853.txt'], [2, 'gravity.txt'], [3, 'orientation.txt'], [4, 'ephem.txt'],
    [5, null], [6, 'deriv.txt'], [7, 'prop.txt'], [8, 'corrector.txt'], [9, 'deriv-rel.txt'],
  ];
  let bad = 0;
  for (const [id, file] of sections) {
    const b = file ? readFileSync(fx + file) : new Uint8Array(1);
    const p = put(b);
    const t = performance.now();
    const m = X.run_section(id, p, file ? b.length : 0);
    X.dealloc(p, b.length);
    console.log(`${report()}  [${(performance.now() - t).toFixed(0)} ms]`);
    if (m !== 0) bad++;
  }
  console.log(bad === 0 ? `wasm parity (${simd ? 'simd' : 'scalar'}): all sections bit-identical` : `wasm parity: ${bad} section(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Benchmark: the workloads of test/ephemeris-bench.test.ts.

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { median: q(0.5), min: s[0], max: s[s.length - 1], q1: q(0.25), q3: q(0.75) };
}
const fmt = (x, unit, d = 0) => `median ${x.median.toFixed(d)} ${unit} (IQR ${x.q1.toFixed(d)}..${x.q3.toFixed(d)}, range ${x.min.toFixed(d)}..${x.max.toFixed(d)})`;
function wall(fn, reps, warm = 2) {
  const out = [];
  for (let r = 0; r < warm + reps; r++) {
    const t0 = performance.now();
    fn();
    if (r >= warm) out.push(performance.now() - t0);
  }
  return stats(out);
}

const { text, num } = loadWorld();
const C = num(text.split('\n').find((l) => l.startsWith('layout ')).split(/\s+/)[4]);
let s = 12345;
const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
const random = Float64Array.from({ length: 20000 }, () => (-1 + 3 * rnd()) * C);
const seq = Float64Array.from({ length: 20000 }, (_, i) => 0.3 * C + Math.floor(i / 13) * 600 + ((i % 13) / 12) * 600);
const perCall = (times, fn, reps = 25, warm = 5) => {
  const out = [];
  for (let r = 0; r < warm + reps; r++) {
    const t0 = performance.now();
    fn(times);
    if (r >= warm) out.push(((performance.now() - t0) * 1e6) / times.length);
  }
  return stats(out);
};
const tp = X.alloc(8 * 20000);
const inMem = (times) => { new Float64Array(X.memory.buffer, tp, times.length).set(times); return times; };
console.log(`WebAssembly (${simd ? 'simd' : 'scalar'}) in Node ${process.version}`);
inMem(random);
console.log(`positions, random (loop in wasm):       ${fmt(perCall(random, (ts) => X.positions_many(tp, ts.length)), 'ns')}`);
console.log(`positions, random (one JS call each):   ${fmt(perCall(random, (ts) => { for (let i = 0; i < ts.length; i++) X.positions(ts[i]); }), 'ns')}`);
console.log(`evaluate pos+vel, random (loop in wasm): ${fmt(perCall(random, (ts) => X.evaluate_many(tp, ts.length)), 'ns')}`);
inMem(seq);
console.log(`positions, sequential (loop in wasm):   ${fmt(perCall(seq, (ts) => X.positions_many(tp, ts.length)), 'ns')}`);

// Propagation cases from prop.txt / corrector.txt.
function cases(file) {
  const out = [];
  for (const line of readFileSync(fx + file, 'utf8').split('\n')) {
    if (!line.startsWith('case ')) continue;
    const t = line.split(/\s+/);
    const name = t[1];
    const v = t.slice(3).map(num);
    const y0 = v.slice(0, 7);
    const [t0, t1, rtol, dry, nb] = v.slice(7, 12);
    out.push({ name, kind: t[2], y0, t0, t1, rtol, dry, burns: v.slice(12, 12 + 9 * nb), nb });
  }
  return out;
}
const yp = X.alloc(56);
const bp = X.alloc(8 * 9 * 4);
function prop(c, m) {
  new Float64Array(X.memory.buffer, yp, 7).set(c.y0);
  new Float64Array(X.memory.buffer, bp, c.burns.length).set(c.burns);
  if (X.propagate(yp, c.t0, c.t1, c.rtol, c.dry, bp, c.nb, m) !== 0) throw new Error(report());
}
const P = Object.fromEntries(cases('prop.txt').map((c) => [c.name, c]));
for (const name of ['leo30', 'helio1yr']) {
  const c = P[name];
  // The bench propagates without dryMass/onStep (propagate(eph, y0, 0, t1)).
  const b = { ...c, dry: 0, rtol: 1e-12 };
  const reps = name === 'leo30' ? 15 : 40;
  const none = wall(() => prop(b, 0), reps);
  onStepCalls = 0;
  const cb = wall(() => prop(b, 1), reps);
  const steps = new Float64Array(X.memory.buffer, X.result_ptr(), 10)[8];
  const buf = wall(() => { prop(b, 2); new Float64Array(X.memory.buffer, X.samples_ptr(), X.samples_len()).slice(); }, reps);
  console.log(`${name}: ${steps} steps\n  no callback                       ${fmt(none, 'ms', 1)}\n  JS callback per step (env.on_step) ${fmt(cb, 'ms', 1)}\n  samples buffered in wasm, 1 copy   ${fmt(buf, 'ms', 1)}`);
}
const corr = cases('corrector.txt');
const w = wall(() => { for (const c of corr) prop(c, 0); }, 5, 1);
console.log(`corrector workload: ${corr.length} propagations per run, ${fmt(w, 'ms')}`);
