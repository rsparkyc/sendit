/**
 * The ascent model against published payloads (fixture with citations:
 * test/fixtures/launch-performance.json). Tolerances (stated, and what the
 * model is claimed to do):
 *  - absolute payload within -30 % / +35 % of the published figure per point
 *    (secondary sources, approximate stage data, one set of constants for all
 *    vehicles);
 *  - trends (ratios of two payloads: inclination, site, altitude, LEO vs GTO)
 *    within 8 % of the published ratio for inclination, site and altitude;
 *    GTO/LEO ratios within 30 % (known misfit: they depend on the upper
 *    stage and on whether the LEO figure is a structural limit, which the
 *    model does not know; see the README).
 */
import { describe, expect, it } from 'vitest';
import data from './fixtures/launch-performance.json';
import { payload, perigeeBurn } from './helpers/payload';
import { vehicleSpec } from '../src/mission/vehicles';

const sites = data.sites as Record<string, { latDeg: number }>;

describe('ascent model vs published performance', () => {
  const model = new Map<string, number>();
  for (const p of data.points) {
    const h = p.altitudeKm * 1e3;
    model.set(p.id, payload(vehicleSpec(p.vehicle), { latDeg: sites[p.site].latDeg, incDeg: p.incDeg, altitudeM: h, afterDv: p.orbit === 'gto' ? perigeeBurn(h, 35786e3) : undefined }));
  }

  it('reproduces payloads within the stated tolerance', () => {
    const rows = data.points.map((p) => `${p.id.padEnd(20)} ${String(p.payloadKg).padStart(6)} ${String(Math.round(model.get(p.id)!)).padStart(6)}  ${(model.get(p.id)! / p.payloadKg).toFixed(3)}`);
    console.log(`point                published  model  ratio\n${rows.join('\n')}`);
    for (const p of data.points) {
      const r = model.get(p.id)! / p.payloadKg;
      expect(r, p.id).toBeGreaterThan(0.7);
      expect(r, p.id).toBeLessThan(1.35);
    }
  });

  it('reproduces how payload falls with inclination and altitude and differs between sites', () => {
    const val = (id: string) => data.points.find((p) => p.id === id)!.payloadKg;
    const rows: string[] = [];
    for (const t of data.trends) {
      const pub = val(t.num) / val(t.den);
      const mod = model.get(t.num)! / model.get(t.den)!;
      rows.push(`${t.id.padEnd(50)} ${pub.toFixed(3)} ${mod.toFixed(3)} ${(mod / pub).toFixed(3)}`);
    }
    console.log(`trend                                              published model ratio\n${rows.join('\n')}`);
    for (const t of data.trends) {
      const pub = val(t.num) / val(t.den);
      const mod = model.get(t.num)! / model.get(t.den)!;
      const tol = t.id.includes('GTO/LEO') ? 0.3 : 0.08;
      expect(Math.abs(mod / pub - 1), t.id).toBeLessThan(tol);
    }
  });
});
