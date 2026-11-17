import {
  AdditiveBlending,
  BackSide,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  MathUtils,
  Group,
  NearestFilter,
  Mesh,
  PerspectiveCamera,
  Ray,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Field } from '../data/cmip6';
import { bakeLut, LUT_SIZE, type Colormap } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { softLimit, solveGrab } from './grab';
import type { Viewport } from './types';

const FOV = 30;
const FILL = 0.78; // share of the shorter side the globe spans at the start
const START = { lon: 15, lat: 12 }; // what faces the camera first

// Longitude and latitude are computed per pixel from the sphere position, so the colours are exact
// at any mesh resolution (no pinching at the poles) and the mesh can stay coarse. Lon 0 faces +z.
const vertexShader = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  uniform sampler2D field;
  uniform sampler2D lut;
  uniform vec2 range;
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vec3 p = normalize(vPos);
    vec2 uv = vec2(atan(p.x, p.z) / 6.2831853 + 0.5, asin(clamp(p.y, -1.0, 1.0)) / 3.1415927 + 0.5);
    float t = clamp((texture2D(field, uv).r - range.x) / (range.y - range.x), 0.0, 1.0);
    vec3 rgb = texture2D(lut, vec2((0.5 + t * ${(LUT_SIZE - 1).toFixed(1)}) / ${LUT_SIZE.toFixed(1)}, 0.5)).rgb;
    gl_FragColor = vec4(rgb * (0.78 + 0.22 * vNormal.z), 1.0); // soft limb darkening for depth
  }
`;
// A faint glow just outside the rim, so the silhouette reads on any background. Seen from inside, the
// halo's |n.z| is 0 at its own edge and about 0.38 where the globe's rim is (radius 1 of 1.08).
const HALO = 1.08;
const haloShader = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float g = smoothstep(0.0, ${Math.sqrt(1 - 1 / HALO ** 2).toFixed(3)}, abs(vNormal.z));
    gl_FragColor = vec4(vec3(1.0), 0.22 * g * g * g);
  }
`;

// A grid as a float texture, filtered linearly where the GPU allows it.
function gridTexture(renderer: WebGLRenderer, f: Field): DataTexture {
  const texture = new DataTexture(f.values, f.width, f.height, RedFormat, FloatType);
  texture.minFilter = texture.magFilter = renderer.extensions.has('OES_texture_float_linear') ? LinearFilter : NearestFilter;
  texture.wrapS = RepeatWrapping; // longitude is periodic, so filter across the antimeridian
  texture.needsUpdate = true;
  return texture;
}

// Lon 0 at +z, lon 90 at +x, north at +y: the same frame as the fragment shader's atan(p.x, p.z).
const toXyz = (lon: number, lat: number, r: number): [number, number, number] => {
  const [l, p] = [MathUtils.degToRad(lon), MathUtils.degToRad(lat)];
  return [r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l)];
};

