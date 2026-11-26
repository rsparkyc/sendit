/**
 * Surface textures, orientation and Saturn's rings for the body meshes that
 * scene.ts creates. Display only.
 *
 * ORIENTATION. Each body mesh gets a sphere built in the body-fixed frame of
 * body-rotation.ts (x through the prime meridian, z along the IAU pole) with
 * u = east longitude / 360 and v = (latitude + 90) / 180; every shipped map is
 * re-encoded to that convention by scripts/make-planet-textures.py. Per frame
 * the mesh rotation is frameAxes * R(t), with R(t) the IAU body-fixed -> ICRF
 * rotation at simulation time t and frameAxes the ICRF -> frame rotation of the
 * current plotting frame (frames.ts), because the scene is drawn in frame
 * coordinates. The simulation time and frame are read through setTime() when
 * the app calls it, otherwise from the app's published state (window.sendit,
 * the same object the browser tests use); until either is available bodies
 * stay flat-coloured.
 *
 * LOADING. Nothing is fetched before the first frame is drawn. A body's low
 * tier (512 x 256) is fetched once it is at least LO_PX pixels in radius on
 * screen; its high tier (1024 or 2048 wide) only while it is in view and at
 * least HI_PX in radius, one fetch at a time, largest body first. The flat
 * colour stays until a texture is decoded and uploaded, and stays for good if
 * loading fails. Textures are decoded off the main thread (createImageBitmap)
 * where available. GPU memory is estimated (w * h * 4 * 4/3 with mipmaps) and
 * held under a budget (smaller on touch devices) by evicting the least
 * recently wanted textures, high tiers first; tiers wider than the device's
 * MAX_TEXTURE_SIZE are never requested.
 *
 * LIGHTING is the scene's point light at the Sun (Lambert, so the terminator
 * follows the real Sun direction); Earth's night side shows city lights; the
 * Sun stays unlit. Saturn's rings are an annulus in its equatorial plane with
 * the planet's shadow computed per fragment.
 */
import * as THREE from 'three';
import { BODIES, BODY_GM } from './physics';
import { IAU_ROTATION, bodyToIcrf, mul3 } from './body-rotation';
import { ECLIPTIC_AXES, computeFrame, newFrameState, type FrameSpec } from './frames';
import { RING_PROFILE, ringProfileTexture } from './saturn-rings';

