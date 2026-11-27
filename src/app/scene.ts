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
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { AnchoredSegment } from './paths';
import { BodyVisuals } from './body-visuals';
import { MAP } from './palette';

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

/**
 * Burn arcs: screen-space thick lines (three.js Line2, width in CSS px), so a
 * powered arc reads as different from a coast by width, not only by colour.
 * Depth-tested like the trajectory, so the far side hides behind a planet.
 */
class ThickAnchoredLine {
  readonly group = new THREE.Group();
  private segs: { anchor: Float64Array; line: Line2 }[] = [];
  /** One material per colour (each stage flies in its own colour, palette.ts). */
  private readonly materials = new Map<number, LineMaterial>();
  private readonly res = new THREE.Vector2(1, 1);
  constructor(private readonly make: (hex: number) => LineMaterial) {}
  private material(hex: number): LineMaterial {
    let m = this.materials.get(hex);
    if (!m) {
      m = this.make(hex);
      m.resolution.copy(this.res);
      this.materials.set(hex, m);
    }
    return m;
  }
  setResolution(w: number, h: number): void {
    this.res.set(w, h);
    for (const m of this.materials.values()) m.resolution.set(w, h);
  }
  set(segments: (AnchoredSegment & { hex: number })[]): void {
    this.clear();
    for (const s of segments) {
      const g = new LineGeometry();
      g.setPositions(s.verts);
      const line = new Line2(g, this.material(s.hex));
      line.frustumCulled = false;
      this.group.add(line);
      this.segs.push({ anchor: s.anchor, line });
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

/**
 * A reference plane disc (equator or an orbital plane): translucent, fading rim, depth-tested but
 * not depth-writing. Drawn procedurally in the fragment shader from the distance to the centre (no
 * texture, so it is smooth at any size or zoom): solid core, raised-cosine fade to zero at the rim,
 * faint rings every quarter radius anti-aliased with screen-space derivatives (about one device
 * pixel wide at any zoom), and a little ordered noise so the alpha gradient does not band on a
 * dark background. Uses the logarithmic depth chunks so it still intersects the globe correctly.
 */
class PlaneDisc {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(color: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.25 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vLocal;
        void main() {
          vLocal = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vLocal;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vLocal);
          if (r >= 1.0) discard;
          float fade = r < 0.55 ? 1.0 : 0.5 + 0.5 * cos(PI * (r - 0.55) / 0.45);
          // Rings at r = 0.25, 0.5, 0.75: distance to the nearest ring in pixels via fwidth.
          float q = r * 4.0;
          float w = max(fwidth(q), 1e-6);
          float d = abs(q - floor(q + 0.5)) / w;
          float ring = (q > 0.5 && q < 3.5) ? (1.0 - smoothstep(0.5, 1.5, d)) * 0.5 : 0.0;
          float a = min(1.0, fade * (0.55 + ring)) * uOpacity;
          // Interleaved gradient noise, +-0.5/255: breaks up 8-bit banding of the fade.
          float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          a = clamp(a + (n - 0.5) / 255.0, 0.0, 1.0);
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 192), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1; // after the opaque globe, before the trajectory lines are blended over it
  }
}

/** Rotation axis: north half red, south half blue, through the poles to `length` from the centre. */
class AxisLine {
  readonly group = new THREE.Group();
  constructor() {
    const mk = (sign: number, color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, sign]), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
      l.frustumCulled = false;
      return l;
    };
    this.group.add(mk(1, 0xff6b6b), mk(-1, 0x6bb6ff));
    this.group.visible = false;
  }
}

export interface OverlayPose {
  /** Centre in frame coordinates, m. */
  pos: ArrayLike<number>;
  /** Body-fixed (or plane) -> frame rotation, row-major 3x3; its third column is the plane normal / pole. */
  rot: ArrayLike<number>;
  /** Disc radius or axis half-length, m. */
  size: number;
  opacity?: number;
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
  private readonly burnArcs: ThickAnchoredLine;
  private readonly farMaterial: THREE.LineBasicMaterial;
  private readonly equatorDisc: PlaneDisc;
  private readonly targetDisc: PlaneDisc;
  private readonly axis = new AxisLine();
  private readonly overlayPos = { equator: new Float64Array(3), target: new Float64Array(3), axis: new Float64Array(3) };
  private readonly m4 = new THREE.Matrix4();
  private readonly trajectoryMaterial: THREE.LineBasicMaterial;
  private readonly light: THREE.PointLight;
  private readonly lightBody: number;

