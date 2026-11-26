/**
 * three.js rendering. Everything is positioned in frame coordinates (float64,
 * metres) on the CPU and handed to three.js relative to the camera, which sits
 * at the scene origin (floating origin): the float32 values the GPU sees are
 * small wherever precision matters, so there is no jitter in low orbit or at
 * 30 AU. Render units are kilometres.
 *
 * Depth: a logarithmic depth buffer (three.js `logarithmicDepthBuffer`, which
 * writes gl_FragDepth = log2(1 + w) / log2(1 + far)) covers near = 1 m to
 * far = 1e12 km with roughly constant relative precision; with 24-bit depth that
 * is about 2^-24 * ln(1e15) ≈ 2e-6 relative depth resolution at every range,
 * i.e. a few cm at 10,000 km. The scene is a few dozen draw calls, so losing
 * early-z (the cost of writing gl_FragDepth) is irrelevant.
 *
 * Labels and markers are DOM elements positioned each frame (see labels.ts).
 */
import * as THREE from 'three';
import type { AnchoredSegment } from './paths';
import { BodyVisuals } from './body-visuals';

export const UNIT = 1000; // metres per render unit

export interface BodyVisual {
  readonly radius: number; // m
  readonly color: string;
  readonly emissive: boolean;
}

class AnchoredLine {
  readonly group = new THREE.Group();
  private segs: { anchor: Float64Array; line: THREE.Line; first: number; count: number }[] = [];
  constructor(private readonly material: THREE.LineBasicMaterial) {}

