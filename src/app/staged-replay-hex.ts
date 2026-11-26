/** IEEE-754 binary64 bits of x as 16 hex digits (big-endian), for bit-exact comparisons across engines. */
export function f64Hex(x: number): string {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString(16).padStart(16, '0');
}
