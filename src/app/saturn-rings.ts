/**
 * Saturn's main rings as a radial profile, for display. SCHEMATIC: the ring
 * and gap boundaries are measured values (NASA NSSDC Saturnian Rings Fact
 * Sheet, https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html,
 * distances from Saturn's centre); the opacity and brightness of each ring are
 * single representative values (normal optical depth tau: C ~0.1, B 1-2.5,
 * Cassini Division ~0.1, A ~0.5), not an image of the rings. Fine structure
 * (ringlets, waves, Keeler gap) is deliberately not drawn rather than invented.
 */
import * as THREE from 'three';

interface Band {
  readonly from: number; // km
  readonly to: number; // km
  readonly tau: number;
  readonly bright: number;
}

const KM = 1000;

/** Ring regions, km from Saturn's centre (NSSDC). The D ring (tau ~1e-3) is too faint to draw. */
export const RING_BANDS: readonly Band[] = [
  { from: 74658, to: 92000, tau: 0.1, bright: 0.45 }, // C ring
  { from: 92000, to: 99000, tau: 1.0, bright: 0.85 }, // inner B ring
  { from: 99000, to: 117580, tau: 2.0, bright: 1.0 }, // B ring core and outer B
  { from: 117580, to: 122170, tau: 0.1, bright: 0.35 }, // Cassini Division
  { from: 122170, to: 133424, tau: 0.5, bright: 0.8 }, // A ring, inside the Encke gap
  { from: 133424, to: 133754, tau: 0, bright: 0 }, // Encke gap (325 km)
  { from: 133754, to: 136775, tau: 0.5, bright: 0.8 }, // A ring, outer
  { from: 140130, to: 140230, tau: 0.3, bright: 0.7 }, // F ring core (narrow)
];

export const RING_PROFILE = { inner: 74658 * KM, outer: 140400 * KM };

const COLOR = [0.86, 0.79, 0.66]; // pale tan (Cassini natural-colour views)

/** 1-D RGBA texture across [inner, outer]: rgb = colour * brightness, a = 1 - exp(-tau / cos 60deg). */
export function ringProfileTexture(n = 2048): THREE.DataTexture {
  const data = new Uint8Array(4 * n);
  const r0 = RING_PROFILE.inner / KM;
  const r1 = RING_PROFILE.outer / KM;
  for (let i = 0; i < n; i++) {
    const r = r0 + ((i + 0.5) / n) * (r1 - r0);
    const b = RING_BANDS.find((x) => r >= x.from && r < x.to);
    const a = b ? 1 - Math.exp(-b.tau * 2) : 0;
    const br = b ? b.bright : 0;
    data[4 * i] = Math.round(255 * COLOR[0] * br);
    data[4 * i + 1] = Math.round(255 * COLOR[1] * br);
    data[4 * i + 2] = Math.round(255 * COLOR[2] * br);
    data[4 * i + 3] = Math.round(255 * a);
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
