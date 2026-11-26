import { describe, expect, it } from 'vitest';
import { Dop853, componentwiseScale } from '../src/physics/dop853';

describe('Dop853 non-finite states', () => {
  it('throws instead of looping when the state is NaN', () => {
    const integ = new Dop853(2, (_t, y, out) => { out[0] = y[1]; out[1] = -y[0]; }, componentwiseScale(1e-10, 1e-12));
    integ.reset(0, [NaN, 1], 0.1);
    expect(() => integ.step(1)).toThrow(/non-finite/);
  });
  it('throws when the derivative turns infinite in a stage with zero output weight', () => {
    // Stage 1 (c = 0.0526) has zero weight in B, E3 and E5; a dense sum would
    // carry 0 * Inf = NaN, the sparse sum must still fail loudly.
    const integ = new Dop853(1, (t, _y, out) => { out[0] = t > 0 && t < 0.06 ? Infinity : 1; }, componentwiseScale(1e-10, 1e-12));
    integ.reset(0, [0], 1);
    expect(() => integ.step(1)).toThrow(/non-finite/);
  });
});
