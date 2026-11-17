import {
  AdditiveBlending,
  BackSide,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  MathUtils,
  Group,
  LineSegments,
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
import type { Field, Statistic } from '../data/cmip6';
import { bakeLut, LUT_SIZE, type Colormap } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { softLimit, solveGrab } from './grab';
import type { Viewport } from './types';

const FOV = 30;
const FILL = 0.78; // share of the shorter side the globe spans at the start
const START = { lon: 15, lat: 12 }; // what faces the camera first

const AMBIENT = 0.5; // share of the colour kept on surfaces facing away from the light
// Light from the upper left of the camera, the usual hillshade direction: slopes read as light and shadow,
// which a light from the camera itself would show only faintly face-on.
const LIGHT = new Vector3(-0.45, 0.5, 0.74).normalize();
// A stipple dot's radius as a share of the dot spacing (shared state, degrees): bigger dots, fewer of them.
const DOT_RADIUS = 0.2;

// Longitude and latitude come from the sphere position (lon 0 at +z, lon 90 at +x, north at +y), so colours
// are exact at any mesh resolution, with no pinching at the poles. The surface rises radially with a second
// field, the relief (0 when there is none), sampled the same way in the vertex shader.
const lonLat = /* glsl */ `
  uniform sampler2D relief;
  uniform vec2 reliefRange;
  uniform float reliefScale;
  vec2 lonLatUv(vec3 p) {
    return vec2(atan(p.x, p.z) / 6.2831853 + 0.5, asin(clamp(p.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  }
  float height(vec2 uv) {
    return reliefScale * clamp((texture2D(relief, uv).r - reliefRange.x) / (reliefRange.y - reliefRange.x), 0.0, 1.0);
  }
`;
const vertexShader = /* glsl */ `
  ${lonLat}
  uniform float lift; // coastlines sit just above the surface
  varying vec3 vPos;
  void main() {
    vPos = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos * (1.0 + lift + height(lonLatUv(vPos))), 1.0);
  }
`;
// Shading: the relief's normal from its slope (central differences one grid cell apart), lit from a fixed direction
// (`light`, in globe coordinates). With no relief it is plain shading of a sphere.
const fragmentShader = /* glsl */ `
  ${lonLat}
  uniform sampler2D field;
  uniform sampler2D lut;
  uniform vec2 range;
  uniform vec2 texel; // one relief grid cell in uv
  uniform vec3 light;
  uniform sampler2D stipple;
  uniform float stippleOn;
  uniform float stippleThreshold;
  uniform float stippleSpacing; // degrees between rows, and between dots along a row (fewer toward the poles)
  varying vec3 vPos;

  vec3 colorAt(vec2 uv) {
    float t = clamp((texture2D(field, uv).r - range.x) / (range.y - range.x), 0.0, 1.0);
    return texture2D(lut, vec2((0.5 + t * ${(LUT_SIZE - 1).toFixed(1)}) / ${LUT_SIZE.toFixed(1)}, 0.5)).rgb;
  }

  // A stipple dot: rgba with alpha 1 inside a dot whose centre cell is at or above the threshold, 0 elsewhere
  // (edges antialiased). Dots are fixed to the surface, so they turn with the globe, and each is whole: the
  // threshold and the ink (dark on light colours, light on dark) are decided at its centre, not per pixel.
  vec4 stippleDot(float lon, float lat) {
    float sp = stippleSpacing;
    float latD = degrees(lat), lonD = degrees(lon);
    float latC = -90.0 + (floor((latD + 90.0) / sp) + 0.5) * sp;
    float width = 360.0 / max(1.0, floor(360.0 / sp * cos(radians(latC)) + 0.5));
    float lonC = -180.0 + (floor((lonD + 180.0) / width) + 0.5) * width;
    float d = length(vec2((lonD - lonC) * cos(lat), latD - latC));
    float aa = fwidth(d);
    float radius = ${DOT_RADIUS.toFixed(2)} * sp;
    float inside = 1.0 - smoothstep(radius - aa, radius + aa, d);
    vec2 centre = vec2((lonC + 180.0) / 360.0, (latC + 90.0) / 180.0);
    float on = inside * step(stippleThreshold, texture2D(stipple, centre).r);
    vec3 ink = dot(colorAt(centre), vec3(0.299, 0.587, 0.114)) > 0.45 ? vec3(0.08) : vec3(0.95);
    return vec4(ink, on);
  }

  void main() {
    vec3 p = normalize(vPos);
    vec2 uv = lonLatUv(p);
    vec3 rgb = colorAt(uv);

    float lon = (uv.x - 0.5) * 6.2831853, lat = (uv.y - 0.5) * 3.1415927;
    float r = 1.0 + height(uv);
    float dLon = (height(uv + vec2(texel.x, 0.0)) - height(uv - vec2(texel.x, 0.0))) / (2.0 * texel.x * 6.2831853);
    float dLat = (height(uv + vec2(0.0, texel.y)) - height(uv - vec2(0.0, texel.y))) / (2.0 * texel.y * 3.1415927);
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
    vec3 n = normalize(p - (dLon / max(cos(lat), 0.05) * east + dLat * north) / r);
    if (stippleOn > 0.5) {
      vec4 stippled = stippleDot(lon, lat);
      rgb = mix(rgb, stippled.rgb, 0.9 * stippled.a);
    }
    float lit = ${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * max(dot(n, light), 0.0);
    gl_FragColor = vec4(rgb * lit, 1.0);
  }
`;
const coastShader = /* glsl */ `
  void main() {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 0.6);
  }
`;
const haloVertex = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

// The main globe of the full-screen layout: a field on a sphere with coastlines; the surface can rise with one
// statistic (elevation) and be stippled where another passes its threshold, as picked in the shared state.
// Drag to rotate (the point grabbed stays under the pointer, a flick coasts to a stop), scroll or pinch to zoom.
// `load` and the statistics' loaders give the fields for a year (memoized by the caller). Draws only while
// something changes: a frame per input event, and frames while a flick or a zoom damps out.
export const stageGlobe = (load: (year: number) => Field | Promise<Field>, statistics: Statistic[]): Viewport => ({
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);

    const lutData = new Uint8Array(LUT_SIZE * 4);
    const lut = new DataTexture(lutData, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
    lut.minFilter = lut.magFilter = LinearFilter;
    // Shared by the surface and the coastlines, so both rise together.
    const reliefUniforms = { relief: { value: null as DataTexture | null }, reliefRange: { value: [0, 1] }, reliefScale: { value: 0 } };
    const light = new Vector3();
    const material = new ShaderMaterial({
      uniforms: {
        ...reliefUniforms,
        field: { value: null },
        lut: { value: lut },
        range: { value: [0, 1] },
        texel: { value: [1, 1] },
        light: { value: light },
        lift: { value: 0 },
        stipple: { value: null as DataTexture | null },
        stippleOn: { value: 0 },
        stippleSpacing: { value: initial.stippleSize },
        stippleThreshold: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });
    const geometry = new SphereGeometry(1, 360, 180); // a vertex per grid cell, so the relief is followed
    const globe = new Mesh(geometry, material);
    globe.visible = false; // until the first field arrives
    const haloGeometry = new SphereGeometry(HALO, 64, 32);
    const haloMaterial = new ShaderMaterial({
      vertexShader: haloVertex,
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
      light.copy(LIGHT).applyQuaternion(earth.quaternion.clone().invert()); // fixed to the view, not the globe
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

    // One texture per field, refilled in place when only the values change (e.g. a new year), so
    // stepping through time re-uploads data without allocating.
    const fill = (texture: DataTexture | null, f: Field): DataTexture => {
      if (texture && texture.image.width === f.width && texture.image.height === f.height) {
        texture.image.data = f.values;
        texture.needsUpdate = true;
        return texture;
      }
      texture?.dispose();
      return gridTexture(renderer, f);
    };
    const rangeOf = (f: Field) => f.range ?? [0, Math.max(...f.values)];
    // Elevation height (shared state, a fraction of the radius) applies only while a statistic is shown;
    // changing it just sets the uniform.
    let [scale, elevated] = [initial.elevationScale, false];
    const setScale = () => {
      reliefUniforms.reliefScale.value = elevated ? scale : 0;
      redraw();
    };
    let wanted = '';
    const setData = async ({ year, elevation, stipple }: { year: number; elevation: string; stipple: string }) => {
      const key = `${year} ${elevation} ${stipple}`;
      if (key === wanted) return;
      wanted = key;
      const [e, s] = [elevation, stipple].map((id) => statistics.find((st) => st.id === id));
      const [f, r, st] = await Promise.all([load(year), e?.load(year), s?.load(year)]);
      if (key !== wanted || !alive) return; // a newer request won
      const u = material.uniforms;
      u.field.value = fill(u.field.value, f);
      u.range.value = rangeOf(f);
      elevated = Boolean(r);
      setScale();
      if (r) {
        reliefUniforms.relief.value = fill(reliefUniforms.relief.value, r);
        reliefUniforms.reliefRange.value = e!.range;
        u.texel.value = [1 / r.width, 1 / r.height];
      }
      u.stippleOn.value = st ? 1 : 0;
      if (st) {
        u.stipple.value = fill(u.stipple.value, st);
        u.stippleThreshold.value = s!.threshold;
      }
      globe.visible = true;
      redraw();
    };

    let alive = true;
    let coast: LineSegments | undefined;
    // Coastlines rise with the relief in the same vertex shader, a little above the surface.
    const coastMaterial = new ShaderMaterial({
      uniforms: { ...reliefUniforms, lift: { value: 0.003 } },
      vertexShader,
      fragmentShader: coastShader,
      transparent: true,
    });
    createCoastlines((lon, lat) => toXyz(lon, lat, 1)).then((lines) => {
      if (!alive) return disposeCoastlines(lines);
      lines.material.dispose();
      earth.add((coast = new LineSegments(lines.geometry, coastMaterial)));
      redraw();
    });

    setColormap(initial.colormap);
    setData(initial);

    return {
      update(state) {
        setColormap(state.colormap);
        setData(state);
        if (state.stippleSize !== material.uniforms.stippleSpacing.value) {
          material.uniforms.stippleSpacing.value = state.stippleSize;
          redraw();
        }
        if (state.elevationScale !== scale) {
          scale = state.elevationScale;
          setScale();
        }
      },
      destroy() {
        alive = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        listening.abort();
        coast?.geometry.dispose();
        const u = material.uniforms;
        [u.field.value, u.stipple.value, reliefUniforms.relief.value, lut, material, coastMaterial, geometry, haloMaterial, haloGeometry].forEach((r) => r?.dispose());
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
  },
});
