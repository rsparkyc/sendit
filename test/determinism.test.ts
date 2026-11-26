import { expect, it } from 'vitest';
import { EXPECTED_HEX, runScenario, toHex } from '../src/fixtures/determinism';

it('canonical scenario reproduces the stored final state bit for bit', () => {
  const y = runScenario();
  expect(toHex(y)).toEqual(EXPECTED_HEX);
});
