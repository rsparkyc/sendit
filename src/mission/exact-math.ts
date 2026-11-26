/**
 * Deterministic helpers the mission layer needs that src/physics/dmath.ts does
 * not provide: natural log and a 64-bit hash. (Trig comes from dmath.ts.)
 *
 * DETERMINISM: these run during replay and scoring, so they use only
 * operations IEEE-754 and ECMAScript define exactly (+ - * /, Math.sqrt,
 * Math.abs, Math.floor, comparisons, Math.imul and 32-bit integer ops) on
 * decimal literals. Fixed operation order, fixed term counts: same bits in
 * every engine.
 */

const LN2 = 0.6931471805599453;
const SQRT2 = 1.4142135623730951;

/**
 * ln(x) for finite x > 0, accurate to a few ulp. Reduces x = m * 2^e with m in
 * [sqrt(1/2), sqrt(2)) by exact scaling, then ln m = 2 atanh(z),
 * z = (m-1)/(m+1), |z| < 0.172, summed to z^41 (terms below 1e-31).
 */
export function exactLn(x: number): number {
  if (!(x > 0) || x === Infinity) throw new Error(`exactLn: argument must be finite and positive, got ${x}`);
  let e = 0;
  let m = x;
  // Exact power-of-two scaling (no rounding: only the exponent changes).
  while (m >= 4294967296) { m *= 2.3283064365386963e-10; e += 32; }
  while (m < 2.3283064365386963e-10) { m *= 4294967296; e -= 32; }
  while (m >= SQRT2) { m *= 0.5; e += 1; }
  while (m < SQRT2 / 2) { m *= 2; e -= 1; }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  // Horner on sum_{k=0}^{20} z^(2k) / (2k+1).
  let s = 1 / 41;
  for (let k = 19; k >= 0; k--) s = 1 / (2 * k + 1) + z2 * s;
  return e * LN2 + 2 * z * s;
}

/** Incremental 64-bit hash (two independent 32-bit FNV-1a-style lanes) over float64s, ints and strings. */
export class Hasher {
  private a = 0x811c9dc5 | 0;
  private b = 0x9747b28c | 0;
  private readonly view = new DataView(new ArrayBuffer(8));

  byte(v: number): this {
    this.a = Math.imul(this.a ^ (v & 0xff), 0x01000193);
    this.b = Math.imul(this.b ^ (v & 0xff), 0x5bd1e995);
    this.b ^= this.b >>> 15;
    return this;
  }

  f64(v: number): this {
    this.view.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
    return this;
  }

  u32(v: number): this {
    for (let i = 0; i < 4; i++) this.byte((v >>> (8 * i)) & 0xff);
    return this;
  }

  str(s: string): this {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 0xff).byte(c >>> 8);
    }
    return this;
  }

  /** 16 lowercase hex digits. */
  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }

  /** First lane as an unsigned 32-bit integer. */
  u32Value(): number {
    return this.a >>> 0;
  }
}