  constructor(canvas: HTMLCanvasElement, visuals: readonly BodyVisual[], lightBody: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, stencil: true });
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
    this.trajectoryMaterial = new THREE.LineBasicMaterial({ color: MAP.coast, transparent: true, opacity: 0.9, depthWrite: false });
    this.trajectory = new AnchoredLine(this.trajectoryMaterial);
    this.trajectoryPast = new AnchoredLine(new THREE.LineBasicMaterial({ color: MAP.coastPast, transparent: true, opacity: 0.8, depthWrite: false }));
    this.burnArcs = new ThickAnchoredLine((color) => new LineMaterial({ color, linewidth: 4.5, worldUnits: false, transparent: true, opacity: 0.95, depthWrite: false }));
    this.equatorDisc = new PlaneDisc(0x9fc6ff);
    this.targetDisc = new PlaneDisc(0xffd36b);
    this.scene.add(this.equatorDisc.mesh, this.targetDisc.mesh, this.axis.group);
    // Faint revolutions: each pixel is drawn at most once per frame (stencil), so 160 overlapping revolutions of a
    // parking orbit stay one faint trace instead of saturating into an opaque band over the planet.
    const far = new THREE.LineBasicMaterial({ color: MAP.coastFar, transparent: true, opacity: 0.1, depthWrite: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
    this.farMaterial = far;
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
    this.burnArcs.setResolution(w, h);
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

  /** Powered arcs, drawn thick over the trajectory, each in its stage's colour (palette.ts). */
  setBurnArcs(segs: (AnchoredSegment & { hex: number })[] | null): void {
    if (segs && segs.length) this.burnArcs.set(segs);
    else this.burnArcs.clear();
  }

  /** Dim the trajectory (e.g. it belongs to a plan that is no longer current). */
  setTrajectoryDim(dim: boolean): void {
    for (const l of [this.trajectory, this.trajectoryPast]) l.group.visible = true;
    (this.trajectoryMaterial.opacity) = dim ? 0.35 : 0.9;
  }

  /**
   * Vertex index of the current time along the trajectory polyline (fractional allowed: rounded).
   * `window`: the bright vertex range around the cursor (the rest faint). `drawEnd`: last vertex
   * drawn (the drawn span after the last burn; never before the cursor); past it the line is faint
   * when `faintRest`, else hidden.
   */
  setTrajectorySplit(vertex: number, total: number, window: [number, number] = [0, total - 1], drawEnd = total - 1, faintRest = false): void {
    const v = Math.round(vertex);
    const E = Math.min(total - 1, Math.max(v, Math.round(drawEnd)));
    const w0 = Math.max(0, Math.min(v, Math.round(window[0])));
    const w1 = Math.min(E, Math.max(v, Math.round(window[1])));
    this.trajectoryFarBefore.setRange(0, w0);
    this.trajectoryPast.setRange(w0, v);
    this.trajectory.setRange(v, w1);
    this.trajectoryFarAfter.setRange(w1, faintRest ? total - 1 : E);
  }

  /** Tests and before / after screenshots: the faint revolutions without the draw-once stencil (and at the old opacity). */
  setFaintAccumulate(on: boolean): void {
    this.farMaterial.stencilWrite = !on;
    this.farMaterial.opacity = on ? 0.12 : 0.1;
    this.farMaterial.needsUpdate = true;
  }

  /** Reference geometry overlays (null hides): equatorial disc, a target's orbital-plane disc, the rotation axis. */
  setOverlays(equator: OverlayPose | null, target: OverlayPose | null, axis: OverlayPose | null): void {
    const pose = (o: THREE.Object3D, p: OverlayPose, keep: Float64Array) => {
      const r = p.rot;
      this.m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
      o.quaternion.setFromRotationMatrix(this.m4);
      o.scale.setScalar(p.size / UNIT);
      keep.set([p.pos[0], p.pos[1], p.pos[2]]);
    };
    for (const [d, p, k] of [[this.equatorDisc, equator, this.overlayPos.equator], [this.targetDisc, target, this.overlayPos.target]] as const) {
      d.mesh.visible = !!p;
      if (p) {
        pose(d.mesh, p, k);
        d.material.uniforms.uOpacity.value = p.opacity ?? 0.25;
      }
    }
    this.axis.group.visible = !!axis;
    if (axis) pose(this.axis.group, axis, this.overlayPos.axis);
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
    for (const [o, k] of [[this.equatorDisc.mesh, this.overlayPos.equator], [this.targetDisc.mesh, this.overlayPos.target], [this.axis.group, this.overlayPos.axis]] as const) {
      if (o.visible) o.position.set((k[0] - cam[0]) / UNIT, (k[1] - cam[1]) / UNIT, (k[2] - cam[2]) / UNIT);
    }
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