const URLS = import.meta.glob('../assets/planets/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
function url(name: string): string | undefined {
  return URLS[`../assets/planets/${name}.webp`];
}

const LO_PX = 6;
const HI_PX = 110;

type Tier = 'lo' | 'hi';
interface Slot {
  tex: THREE.Texture | null;
  bytes: number;
  state: 'none' | 'loading' | 'ready' | 'failed';
  lastWanted: number;
}

interface BodyEntry {
  index: number;
  id: string;
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial | null; // null for the Sun (left as scene made it)
  baseColor: THREE.Color;
  rotation: (typeof IAU_ROTATION)[string] | undefined;
  tiers: Partial<Record<Tier, Slot>>;
  /** Tier on the material; 'stale' forces the next show() to rebuild it. */
  shown: Tier | null | 'stale';
}

/** Unit sphere in the body-fixed frame, u = east longitude / 360, v = (lat + 90) / 180. */
export function bodyFixedSphere(lonSegs = 64, latSegs = 32): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= latSegs; j++) {
    const v = j / latSegs;
    const lat = (v - 0.5) * Math.PI;
    for (let i = 0; i <= lonSegs; i++) {
      const u = i / lonSegs;
      const lon = u * 2 * Math.PI;
      pos.push(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
      uv.push(u, v);
    }
  }
  const row = lonSegs + 1;
  for (let j = 0; j < latSegs; j++)
    for (let i = 0; i < lonSegs; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      // counter-clockwise seen from outside (east = +u, north = +v)
      if (j > 0) idx.push(a, b, d);
      if (j < latSegs - 1) idx.push(a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A small fixed link to the image credits page (public/credits.html). */
function addCreditsLink(): void {
  if (typeof document === 'undefined' || document.getElementById('image-credits')) return;
  const a = document.createElement('a');
  a.id = 'image-credits';
  a.href = 'credits.html';
  a.textContent = 'Image credits';
  a.title = 'Sources and licences of the planet and moon maps';
  Object.assign(a.style, {
    position: 'fixed', left: '6px', bottom: '3px', zIndex: '20', font: '11px system-ui, sans-serif',
    color: 'rgba(200, 215, 235, 0.7)', textDecoration: 'none', pointerEvents: 'auto',
  });
  document.body.appendChild(a);
}

interface AppHook {
  store: { get(): { t: number; frame: FrameSpec } };
  eph: { evaluate(t: number, pos: Float64Array, vel: Float64Array | null): boolean };
}

export class BodyVisuals {
  private readonly entries: BodyEntry[] = [];
  private readonly maxTex: number;
  private readonly budget: number;
  private readonly hiWidth = new Map<string, number>();
  private loadingHi = false;
  private frameNo = 0;
  private explicit: { t: number; axes: ArrayLike<number> } | null = null;
  private readonly frameState = newFrameState();
  private readonly pos = new Float64Array(3 * BODIES.length);
  private readonly vel = new Float64Array(3 * BODIES.length);
  private readonly rot = new Float64Array(9);
  private readonly m = new Float64Array(9);
  private readonly m4 = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly v1 = new THREE.Vector3();
  private readonly nightUniform = { value: new THREE.Vector3(1, 0, 0) };
  private readonly earth: BodyEntry | undefined = undefined;
  private night: Slot | null = null;
  private readonly ring: THREE.Mesh | null = null;
  private readonly ringUniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uPlanet: { value: new THREE.Vector3() },
    uPlanetR: { value: 1 },
    uCamDir: { value: new THREE.Vector3() },
    uProfile: { value: null as THREE.Texture | null },
    uInner: { value: 0 },
    uOuter: { value: 1 },
  };
  private readonly sunIndex: number;
  private readonly disabled: boolean;
  /** Bytes fetched so far (for tests and the HUD). */
  readonly stats = { bytes: 0, requests: 0, gpuBytes: 0, evictions: 0 };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    meshes: readonly THREE.Mesh[],
    lightBody: number,
  ) {
    this.sunIndex = lightBody;
    // `#textures=0` in the URL leaves the original flat-shaded spheres untouched (for comparisons).
    this.disabled = typeof location !== 'undefined' && /(^|[#&])textures=0(&|$)/.test(location.hash);
    this.maxTex = renderer.capabilities.maxTextureSize;
    const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    const small = typeof window !== 'undefined' && Math.min(window.screen?.width ?? 1e4, window.screen?.height ?? 1e4) < 900;
    this.budget = (touch && small ? 40 : 96) * 1024 * 1024;
    if (this.disabled) {
      this.maxTex = 0;
      this.budget = 0;
      return;
    }
    const geom = bodyFixedSphere();
    for (let i = 0; i < meshes.length && i < BODIES.length; i++) {
      const b = BODIES[i];
      const mesh = meshes[i];
      const old = mesh.material as THREE.Material & { color?: THREE.Color };
      const baseColor = old.color ? old.color.clone() : new THREE.Color(1, 1, 1);
      let material: THREE.MeshLambertMaterial | null = null;
      if (i !== lightBody) {
        mesh.geometry = geom; // the shared sphere is not disposed: scene.ts owns it
        material = new THREE.MeshLambertMaterial({ color: baseColor });
        mesh.material = material;
        old.dispose();
      }
      const tiers: Partial<Record<Tier, Slot>> = {};
      for (const tier of ['lo', 'hi'] as const) if (url(`${b.id}-${tier}`)) tiers[tier] = { tex: null, bytes: 0, state: 'none', lastWanted: 0 };
      this.entries.push({ index: i, id: b.id, mesh, material, baseColor, rotation: IAU_ROTATION[b.id], tiers, shown: null });
    }
    // High-tier widths (written by scripts/make-planet-textures.py; 2048 unless listed).
    for (const id of ['tethys', 'dione', 'rhea', 'iapetus']) this.hiWidth.set(id, 1024);
    this.earth = this.entries.find((e) => e.id === 'earth');
    if (this.earth?.material && url('earth-night-hi')) {
      this.night = { tex: null, bytes: 0, state: 'none', lastWanted: 0 };
      const u = this.nightUniform;
      const mat = this.earth.material;
      mat.emissive.setRGB(0, 0, 0);
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uSunDirView = u;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirView;')
          .replace(
            '#include <lights_fragment_begin>',
            // City lights only on the night side, fading through the terminator.
            'totalEmissiveRadiance *= smoothstep(0.05, -0.15, dot(normal, uSunDirView));\n#include <lights_fragment_begin>',
          );
      };
      mat.customProgramCacheKey = () => 'earth-night';
    }
    const saturn = this.entries.find((e) => e.id === 'saturn');
    if (saturn) this.ring = this.makeRing(saturn);
    if (typeof window !== 'undefined') (window as { senditVisuals?: BodyVisuals }).senditVisuals = this; // tests
    addCreditsLink();
  }

  /** Simulation time (TDB s from J2000) and frame axes (rows = frame axes in ICRF) for this frame. */
  setTime(t: number, frameAxes: ArrayLike<number>): void {
    this.explicit = { t, axes: frameAxes };
  }

  private makeRing(saturn: BodyEntry): THREE.Mesh {
    const R = BODIES[saturn.index].radius;
    const inner = RING_PROFILE.inner / R;
    const outer = RING_PROFILE.outer / R;
    const g = new THREE.RingGeometry(inner, outer, 256, 1); // in the XY plane = body-fixed equator
    const u = this.ringUniforms;
    u.uProfile.value = ringProfileTexture();
    u.uInner.value = inner;
    u.uOuter.value = outer;
    const mat = new THREE.ShaderMaterial({
      uniforms: u,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        varying vec2 vLocal;
        varying vec3 vNormalW;
        void main() {
          vLocal = position.xy;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vNormalW = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
          gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSunDir;
        uniform vec3 uPlanet;
        uniform float uPlanetR;
        uniform sampler2D uProfile;
        uniform float uInner;
        uniform float uOuter;
        varying vec3 vWorld;
        varying vec2 vLocal;
        varying vec3 vNormalW;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vLocal);
          vec4 p = texture2D(uProfile, vec2((r - uInner) / (uOuter - uInner), 0.5));
          // Planet shadow: does the ray toward the Sun pass within the planet's radius?
          vec3 toC = uPlanet - vWorld;
          float s = dot(toC, uSunDir);
          float miss = length(toC - s * uSunDir);
          float lit = (s > 0.0 && miss < uPlanetR) ? 0.04 : 1.0;
          // Seen from the unlit face, only light scattered through the ring reaches the eye.
          vec3 view = normalize(-vWorld);
          float sameSide = sign(dot(vNormalW, uSunDir)) * sign(dot(vNormalW, view));
          float face = sameSide > 0.0 ? 1.0 : 0.25 * (1.0 - p.a) + 0.08;
          gl_FragColor = vec4(p.rgb * lit * face, p.a);
          #include <colorspace_fragment>
        }`,
    });
    const ring = new THREE.Mesh(g, mat);
    ring.frustumCulled = false;
    saturn.mesh.add(ring);
    return ring;
  }

  /** Simulation time and frame axes from the explicit call or the app's published state. */
  private timeAndAxes(): { t: number; axes: ArrayLike<number> } | null {
    if (this.explicit) return this.explicit;
    const hook = (globalThis as { sendit?: AppHook }).sendit;
    if (!hook?.store) return null;
    const s = hook.store.get();
    if (s.frame.kind !== 'rotating') return { t: s.t, axes: ECLIPTIC_AXES };
    if (!hook.eph?.evaluate(s.t, this.pos, this.vel)) return null;
    computeFrame(s.frame, { count: BODIES.length, pos: this.pos, vel: this.vel, gm: BODY_GM }, this.frameState);
    return { t: s.t, axes: this.frameState.axes };
  }

  /**
   * Orient, light and (re)texture the bodies. Call after the meshes have their
   * camera-relative positions for this frame and the camera matrices are updated.
   */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    if (this.disabled) return;
    this.frameNo++;
    const ta = this.timeAndAxes();
    this.explicit = null;
    const oriented = ta !== null;
    if (ta) {
      for (const e of this.entries) {
        if (!e.rotation || e.index === this.sunIndex) continue;
        bodyToIcrf(e.rotation, ta.t, this.rot);
        mul3(ta.axes, this.rot, this.m);
        const m = this.m;
        this.m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
        e.mesh.quaternion.setFromRotationMatrix(this.m4);
      }
    }
    const sunPos = this.entries[this.sunIndex]?.mesh.position;
    // Lighting uniforms.
    if (this.earth && sunPos) {
      this.v1.copy(sunPos).sub(this.earth.mesh.position).normalize().transformDirection(camera.matrixWorldInverse);
      this.nightUniform.value.copy(this.v1);
    }
    if (this.ring && sunPos) {
      const sat = this.ring.parent as THREE.Mesh;
      const u = this.ringUniforms;
      u.uPlanet.value.copy(sat.position);
      u.uPlanetR.value = sat.scale.x;
      u.uSunDir.value.copy(sunPos).sub(sat.position).normalize();
    }

    // Level of detail.
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const k = viewportHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
    let bestHi: { e: BodyEntry; px: number } | null = null;
    for (const e of this.entries) {
      if (!e.material) continue;
      const r = e.mesh.scale.x;
      const d = e.mesh.position.length();
      const px = d > r ? (r / d) * k : Infinity;
      this.sphere.set(e.mesh.position, r * (e.id === 'saturn' ? 2.4 : 1));
      const inView = this.frustum.intersectsSphere(this.sphere);
      const lo = e.tiers.lo;
      if (lo && px >= LO_PX) {
        lo.lastWanted = this.frameNo;
        if (lo.state === 'none' && oriented) this.load(e, 'lo');
      }
      const hi = e.tiers.hi;
      if (hi && inView && px >= HI_PX && (this.hiWidth.get(e.id) ?? 2048) <= this.maxTex) {
        hi.lastWanted = this.frameNo;
        if (hi.state === 'none' && lo?.state === 'ready' && (!bestHi || px > bestHi.px)) bestHi = { e, px };
      }
      this.show(e, oriented);
    }
    if (bestHi && !this.loadingHi) this.load(bestHi.e, 'hi');
    if (this.night && this.earth?.tiers.hi?.lastWanted === this.frameNo) {
      this.night.lastWanted = this.frameNo;
      if (this.night.state === 'none' && this.earth.tiers.hi.state === 'ready') this.loadNight();
    }
    if (this.frameNo % 30 === 0) this.evict();
  }

  /** Put the best ready tier on the material (flat colour if none, or not oriented yet). */
  private show(e: BodyEntry, oriented: boolean): void {
    const mat = e.material!;
    let want: Tier | null = null;
    if (oriented) {
      if (e.tiers.hi?.state === 'ready') want = 'hi';
      else if (e.tiers.lo?.state === 'ready') want = 'lo';
    }
    if (want === e.shown) return;
    e.shown = want;
    mat.map = want ? e.tiers[want]!.tex : null;
    mat.color.copy(want ? new THREE.Color(1, 1, 1) : e.baseColor);
    if (e === this.earth && this.night) {
      const on = want !== null && this.night.state === 'ready';
      mat.emissiveMap = on ? this.night.tex : null;
      mat.emissive.setRGB(on ? 1 : 0, on ? 1 : 0, on ? 1 : 0);
    }
    mat.needsUpdate = true;
  }

  private async fetchTexture(name: string): Promise<{ tex: THREE.Texture; bytes: number; gpu: number }> {
    const u = url(name);
    if (!u) throw new Error(`no texture ${name}`);
    const res = await fetch(u);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const blob = await res.blob();
    this.stats.bytes += blob.size;
    this.stats.requests++;
    let tex: THREE.Texture;
    let w: number, h: number;
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      tex = new THREE.Texture(bmp);
      tex.flipY = false; // already flipped: row 0 is the south pole, v = 0
      w = bmp.width;
      h = bmp.height;
    } else {
      const img = new Image();
      const src = URL.createObjectURL(blob);
      img.src = src;
      await img.decode();
      URL.revokeObjectURL(src);
      tex = new THREE.Texture(img);
      w = img.naturalWidth;
      h = img.naturalHeight;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    return { tex, bytes: blob.size, gpu: Math.round((w * h * 4 * 4) / 3) };
  }

  private load(e: BodyEntry, tier: Tier): void {
    const slot = e.tiers[tier]!;
    slot.state = 'loading';
    if (tier === 'hi') this.loadingHi = true;
    this.fetchTexture(`${e.id}-${tier}`)
      .then(({ tex, gpu }) => {
        slot.tex = tex;
        slot.bytes = gpu;
        slot.state = 'ready';
        this.stats.gpuBytes += gpu;
      })
      .catch(() => {
        slot.state = 'failed'; // flat colour (or the lower tier) stays
      })
      .finally(() => {
        if (tier === 'hi') this.loadingHi = false;
      });
  }

  private loadNight(): void {
    const slot = this.night!;
    slot.state = 'loading';
    this.fetchTexture('earth-night-hi')
      .then(({ tex, gpu }) => {
        slot.tex = tex;
        slot.bytes = gpu;
        slot.state = 'ready';
        this.stats.gpuBytes += gpu;
        if (this.earth) this.earth.shown = 'stale';
      })
      .catch(() => {
        slot.state = 'failed';
      });
  }

  /** Drop least recently wanted textures while over budget (high tiers and night lights first). */
  private evict(): void {
    if (this.stats.gpuBytes <= this.budget) return;
    const cands: { slot: Slot; e: BodyEntry | null; rank: number }[] = [];
    for (const e of this.entries)
      for (const tier of ['lo', 'hi'] as const) {
        const s = e.tiers[tier];
        if (s?.state === 'ready' && s.lastWanted < this.frameNo) cands.push({ slot: s, e, rank: s.lastWanted - (tier === 'hi' ? 1e9 : 0) });
      }
    if (this.night?.state === 'ready' && this.night.lastWanted < this.frameNo) cands.push({ slot: this.night, e: this.earth ?? null, rank: this.night.lastWanted - 1e9 });
    cands.sort((a, b) => a.rank - b.rank);
    for (const c of cands) {
      if (this.stats.gpuBytes <= this.budget) break;
      c.slot.tex?.dispose();
      const img = c.slot.tex?.image as ImageBitmap | undefined;
      if (img && typeof (img as ImageBitmap).close === 'function') img.close();
      c.slot.tex = null;
      c.slot.state = 'none';
      this.stats.gpuBytes -= c.slot.bytes;
      this.stats.evictions++;
      c.slot.bytes = 0;
      if (c.e) c.e.shown = 'stale';
    }
  }
}
