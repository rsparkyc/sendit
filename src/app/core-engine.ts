/**
 * The Rust core (core/, built to WebAssembly) as a replay engine: the same
 * call as mission-layer.ts replayWithSamples with replay-options.ts
 * replayOptions, computed bit for bit the same way (core/README.md has the
 * proof and the rules that keep it). No DOM: runs in a worker, a page or Node.
 *
 * Not used by the game unless the feature flag (core-flag.ts) is on; the
 * module is fetched only then. The wasm file is built by
 * core/scripts/build-web.sh into public/core/ (not checked in).
 *
 * Memory protocol (core/src/wasm.rs): alloc, copy bytes in, call with
 * (pointer, length), read results from exported buffers, dealloc.
 */
import { encodePlan, type MissionPlan } from './mission-layer';

export { CORE_WASM_URL } from './core-flag';

export interface CoreReplay {
  outcome: string;
  digest: string;
  steps: number;
  finalT: number;
  finalState: number[];
  reason: string;
  /** REPLAY_SAMPLE_STRIDE numbers per sample, as replayWithSamples. */
  samples: Float64Array;
}

interface Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  add_file(np: number, nl: number, p: number, l: number): void;
  report_ptr(): number;
  report_len(): number;
  engine_new(): number;
  engine_add_chunk(k: number, p: number, l: number): void;
  engine_has_chunk(k: number): number;
  engine_replay(p: number, l: number): number;
  engine_samples_ptr(): number;
  engine_samples_len(): number;
}

const dv = new DataView(new ArrayBuffer(8));
function fromHex(h: string): number {
  dv.setUint32(0, parseInt(h.slice(0, 8), 16));
  dv.setUint32(4, parseInt(h.slice(8, 16), 16));
  return dv.getFloat64(0);
}

/** Compile the module from a URL (streaming where the engine can) or from bytes. */
export async function compileCore(src: string | BufferSource): Promise<WebAssembly.Module> {
  if (typeof src !== 'string') return WebAssembly.compile(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`core module: HTTP ${res.status} for ${src}`);
  if (typeof WebAssembly.compileStreaming === 'function' && res.headers.get('content-type')?.includes('application/wasm')) {
    return WebAssembly.compileStreaming(res);
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

export class CoreEngine {
  private constructor(private readonly x: Exports) {}

  /**
   * An engine instance over the core's built-in world. `checkpoints`: the
   * checkpoint asset's bytes (chunks are then built from the nearest
   * checkpoint, as ReplayEphemeris does); chunks can also be handed in.
   */
  static async create(module: WebAssembly.Module, checkpoints: Uint8Array | null): Promise<CoreEngine> {
    // env.on_step is only used by the core's benchmark; the engine never calls it.
    const instance = await WebAssembly.instantiate(module, { env: { on_step: () => 1 } });
    const e = new CoreEngine(instance.exports as unknown as Exports);
    if (checkpoints) e.addFile('checkpoints-1950-2100.bin', checkpoints);
    if (e.x.engine_new() !== 0) throw new Error(`core engine: ${e.report()}`);
    return e;
  }

  private put(b: Uint8Array): number {
    const p = this.x.alloc(b.length);
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    return p;
  }

  private report(): string {
    return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.report_ptr(), this.x.report_len()));
  }

  private addFile(name: string, b: Uint8Array): void {
    const n = new TextEncoder().encode(name);
    const np = this.put(n);
    const p = this.put(b);
    this.x.add_file(np, n.length, p, b.length);
    this.x.dealloc(np, n.length);
    this.x.dealloc(p, b.length);
  }

  has(k: number): boolean {
    return this.x.engine_has_chunk(k) !== 0;
  }

  /** Install chunk k (coefficients built by the TypeScript or elsewhere; bit-identical). */
  addChunk(k: number, coeffs: Float64Array): void {
    if (this.has(k)) return;
    const b = new Uint8Array(coeffs.buffer, coeffs.byteOffset, coeffs.byteLength);
    const p = this.put(b);
    this.x.engine_add_chunk(k, p, b.length);
    this.x.dealloc(p, b.length);
  }

  /** replayWithSamples(plan, world, replayOptions(missionById(missionId)?.def ?? null), perStep). */
  replay(plan: MissionPlan, missionId: string, perStep = 12): CoreReplay {
    const input = new TextEncoder().encode(`${missionId}\n${perStep}\n${encodePlan(plan)}`);
    const p = this.put(input);
    const code = this.x.engine_replay(p, input.length);
    this.x.dealloc(p, input.length);
    const rep = this.report();
    if (code !== 0) throw new Error(`core engine: plan did not decode: ${rep}`);
    const [outcome, digest, steps, finalT, finalState, ...reason] = rep.split('\n');
    const n = this.x.engine_samples_len();
    // Copy out: the view is invalidated by the next call (or memory growth).
    const samples = new Float64Array(this.x.memory.buffer, this.x.engine_samples_ptr(), n).slice();
    return {
      outcome,
      digest,
      steps: Number(steps),
      finalT: fromHex(finalT),
      finalState: finalState ? finalState.split(',').map(fromHex) : [],
      reason: reason.join('\n'),
      samples,
    };
  }
}

/**
 * Compare a core replay with the TypeScript's (digest, outcome, steps, final
 * time and state, every sample bit for bit). Returns null when identical, or
 * the first difference.
 */
export function compareReplays(
  ts: { result: { outcome: string; digest: string; steps: number; finalT: number; finalState: readonly number[] }; samples: Float64Array },
  core: CoreReplay,
): string | null {
  const r = ts.result;
  if (r.outcome !== core.outcome) return `outcome ${core.outcome}, TypeScript ${r.outcome}`;
  if (r.digest !== core.digest) return `digest ${core.digest}, TypeScript ${r.digest}`;
  if (r.steps !== core.steps) return `steps ${core.steps}, TypeScript ${r.steps}`;
  if (!Object.is(r.finalT, core.finalT)) return `final t ${core.finalT}, TypeScript ${r.finalT}`;
  if (r.finalState.length !== core.finalState.length) return `final state length ${core.finalState.length}, TypeScript ${r.finalState.length}`;
  for (let i = 0; i < r.finalState.length; i++) if (!Object.is(r.finalState[i], core.finalState[i])) return `final state [${i}] ${core.finalState[i]}, TypeScript ${r.finalState[i]}`;
  const a = new Uint32Array(ts.samples.buffer, ts.samples.byteOffset, ts.samples.length * 2);
  const b = new Uint32Array(core.samples.buffer, core.samples.byteOffset, core.samples.length * 2);
  if (a.length !== b.length) return `${core.samples.length} sample values, TypeScript ${ts.samples.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `sample value ${i >> 1} differs (${core.samples[i >> 1]} vs TypeScript ${ts.samples[i >> 1]})`;
  return null;
}
