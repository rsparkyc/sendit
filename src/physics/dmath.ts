/**
 * Deterministic elementary functions: sin, cos, sincos, atan, atan2.
 *
 * WHY: Math.sin, Math.atan2 etc. are not specified exactly by ECMAScript; V8,
 * SpiderMonkey and JavaScriptCore use different libm ports and can differ in
 * the last bit. Anything that turns a mission plan into a simulation state must
 * give bit-identical results in every browser, so it uses these instead.
 *
 * WHY THESE ARE BIT-REPRODUCIBLE: they are written only with operations that
 * IEEE 754 and ECMAScript define to be correctly rounded binary64 results
 * (+ - * /, comparisons, Math.abs, Math.floor), on constants written as
 * decimal literals that every engine parses to the same double. ECMAScript
 * has no fused multiply-add and no extended-precision intermediates: every
 * `a * b + c` is two separately rounded operations, and evaluation order is
 * fixed left to right by the language, so no engine or JIT may reassociate or
 * contract them. The same sequence of correctly rounded operations on the same
 * inputs therefore gives the same bits everywhere.
 *
 * Algorithms are those of fdlibm (Sun Microsystems, freely redistributable;
 * the basis of Java's StrictMath): Cody-Waite argument reduction by pi/2 with
 * pi/2 split into 33-bit pieces (exact products n*pio2_k), the
 * __kernel_sin/__kernel_cos minimax polynomials on [-pi/4, pi/4], and the
 * table-plus-polynomial atan. Measured accuracy (test/dmath.test.ts, against
 * Math.* in Node 22 / V8 which is within 1 ulp of correctly rounded):
 * worst case observed 1 ulp for sin and cos (|result| > 1e-3; ~1e-19 absolute
 * near their zeros), 1 ulp for atan and 1 ulp for atan2, over ~350k sin/cos
 * samples including dense ones at multiples of pi/2 up to |x| = 3100 and
 * random ones up to 8e5. Since Math.* is itself only faithful (<= 1 ulp),
 * the error against the true value is at most ~2 ulp.
 *
 * RANGE: sin/cos accept |x| <= 2^19 * pi/2 (~8.2e5 rad), where the reduction
 * keeps full precision (the multiple n fits in 20 bits, so n*pio2_1 is exact).
 * Larger arguments throw: callers reduce angles (e.g. a rotation angle in
 * turns) before converting to radians, which is more accurate anyway.
 */

const INV_PIO2 = 6.36619772367581382433e-1; // 2/pi
const PIO2_1 = 1.57079632673412561417e0; // first 33 bits of pi/2
const PIO2_1T = 6.07710050650619224932e-11; // pi/2 - PIO2_1
const PIO2_2 = 6.07710050630396597660e-11; // second 33 bits
const PIO2_2T = 2.02226624879595063154e-21; // pi/2 - (PIO2_1 + PIO2_2)
const PIO2_3 = 2.02226624871116645580e-21; // third 33 bits
const PIO2_3T = 8.47842766036889956997e-32; // pi/2 - (PIO2_1 + PIO2_2 + PIO2_3)
const PIO4 = 7.85398163397448278999e-1;
const MAX_REDUCE = 823549.6654067; // 2^19 * pi/2

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

export const PI = 3.141592653589793;
export const HALF_PI = 1.5707963267948966;
export const DEG = PI / 180;

/** sin(x + y) for |x + y| <= pi/4, y a tail with |y| <~ ulp(x). */
function kSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

/** cos(x + y) for |x + y| <= pi/4. */
function kCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const one = 1 - hz;
  return one + (((1 - one) - hz) + (z * r - x * y));
}

// Reduction result, reused (single-threaded JS; never escapes this module).
let redHi = 0;
let redLo = 0;

/** x = n*pi/2 + (redHi + redLo); returns n mod 4. */
function reduce(x: number): number {
  const ax = Math.abs(x);
  if (ax <= PIO4) {
    redHi = x;
    redLo = 0;
    return 0;
  }
  if (!(ax <= MAX_REDUCE)) {
    if (ax !== ax) {
      redHi = NaN;
      redLo = 0;
      return 0;
    }
    throw new RangeError(`dmath: argument ${x} outside the supported range |x| <= 2^19*pi/2`);
  }
  // Round to nearest integer, ties away from zero, using floor only.
  const fn = x >= 0 ? Math.floor(x * INV_PIO2 + 0.5) : -Math.floor(-x * INV_PIO2 + 0.5);
  // Three-stage Cody-Waite: each fn*PIO2_k is exact (fn < 2^20, PIO2_k has 33 bits).
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  let t = r;
  w = fn * PIO2_2;
  r = t - w;
  w = fn * PIO2_2T - ((t - r) - w);
  t = r;
  w = fn * PIO2_3;
  r = t - w;
  w = fn * PIO2_3T - ((t - r) - w);
  const y0 = r - w;
  redHi = y0;
  redLo = (r - y0) - w;
  const n = fn - 4 * Math.floor(fn / 4);
  return n;
}