  set(segments: AnchoredSegment[]): void {
    this.clear();
    let first = 0;
    for (const s of segments) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(s.verts, 3));
      const line = new THREE.Line(g, this.material);
      line.frustumCulled = false; // bounding spheres would be computed in anchor space; cheap to skip
      this.group.add(line);
      const count = s.verts.length / 3;
      this.segs.push({ anchor: s.anchor, line, first, count });
      first += count - 1; // segments share an endpoint
    }
  }

  /** Draw only vertices [from, to] of the whole polyline (global vertex indices, inclusive). */
  setRange(from: number, to: number): void {
    for (const s of this.segs) {
      const a = Math.max(from, s.first) - s.first;
      const b = Math.min(to, s.first + s.count - 1) - s.first;
      s.line.visible = b > a;
      if (b > a) s.line.geometry.setDrawRange(a, b - a + 1);
    }
  }

  clear(): void {
    for (const s of this.segs) {
      s.line.geometry.dispose();
      this.group.remove(s.line);
    }
    this.segs = [];
  }

  place(cam: Float64Array): void {
    for (const s of this.segs) s.line.position.set((s.anchor[0] - cam[0]) / UNIT, (s.anchor[1] - cam[1]) / UNIT, (s.anchor[2] - cam[2]) / UNIT);
  }
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly scene = new THREE.Scene();
  private readonly bodies: THREE.Mesh[] = [];
  private readonly paths: AnchoredLine[] = [];
  private readonly trajectory: AnchoredLine;
  private readonly trajectoryPast: AnchoredLine;
  /** Revolutions far from the time cursor, drawn faint so a body wrapped many times stays visible. */
  private readonly trajectoryFarBefore: AnchoredLine;
  private readonly trajectoryFarAfter: AnchoredLine;
  private readonly burnArcs: AnchoredLine;
  private readonly trajectoryMaterial: THREE.LineBasicMaterial;
  private readonly light: THREE.PointLight;
  private readonly lightBody: number;

  constructor(canvas: HTMLCanvasElement, visuals: readonly BodyVisual[], lightBody: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x05070b);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1e-3, 1e12);
    this.camera.up.set(0, 0, 1);
    this.lightBody = lightBody;
    const sphere = new THREE.SphereGeometry(1, 64, 32);
    for (const v of visuals) {
      const color = new THREE.Color(v.color);
      const mat = v.emissive ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
      const m = new THREE.Mesh(sphere, mat);
      m.scale.setScalar(v.radius / UNIT);
      m.frustumCulled = false;
      this.scene.add(m);
      this.bodies.push(m);
      const line = new AnchoredLine(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false }));
      this.scene.add(line.group);
      this.paths.push(line);
    }
    this.trajectoryMaterial = new THREE.LineBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.9, depthWrite: false });
    this.trajectory = new AnchoredLine(this.trajectoryMaterial);
    this.trajectoryPast = new AnchoredLine(new THREE.LineBasicMaterial({ color: 0x3b7a58, transparent: true, opacity: 0.8, depthWrite: false }));
    this.burnArcs = new AnchoredLine(new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: false, depthWrite: false, depthTest: false }));
    const far = new THREE.LineBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.12, depthWrite: false });
    this.trajectoryFarBefore = new AnchoredLine(far);
    this.trajectoryFarAfter = new AnchoredLine(far);
    this.scene.add(this.trajectory.group, this.trajectoryPast.group, this.trajectoryFarBefore.group, this.trajectoryFarAfter.group, this.burnArcs.group);
    this.light = new THREE.PointLight(0xffffff, 3, 0, 0);
    this.scene.add(this.light, new THREE.AmbientLight(0xffffff, 0.06));
    this.visuals = new BodyVisuals(this.renderer, this.bodies, lightBody); // textures, IAU orientation, rings
  }

  /** Surface textures and orientation (body-visuals.ts). */
  readonly visuals: BodyVisuals;

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBodyPath(i: number, segs: AnchoredSegment[] | null): void {
    if (segs) this.paths[i].set(segs);
    else this.paths[i].clear();
  }

  /** The spacecraft trajectory (drawn dim before `split`, bright after; see setTrajectorySplit). */
  setTrajectory(segs: AnchoredSegment[] | null): void {
    for (const l of [this.trajectory, this.trajectoryPast, this.trajectoryFarBefore, this.trajectoryFarAfter]) {
      if (segs) l.set(segs);
      else l.clear();
    }
  }

  /** Powered arcs, drawn over the trajectory in a distinct colour. */
  setBurnArcs(segs: AnchoredSegment[] | null): void {
    if (segs && segs.length) this.burnArcs.set(segs);
    else this.burnArcs.clear();
  }

  /** Dim the trajectory (e.g. it belongs to a plan that is no longer current). */
  setTrajectoryDim(dim: boolean): void {
    for (const l of [this.trajectory, this.trajectoryPast]) l.group.visible = true;
    (this.trajectoryMaterial.opacity) = dim ? 0.35 : 0.9;
  }

  /** Vertex index of the current time along the trajectory polyline (fractional allowed: rounded). */
  setTrajectorySplit(vertex: number, total: number, window: [number, number] = [0, total - 1]): void {
    const v = Math.round(vertex);
    const w0 = Math.max(0, Math.min(v, Math.round(window[0])));
    const w1 = Math.min(total - 1, Math.max(v, Math.round(window[1])));
    this.trajectoryFarBefore.setRange(0, w0);
    this.trajectoryPast.setRange(w0, v);
    this.trajectory.setRange(v, w1);
    this.trajectoryFarAfter.setRange(w1, total - 1);
  }

  setPathVisible(i: number, visible: boolean): void {
    this.paths[i].group.visible = visible;
  }

  /**
   * Render with the camera at `cam` looking at `target` (frame coords, m).
   * bodyPos holds frame coordinates of every body.
   */
  render(cam: Float64Array, target: Float64Array, bodyPos: Float64Array): void {
    const c = this.camera;
    c.position.set(0, 0, 0);
    c.lookAt((target[0] - cam[0]) / UNIT, (target[1] - cam[1]) / UNIT, (target[2] - cam[2]) / UNIT);
    c.updateMatrixWorld();
    for (let i = 0; i < this.bodies.length; i++) {
      this.bodies[i].position.set((bodyPos[3 * i] - cam[0]) / UNIT, (bodyPos[3 * i + 1] - cam[1]) / UNIT, (bodyPos[3 * i + 2] - cam[2]) / UNIT);
      this.paths[i].place(cam);
    }
    this.trajectory.place(cam);
    this.trajectoryPast.place(cam);
    this.trajectoryFarBefore.place(cam);
    this.trajectoryFarAfter.place(cam);
    this.burnArcs.place(cam);
    const l = this.lightBody;
    if (l >= 0) this.light.position.copy(this.bodies[l].position);
    this.visuals.update(c, this.renderer.domElement.clientHeight);
    this.renderer.render(this.scene, c);
  }

  /** Pixel radius of a sphere of radius r (m) at distance d (m). */
  pixelRadius(r: number, d: number): number {
    const h = this.renderer.domElement.clientHeight;
    return (r / d) * (h / 2 / Math.tan((this.camera.fov * Math.PI) / 360));
  }

  /**
   * Project a frame-coordinate point to CSS pixels; null if behind the camera.
   * Must be called after render() (uses the camera matrices it set).
   */
  project(p: ArrayLike<number>, pi: number, cam: Float64Array, out: { x: number; y: number }): boolean {
    const v = this.tmp.set((p[pi] - cam[0]) / UNIT, (p[pi + 1] - cam[1]) / UNIT, (p[pi + 2] - cam[2]) / UNIT);
    v.applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z >= 0) return false;
    v.applyMatrix4(this.camera.projectionMatrix);
    const el = this.renderer.domElement;
    out.x = (v.x * 0.5 + 0.5) * el.clientWidth;
    out.y = (-v.y * 0.5 + 0.5) * el.clientHeight;
    return true;
  }
  private readonly tmp = new THREE.Vector3();
}
