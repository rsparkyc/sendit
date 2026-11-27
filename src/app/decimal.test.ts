import { describe, expect, it } from 'vitest';
import { parseDecimal } from './decimal';

describe('parseDecimal', () => {
  it('reads a point or a single decimal comma (iOS decimal pad in comma locales)', () => {
    expect(parseDecimal('3155.2')).toBe(3155.2);
    expect(parseDecimal('3155,2')).toBe(3155.2);
    expect(parseDecimal(' -0,5 ')).toBe(-0.5);
    expect(parseDecimal('42')).toBe(42);
  });
  it('does not guess at mixed or repeated separators', () => {
    expect(parseDecimal('1,000.5')).toBeNaN();
    expect(parseDecimal('1,2,3')).toBeNaN();
    expect(parseDecimal('abc')).toBeNaN();
  });
});
