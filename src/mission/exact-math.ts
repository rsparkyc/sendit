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

/**
 * e^x for finite x (|x| <= 700), accurate to a few ulp, from exactly-defined
 * operations only (fixed order and term count, like exactLn): x = k ln2 + r
 * with k = floor(x / ln2 + 1/2) (ln2 split in two parts so k ln2 is
 * subtracted without rounding), |r| <= 0.35, Taylor series of e^r to r^20
 * (Horner), then the exact scaling by 2^k in steps of 2^+-32 and 2.
 * Used by the ascent model (ascent.ts) for the rocket equation solved for
 * mass and the atmosphere's density.
 */
export function exactExp(x: number): number {
  if (!(x >= -700 && x <= 700)) throw new Error(`exactExp: argument must be in [-700, 700], got ${x}`);
  const k = Math.floor(x / LN2 + 0.5);
  // LN2_HI has 32 significant bits, so k * LN2_HI is exact for |k| < 2^20.
  const r = x - k * 0.6931471803691238 - k * 1.9082149292705877e-10;
  let s = 1 / 2432902008176640000; // 1/20!
  for (let n = 19; n >= 1; n--) s = s * (r / n) + 0;
  // Horner on sum r^n/n!: s_n = 1/n! + r s_{n+1}.
  let t = 1 / 2432902008176640000;
  let f = 2432902008176640000;
  for (let n = 19; n >= 0; n--) { f = f / (n + 1); t = 1 / f + r * t; }
  void s;
  let y = t;
  let e = k;
  while (e >= 32) { y *= 4294967296; e -= 32; }
  while (e <= -32) { y *= 2.3283064365386963e-10; e += 32; }
  while (e > 0) { y *= 2; e--; }
  while (e < 0) { y *= 0.5; e++; }
  return y;
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
