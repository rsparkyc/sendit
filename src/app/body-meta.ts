/**
 * Display metadata derived from body data: parent body (for orbit periods and
 * label priority), orbital period, colour. Pure; works for any body list, so
 * new moons need no code here (a colour entry is optional).
 */

export interface BodyLike {
  readonly id: string;
  readonly gm: number;
  readonly radius: number;
  /** Barycentric state at some epoch: x y z vx vy vz (m, m/s). */
  readonly state0: readonly number[];
}

export interface BodyMeta {
  /** Index of the body it orbits, or -1 for the most massive body (the Sun). */
  readonly parent: number;
  /** Osculating period about the parent, s (Infinity for the root or unbound). */
  readonly period: number;
  readonly color: string;
}

const COLORS: Readonly<Record<string, string>> = {
  sun: '#ffd27a',
  mercury: '#a9a39b',
  venus: '#e6cf9a',
  earth: '#4f8fe0',
  moon: '#b9b9b9',
  mars: '#d0694a',
  jupiter: '#d8b48a',
  saturn: '#e3d09a',
  uranus: '#9fd8de',
  neptune: '#5d7fe0',
  pluto: '#c9b49a',
};

/** Deterministic pleasant colour for bodies without an entry. */
function fallbackColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 30% 70%)`;
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Parent = the body with the smallest Hill sphere that contains this body,
 * among bodies more massive than it; the most massive body is the root (infinite
 * Hill sphere). Hill radius of j about its own parent p: |r_j - r_p| (m_j / 3 m_p)^(1/3).
 * Bodies are processed in decreasing mass, so every candidate's Hill radius is known.
 */
export function deriveMeta(bodies: readonly BodyLike[]): BodyMeta[] {
  const order = bodies.map((_, i) => i).sort((a, b) => bodies[b].gm - bodies[a].gm);
  const parent = new Array<number>(bodies.length).fill(-1);
  const hill = new Array<number>(bodies.length).fill(0);
  order.forEach((i, rank) => {
    if (rank === 0) {
      hill[i] = Infinity;
      return;
    }
    let best = Infinity;
    for (let r = 0; r < rank; r++) {
      const j = order[r];
      if (dist(bodies[i].state0, bodies[j].state0) < hill[j] && hill[j] <= best) {
        best = hill[j];
        parent[i] = j;
      }
    }
    const p = bodies[parent[i]];
    hill[i] = dist(bodies[i].state0, p.state0) * Math.cbrt(bodies[i].gm / (3 * p.gm));
  });
  return bodies.map((b, i) => {
    let period = Infinity;
    if (parent[i] >= 0) {
      const p = bodies[parent[i]];
      const mu = p.gm + b.gm;
      const r = dist(b.state0, p.state0);
      const v = Math.hypot(b.state0[3] - p.state0[3], b.state0[4] - p.state0[4], b.state0[5] - p.state0[5]);
      const inv = 2 / r - (v * v) / mu;
      if (inv > 0) period = 2 * Math.PI * Math.sqrt(1 / (inv * inv * inv) / mu);
    }
    return { parent: parent[i], period, color: COLORS[b.id] ?? fallbackColor(b.id) };
  });
}