export function sin(x: number): number {
  const n = reduce(x);
  const a = redHi;
  const b = redLo;
  switch (n) {
    case 0:
      return kSin(a, b);
    case 1:
      return kCos(a, b);
    case 2:
      return -kSin(a, b);
    default:
      return -kCos(a, b);
  }
}

export function cos(x: number): number {
  const n = reduce(x);
  const a = redHi;
  const b = redLo;
  switch (n) {
    case 0:
      return kCos(a, b);
    case 1:
      return -kSin(a, b);
    case 2:
      return -kCos(a, b);
    default:
      return kSin(a, b);
  }
}

/** [sin x, cos x] with one reduction. Identical bits to sin(x), cos(x). */
export function sincos(x: number): [number, number] {
  const n = reduce(x);
  const s = kSin(redHi, redLo);
  const c = kCos(redHi, redLo);
  switch (n) {
    case 0:
      return [s, c];
    case 1:
      return [c, -s];
    case 2:
      return [-s, -c];
    default:
      return [-c, s];
  }
}

/**
 * sin x into out[o], cos x into out[o + 1], with one reduction and no
 * allocation (hot paths). Identical bits to sincos(x), sin(x), cos(x).
 */
export function sincosInto(x: number, out: Float64Array, o: number): void {
  const n = reduce(x);
  const s = kSin(redHi, redLo);
  const c = kCos(redHi, redLo);
  if (n === 0) {
    out[o] = s;
    out[o + 1] = c;
  } else if (n === 1) {
    out[o] = c;
    out[o + 1] = -s;
  } else if (n === 2) {
    out[o] = -s;
    out[o + 1] = -c;
  } else {
    out[o] = -c;
    out[o + 1] = s;
  }
}

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

export function atan(x: number): number {
  if (x !== x) return x;
  const neg = x < 0;
  let ax = neg ? -x : x;
  if (ax >= 1.8014398509481984e16) return neg ? -ATAN_HI[3] - ATAN_LO[3] : ATAN_HI[3] + ATAN_LO[3];
  let id: number;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x; // atan(x) = x to within rounding
    id = -1;
  } else if (ax < 0.6875) {
    id = 0;
    ax = (2 * ax - 1) / (2 + ax);
  } else if (ax < 1.1875) {
    id = 1;
    ax = (ax - 1) / (ax + 1);
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1 / ax;
  }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) {
    const r = ax - ax * (s1 + s2);
    return neg ? -r : r;
  }
  const r = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r : r;
}

const PI_LO = 1.2246467991473531772e-16;

/**
 * atan2(y, x) in (-pi, pi], the angle of the point (x, y). Follows fdlibm's
 * special cases for zeros (signed) and infinities.
 */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  const yNeg = y < 0 || (y === 0 && 1 / y < 0);
  if (y === 0) {
    const xNeg = x < 0 || (x === 0 && 1 / x < 0);
    if (!xNeg) return y; // +-0
    return yNeg ? -PI : PI;
  }
  if (x === 0) return yNeg ? -HALF_PI : HALF_PI;
  const xInf = x === Infinity || x === -Infinity;
  const yInf = y === Infinity || y === -Infinity;
  if (xInf) {
    if (yInf) {
      const a = x > 0 ? PIO4 : 3 * PIO4;
      return yNeg ? -a : a;
    }
    const a = x > 0 ? 0 : PI;
    return yNeg ? -a : a;
  }
  if (yInf) return yNeg ? -HALF_PI : HALF_PI;
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  let z: number;
  if (ay > 1.8014398509481984e16 * ax) {
    return yNeg ? -HALF_PI : HALF_PI; // |y/x| > 2^54: +-pi/2 in either half-plane
  } else if (x < 0 && ay < 5.551115123125783e-17 * ax) {
    z = 0; // |y/x| < 2^-54, x < 0: result is +-pi
  } else {
    z = atan(ay / ax);
  }
  if (x > 0) return yNeg ? -z : z;
  const r = PI - (z - PI_LO);
  return yNeg ? -r : r;
}

/** Degrees to radians (one correctly rounded multiplication). */
export function rad(deg: number): number {
  return deg * DEG;
}
