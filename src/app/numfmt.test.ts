import { describe, expect, it } from 'vitest';
import { fmtDv, fmtDvDelta, fmtDvFine, fmtMass, siteName, siteShort, tidyDetail } from './numfmt';

describe('numfmt', () => {
  it('delta-v: whole m/s for limits, 0.1 for a burn, signed differences', () => {
    expect(`Use at most ${fmtDv(12490.0)}`).toBe('Use at most 12,490 m/s');
    expect(fmtDvFine(3167.24)).toBe('3,167.2 m/s');
    expect(fmtDvDelta(141.6)).toBe('+142 m/s');
    expect(fmtDvDelta(-35.2)).toBe('−35 m/s');
    expect(fmtDvDelta(0.3)).toBe('±0 m/s');
  });
  it('mass', () => {
    expect(fmtMass(8450.4)).toBe('8,450 kg');
    expect(fmtMass(549_100)).toBe('549.1 t');
  });
  it('detail strings lose false precision but keep dates, times and small numbers', () => {
    expect(tidyDetail('used 12143.0 of 12490 m/s (ascent 8975.8 + flight 3167.2)')).toBe('used 12,143 of 12,490 m/s (ascent 8,976 + flight 3,167)');
    expect(tidyDetail('took 7.00 of 7.0 days')).toBe('took 7.00 of 7.0 days');
    expect(tidyDetail('closest approach 339,070 km alt')).toBe('closest approach 339,070 km alt');
    expect(tidyDetail('at 2027-01-10 12:09')).toBe('at 2027-01-10 12:09');
  });
  it('site names: no cut parenthesis', () => {
    expect(siteName('Equatorial reference site (0 N, 0 E, no range limits)')).toBe('Equatorial reference site');
    expect(siteShort('Equatorial reference site (0 N, 0 E, no range limits)')).toBe('Equatorial reference site');
    expect(siteShort('Cape Canaveral SFS SLC-40, Florida, USA')).toBe('Cape Canaveral');
    expect(siteName('Guiana Space Centre ELA-3, Kourou, French Guiana')).toBe('Guiana Space Centre ELA-3');
  });
});
