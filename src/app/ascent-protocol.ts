/** Messages to and from ascent-worker.ts (launch charts). */
import type { Spacecraft } from './mission-layer';

export interface AscentJob {
  id: number;
  kind: 'alt' | 'az';
  stages: readonly Spacecraft[];
  site: string;
  time: number;
  azimuthDeg: number;
  altitudeM: number;
  /** Values of the swept parameter (m for 'alt', deg for 'az'). */
  xs: number[];
}

export interface AscentPoint {
  type: 'point';
  id: number;
  kind: 'alt' | 'az';
  i: number;
  x: number;
  ok: boolean;
  /** Upper-stage delta-v left at insertion (everything above as payload), m/s. */
  dv: number;
  /** Upper-stage propellant left at insertion, kg. */
  prop: number;
  stage: number;
  reason: string;
  ms: number;
}

export type FromAscent = AscentPoint | { type: 'done'; id: number; kind: 'alt' | 'az'; ms: number; n: number };
