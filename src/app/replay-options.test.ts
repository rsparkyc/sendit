import { expect, it } from 'vitest';
import { sandboxSpheres } from './replay-options';
import { f64Hex } from './staged-replay-hex';

// The sandbox sphere-of-influence radii are replay inputs (sphere enter/exit
// event times, hence the digest). They are currently computed with Math.hypot
// and Math.pow, which ECMAScript does not define bit-exactly; these are the V8
// bits. An exact formulation (sqrt of the written-out sum, exactExp(0.4 *
// exactLn(m/M))) differs from these by 1-3 ulp for most bodies, so switching
// is a deliberate model decision, not a refactor. This pin catches either.
const PINNED: [string, string][] = [
  ['mercury', '41a025ddd2ae1a97'], ['venus', '41c2498c4d3eac5b'], ['earth', '41cb18e15e7fc885'], ['moon', '419085266882f040'],
  ['mars', '41bf6a0679364e5b'], ['jupiter', '42256c3abe36229b'], ['saturn', '422875ba609fa30a'], ['uranus', '422906c052fe2c79'],
  ['neptune', '423435b62ff9b5fb'], ['pluto', '41e1f225aafdcf58'], ['io', '415dc82e28287042'], ['europa', '416260a5d5518dd8'],
  ['ganymede', '417738407f2f8f42'], ['callisto', '4181f53d68f199f7'], ['tethys', '4132818f7129157e'], ['dione', '413dc0216521712f'],
  ['rhea', '414c1039f7660c71'], ['titan', '418539d54d39c496'], ['iapetus', '4176025a801013d4'], ['enceladus', '411da1c75146df71'],
  ['ariel', '4140e0bc878e5702'], ['umbriel', '4147b35c44ffdd6f'], ['titania', '415c8164cb7f9276'], ['oberon', '4162c761f2146127'],
  ['miranda', '411b79bb88ace698'], ['triton', '4166d2951b2ac3a2'], ['charon', '41601dc9a732b8b6'],
];

it('pins the sandbox sphere-of-influence radii bit for bit', () => {
  expect(sandboxSpheres().map((s) => [s.body, f64Hex(s.radius)])).toEqual(PINNED);
});