// The main globe of the full-screen layout: a field on a sphere with coastlines, drag to rotate,
// scroll or pinch to zoom. The point grabbed stays under the pointer, and a flick coasts to a stop.
// `load` gives the field for the shared state (memoized by the caller). Draws only while something
// changes: a frame per input event, and frames while a flick or a zoom damps out.
export const stageGlobe = (load: (year: number) => Field | Promise<Field>): Viewport => ({
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);

    const lutData = new Uint8Array(LUT_SIZE * 4);
    const lut = new DataTexture(lutData, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
    lut.minFilter = lut.magFilter = LinearFilter;
    const material = new ShaderMaterial({
      uniforms: { field: { value: null }, lut: { value: lut }, range: { value: [0, 1] } },
      vertexShader,
      fragmentShader,
    });
    const geometry = new SphereGeometry(1, 96, 48);
    const globe = new Mesh(geometry, material);
    globe.visible = false; // until the first field arrives
    const haloGeometry = new SphereGeometry(HALO, 64, 32);
    const haloMaterial = new ShaderMaterial({
      vertexShader,
      fragmentShader: haloShader,
      side: BackSide,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    // The camera stays on +z; the globe and its coastlines turn (see solveGrab).
    const earth = new Group().add(globe);
    const scene = new Scene().add(new Mesh(haloGeometry, haloMaterial), earth);
    let [yaw, pitch] = [MathUtils.degToRad(-START.lon), MathUtils.degToRad(START.lat)];
    const turn = () => earth.rotation.set(pitch, yaw, 0, 'XYZ'); // Rx(pitch) * Ry(yaw)
    turn();

    const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
    camera.position.set(0, 0, 1 / Math.sin(MathUtils.degToRad(FOV / 2)) / FILL);
    // OrbitControls only zooms (wheel, pinch), so the camera stays on its axis.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.25;
    controls.maxDistance = 10;

    let frame = 0;
    let last = 0; // time of the previous frame, for the flick
    let spin = [0, 0]; // yaw and pitch per millisecond after a flick
    const draw = (now: number) => {
      frame = 0;
      controls.update(); // fires 'change' (and so another frame) while the zoom damps
      if (!grab && (spin[0] || spin[1])) {
        const dt = Math.min(now - last, 50);
        [yaw, pitch] = [yaw + spin[0] * dt, MathUtils.clamp(pitch + spin[1] * dt, -Math.PI / 2, Math.PI / 2)];
        turn();
        const decay = Math.exp(-dt / 250);
        spin = spin.map((v) => (Math.abs(v * decay) < 1e-6 ? 0 : v * decay));
        redraw();
      }
      last = now;
      renderer.render(scene, camera);
    };
    const redraw = () => (frame ||= requestAnimationFrame(draw));
    controls.addEventListener('change', redraw);

    // Where the pointer's ray meets the unit sphere, in view space (camera on +z).
    const canvas = renderer.domElement;
    const ray = new Ray();
    const pointerOnSphere = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      camera.updateMatrixWorld();
      ray.origin.copy(camera.position);
      ray.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
      const along = -ray.origin.dot(ray.direction); // to the point of the ray nearest the centre
      const near = ray.at(along, new Vector3());
      const hit = near.lengthSq() <= 1;
      if (hit) return { hit, point: ray.at(along - Math.sqrt(1 - near.lengthSq()), near) };
      // Off the globe: the outline point in the pointer's direction, which stays put as the pointer moves out.
      const d = camera.position.length();
      const rim = Math.sqrt(1 - 1 / d ** 2);
      const across = Math.hypot(near.x, near.y) || 1;
      return { hit, point: new Vector3((near.x / across) * rim, (near.y / across) * rim, 1 / d) };
    };

    let grab: { lon: number; lat: number; id: number; t: number } | undefined;
    const pointers = new Set<number>();
    const onDown = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      if (pointers.size > 1 || e.button !== 0) return void (grab = undefined); // pinch: zoom only
      const { hit, point } = pointerOnSphere(e);
      if (!hit) return;
      // Grab the eased point, so a grab near the edge does not jump on the first move.
      const local = softLimit(point, camera.position.length()).applyQuaternion(earth.quaternion.clone().invert());
      grab = { lon: Math.atan2(local.x, local.z), lat: Math.asin(MathUtils.clamp(local.y, -1, 1)), id: e.pointerId, t: e.timeStamp };
      spin = [0, 0];
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!grab || e.pointerId !== grab.id) {
        if (!grab) canvas.style.cursor = pointerOnSphere(e).hit ? 'grab' : '';
        return;
      }
      const target = softLimit(pointerOnSphere(e).point, camera.position.length());
      const [y, p] = solveGrab(grab.lon, grab.lat, target, yaw);
      const dt = Math.max(e.timeStamp - grab.t, 1);
      spin = [(y - yaw) / dt, (p - pitch) / dt];
      [yaw, pitch, grab.t] = [y, p, e.timeStamp];
      turn();
      redraw();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (!grab || e.pointerId !== grab.id) return;
      if (e.timeStamp - grab.t > 80) spin = [0, 0]; // held still before letting go: no flick
      grab = undefined;
      canvas.style.cursor = 'grab';
      last = performance.now();
      redraw();
    };
    const listening = new AbortController();
    const { signal } = listening;
    canvas.addEventListener('pointerdown', onDown, { signal });
    canvas.addEventListener('pointermove', onMove, { signal });
    canvas.addEventListener('pointerup', onUp, { signal });
    canvas.addEventListener('pointercancel', onUp, { signal });

    const observer = new ResizeObserver(() => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      camera.aspect = w / h;
      // Keep the globe fitted to the shorter side in portrait too.
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(FOV / 2)) / Math.min(1, w / h)));
      camera.updateProjectionMatrix();
      redraw();
    });
    observer.observe(el);

    let colormap = ''; // the current one, by content: an import can replace a map under the same id
    const setColormap = (c: Colormap) => {
      const key = JSON.stringify(c);
      if (key === colormap) return;
      colormap = key;
      lutData.set(bakeLut(c));
      lut.needsUpdate = true;
      redraw();
    };

    // One field texture, refilled in place when only the values change (e.g. a new year), so
    // stepping through time re-uploads data without allocating.
    let texture: DataTexture | undefined;
    let wanted = -1;
    const setYear = async (year: number) => {
      if (year === wanted) return;
      wanted = year;
      const f = await load(year);
      if (year !== wanted || !alive) return; // a newer request won
      if (texture && texture.image.width === f.width && texture.image.height === f.height) {
        texture.image.data = f.values;
        texture.needsUpdate = true;
      } else {
        texture?.dispose();
        texture = material.uniforms.field.value = gridTexture(renderer, f);
      }
      material.uniforms.range.value = f.range ?? [0, Math.max(...f.values)];
      globe.visible = true;
      redraw();
    };

    let alive = true;
    let coast: Awaited<ReturnType<typeof createCoastlines>> | undefined;
    createCoastlines((lon, lat) => toXyz(lon, lat, 1.002)).then((lines) => {
      if (!alive) return disposeCoastlines(lines);
      lines.material.opacity = 0.6;
      earth.add((coast = lines));
      redraw();
    });

    setColormap(initial.colormap);
    setYear(initial.year);

    return {
      update(state) {
        setColormap(state.colormap);
        setYear(state.year);
      },
      destroy() {
        alive = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        listening.abort();
        if (coast) disposeCoastlines(coast);
        [texture, lut, material, geometry, haloMaterial, haloGeometry].forEach((r) => r?.dispose());
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
  },
});
