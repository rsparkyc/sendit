/**
 * Orbit camera around a focus point, in frame coordinates (float64, metres).
 * Zoom is exponential in distance and smoothed, so one wheel gesture feels the
 * same in low orbit and at 30 AU. Switching focus glides from the old point.
 * Frame z is "up" (ecliptic north, or the rotating frame's orbit normal).
 */
export const MIN_DISTANCE = 1; // m
export const MAX_DISTANCE = 2e14; // m, ~1300 AU

export class OrbitCamera {
  azimuth = -Math.PI / 2;
  elevation = 0.45;
  private logTarget = Math.log(5e7);
  private logCurrent = this.logTarget;
  private readonly glide = new Float64Array(3);
  private readonly lastFocus = new Float64Array(3);
  private hasFocus = false;
  /** Effective look-at point and camera position after the last update. */
  readonly target = new Float64Array(3);
  readonly position = new Float64Array(3);

  get distance(): number {
    return Math.exp(this.logCurrent);
  }

  get targetDistance(): number {
    return Math.exp(this.logTarget);
  }

  setDistance(d: number, immediate = false): void {
    this.logTarget = Math.log(Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, d)));
    if (immediate) this.logCurrent = this.logTarget;
  }

  zoom(factor: number): void {
    this.setDistance(this.targetDistance * factor);
  }

  rotate(dAz: number, dEl: number): void {
    this.azimuth += dAz;
    this.elevation = Math.max(-1.55, Math.min(1.55, this.elevation + dEl));
  }

  /** Call when the focus object changes: the view glides from where it was looking. */
  refocus(): void {
    if (!this.hasFocus) return;
    for (let k = 0; k < 3; k++) this.glide[k] = this.target[k];
    this.glideFrom = true;
  }
  private glideFrom = false;

  /** Call when the frame changes: positions are not comparable, so jump. */
  reset(): void {
    this.hasFocus = false;
    this.glide.fill(0);
  }

  /** Advance smoothing by dt seconds and place the camera around `focus`; minDist keeps it outside the body. */
  update(dt: number, focus: ArrayLike<number>, minDist: number): void {
    const lmin = Math.log(Math.max(minDist, MIN_DISTANCE));
    if (this.logTarget < lmin) this.logTarget = lmin;
    const a = 1 - Math.exp(-dt * 12);
    this.logCurrent += (this.logTarget - this.logCurrent) * a;
    if (this.logCurrent < lmin) this.logCurrent = lmin;
    if (this.glideFrom) {
      // Store the glide as an offset from the new focus so it tracks a moving body.
      for (let k = 0; k < 3; k++) this.glide[k] -= focus[k];
      this.glideFrom = false;
    }
    const g = Math.exp(-dt * 6);
    for (let k = 0; k < 3; k++) {
      this.glide[k] *= g;
      this.target[k] = focus[k] + this.glide[k];
      this.lastFocus[k] = focus[k];
    }
    this.hasFocus = true;
    const d = this.distance;
    const ce = Math.cos(this.elevation);
    this.position[0] = this.target[0] + d * ce * Math.cos(this.azimuth);
    this.position[1] = this.target[1] + d * ce * Math.sin(this.azimuth);
    this.position[2] = this.target[2] + d * Math.sin(this.elevation);
  }
}
