import {
  AdditiveBlending,
  BackSide,
  CylinderGeometry,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
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
import type { Field, Metric } from '../data/cmip6';
import { bakeLut, LUT_SIZE, type Colormap } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { softLimit, solveGrab } from './grab';
import type { Viewport } from './types';

const FOV = 30;
const FILL = 0.78; // share of the shorter side the globe spans at the start
const START = { lon: 15, lat: 12 }; // what faces the camera first
const SPIN = (2 * Math.PI) / 90_000; // radians per millisecond when it spins on its own: a turn in 90 s

const AMBIENT = 0.5; // share of the colour kept on surfaces facing away from the light
// Light from the upper left of the camera, the usual hillshade direction: column sides read as light and shadow,
// which a light from the camera itself would show only faintly face-on.
const LIGHT = new Vector3(-0.45, 0.5, 0.74).normalize();
// A stipple dot's radius as a share of the dot spacing (shared state, degrees): bigger dots, fewer of them.
const DOT_RADIUS = 0.2;
const COLUMN_SIDES = 8;

// Shared by the surface and the columns: the field's colour, the stipple statistic and the light.
const commonGlsl = /* glsl */ `
  uniform sampler2D field;
  uniform sampler2D lut;
  uniform vec2 range;
  uniform vec3 light;
  uniform sampler2D stipple;
  uniform float stippleThreshold;
  vec2 lonLatUv(vec3 p) {
    return vec2(atan(p.x, p.z) / 6.2831853 + 0.5, asin(clamp(p.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  }
  vec3 colorAt(vec2 uv) {
    float t = clamp((texture2D(field, uv).r - range.x) / (range.y - range.x), 0.0, 1.0);
    return texture2D(lut, vec2((0.5 + t * ${(LUT_SIZE - 1).toFixed(1)}) / ${LUT_SIZE.toFixed(1)}, 0.5)).rgb;
  }
  float lit(vec3 n) {
    return ${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * max(dot(n, light), 0.0);
  }
`;
// Longitude and latitude come from the sphere position (lon 0 at +z, lon 90 at +x, north at +y), so colours
// are exact at any mesh resolution, with no pinching at the poles.
const vertexShader = /* glsl */ `
  uniform float lift; // coastlines sit just above the surface
  varying vec3 vPos;
  void main() {
    vPos = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos * (1.0 + lift), 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  ${commonGlsl}
  uniform float stippleOn;
  uniform float stippleSpacing; // degrees between rows, and between dots along a row (fewer toward the poles)
  varying vec3 vPos;

  // A stipple dot: rgba with alpha 1 inside a dot whose centre cell is at or above the threshold, 0 elsewhere
  // (edges antialiased). Dots are fixed to the surface, so they turn with the globe, and each is whole: the
  // threshold and the ink (dark on light colours, light on dark) are decided at its centre, not per pixel.
  // dotCentres() lays out the same centres for the columns.
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
    if (stippleOn > 0.5) {
      vec4 stippled = stippleDot((uv.x - 0.5) * 6.2831853, (uv.y - 0.5) * 3.1415927);
      rgb = mix(rgb, stippled.rgb, 0.9 * stippled.a);
    }
    gl_FragColor = vec4(rgb * lit(p), 1.0);
  }
`;
// A column through each stipple dot (one instance per dot centre, lon and lat in radians), standing
// radially from just under the surface to 1 + scale × value / top of the display range (clamped there), as wide as
// the dot. Below the threshold, or with no height, it collapses to a point and draws nothing, so the threshold,
// height and a new year only change uniforms and the texture. Coloured with the field at its centre.
const columnVertex = /* glsl */ `
  ${commonGlsl}
  attribute vec2 centre;
  uniform float columnScale;
  uniform float columnRadius; // in radians of arc, which is globe units at the surface
  uniform float statisticTop;
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    float lon = centre.x, lat = centre.y;
    vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
    float v = texture2D(stipple, uv).r;
    float h = columnScale * clamp(v / statisticTop, 0.0, 1.0);
    vec3 up = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 south = cross(east, up); // x, y, z to east, up, south keeps the geometry's winding
    float base = 1.0 - columnRadius; // the base's rim stays under the curved surface
    // CylinderGeometry stands on y (here 0 to 1), its cross-section in x and z.
    vec3 p = up * mix(base, 1.0 + h, position.y) + (east * position.x + south * position.z) * columnRadius;
    p *= step(stippleThreshold, v) * step(1e-4, h);
    vNormal = east * normal.x + up * normal.y + south * normal.z;
    vColor = colorAt(uv);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const columnFragment = /* glsl */ `
  ${commonGlsl}
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor * lit(normalize(vNormal)), 1.0);
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

// Stipple dot centres (lon, lat in radians) for a spacing in degrees: the layout of stippleDot() in the shader.
function dotCentres(spacing: number): Float32Array {
  const out: number[] = [];
  for (let latC = -90 + spacing / 2; latC < 90; latC += spacing) {
    const n = Math.max(1, Math.floor((360 / spacing) * Math.cos(MathUtils.degToRad(latC)) + 0.5));
    for (let j = 0; j < n; j++) out.push(MathUtils.degToRad(-180 + ((j + 0.5) * 360) / n), MathUtils.degToRad(latC));
  }
  return new Float32Array(out);
}

// The main globe of the full-screen layout: the selected metric's field on a sphere with coastlines, stippled
// where one of its statistics passes its threshold (as picked in the shared state), with a column through each
// dot as high as the statistic's value. It centres in the area right of `insetLeft` (a side pane) and below
// `insetTop` (the data tree), easing when they change.
// Drag to rotate (the point grabbed stays under the pointer, a flick coasts to a stop), scroll or pinch to zoom.
// `metrics()` gives the shown node's metrics, whose loaders give the fields for a year (memoized by the caller);
// they are read again when `node` in the shared state changes. Draws only while
// something changes: a frame per input event, frames while a flick or a zoom damps out, and every frame while it
// spins on its own (`spin` in the shared state: eastward, paused while grabbed, after a flick has coasted out).
export const stageGlobe = (metrics: () => Metric[]): Viewport => ({
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);

    const lookup = () => {
      const texture = new DataTexture(new Uint8Array(LUT_SIZE * 4), LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
      texture.minFilter = texture.magFilter = LinearFilter;
      return texture;
    };
    const [lut, columnLut] = [lookup(), lookup()];
    const light = new Vector3();
    // Shared by the surface and the columns (the same objects, so setting one sets both).
    const common = {
      field: { value: null as DataTexture | null },
      lut: { value: lut },
      range: { value: [0, 1] },
      light: { value: light },
      stipple: { value: null as DataTexture | null },
      stippleThreshold: { value: 0 },
    };
    const material = new ShaderMaterial({
      uniforms: { ...common, lift: { value: 0 }, stippleOn: { value: 0 }, stippleSpacing: { value: initial.stippleSize } },
      vertexShader,
      fragmentShader,
    });
    const geometry = new SphereGeometry(1, 96, 48); // colours are per pixel, so a coarse mesh will do
    const globe = new Mesh(geometry, material);
    globe.visible = false; // until the first field arrives

    // Columns: one instance per stipple dot, drawn in one call; the shader hides those below the threshold.
    // A new geometry per dot spacing: three fixes an instanced geometry's largest instance count when first drawn.
    const cylinder = new CylinderGeometry(1, 1, 1, COLUMN_SIDES).translate(0, 0.5, 0);
    const columnGeometry = (spacing: number) => {
      const g = new InstancedBufferGeometry();
      g.setIndex(cylinder.index);
      g.setAttribute('position', cylinder.getAttribute('position'));
      g.setAttribute('normal', cylinder.getAttribute('normal'));
      const centres = dotCentres(spacing);
      g.setAttribute('centre', new InstancedBufferAttribute(centres, 2));
      g.instanceCount = centres.length / 2;
      return g;
    };
    const columnUniforms = {
      lut: { value: lut }, // the map's, or the columns' own (setColumnColormap)
      columnScale: { value: 0 },
      columnRadius: { value: 0 },
      statisticTop: { value: 1 },
    };
    const columnMaterial = new ShaderMaterial({
      uniforms: { ...common, ...columnUniforms },
      vertexShader: columnVertex,
      fragmentShader: columnFragment,
    });
    let spacing = initial.stippleSize;
    const columns = new Mesh(columnGeometry(spacing), columnMaterial);
    columns.frustumCulled = false; // the base geometry's bounds say nothing about where the instances stand
    columns.visible = false;
    columnUniforms.columnRadius.value = MathUtils.degToRad(DOT_RADIUS * spacing);
    const setSpacing = (sp: number) => {
      if (sp === spacing) return;
      spacing = sp;
      columns.geometry.dispose();
      columns.geometry = columnGeometry(sp);
      material.uniforms.stippleSpacing.value = sp;
      columnUniforms.columnRadius.value = MathUtils.degToRad(DOT_RADIUS * sp);
      redraw();
    };
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
    const earth = new Group().add(globe, columns);
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
    const MIN_DISTANCE = 1.25; // raised while the columns can be higher (setScale)
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = 10;

    // Centre the globe right of a side pane and below a top pane: the projection is shifted (setViewOffset), the
    // camera stays on its axis, so grabbing and picking are unchanged. The globe is fitted to the area that remains.
    let [width, height] = [1, 1];
    let inset = [initial.insetLeft, initial.insetTop]; // target, in px
    let shown = [...inset]; // current, eased toward the target
    const frameView = () => {
      const fit = Math.min(1, Math.max(width - shown[0], width * 0.4) / height, Math.max(height - shown[1], height * 0.4) / height);
      camera.aspect = width / height;
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(FOV / 2)) / fit));
      camera.setViewOffset(width, height, -shown[0] / 2, -shown[1] / 2, width, height);
      camera.updateProjectionMatrix();
    };

    let frame = 0;
    let last = 0; // time of the previous frame, for the flick and the spin
    let spin = [0, 0]; // yaw and pitch per millisecond after a flick
    let spinning = initial.spin; // turning on its own
    const draw = (now: number) => {
      frame = 0;
      controls.update(); // fires 'change' (and so another frame) while the zoom damps
      const dt = Math.min(now - last, 50);
      if (!grab && (spin[0] || spin[1])) {
        [yaw, pitch] = [yaw + spin[0] * dt, MathUtils.clamp(pitch + spin[1] * dt, -Math.PI / 2, Math.PI / 2)];
        turn();
        const decay = Math.exp(-dt / 250);
        spin = spin.map((v) => (Math.abs(v * decay) < 1e-6 ? 0 : v * decay));
        redraw();
      } else if (!grab && spinning) {
        yaw += SPIN * dt; // the surface moves eastward, as the Earth turns
        turn();
        redraw();
      }
      if (shown[0] !== inset[0] || shown[1] !== inset[1]) {
        shown = shown.map((s, i) => (Math.abs(inset[i] - s) < 0.5 ? inset[i] : s + (inset[i] - s) * 0.25));
        frameView();
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
      [width, height] = [w, h];
      frameView(); // fitted to the shorter side of the usable area, in portrait too
      redraw();
    });
    observer.observe(el);

    // The current maps, by content: an import can replace a map under the same id.
    const baked = new Map<DataTexture, string>();
    const bake = (texture: DataTexture, c: Colormap) => {
      const key = JSON.stringify(c);
      if (key === baked.get(texture)) return;
      baked.set(texture, key);
      (texture.image.data as Uint8Array).set(bakeLut(c));
      texture.needsUpdate = true;
      redraw();
    };
    const setColumnColormap = (c: Colormap | null) => {
      if (c) bake(columnLut, c);
      if (columnUniforms.lut.value === (c ? columnLut : lut)) return;
      columnUniforms.lut.value = c ? columnLut : lut;
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
    // Column height (shared state: a fraction of the radius times an integer multiplier) applies only while a
    // statistic is stippled; changing it sets the uniform and keeps the closest zoom outside the tallest columns
    // (the next frame's controls.update() clamps the camera).
    let [scale, stippling] = [initial.columnScale * initial.columnMultiplier, false];
    const setScale = () => {
      columnUniforms.columnScale.value = scale;
      columns.visible = stippling && scale > 0;
      controls.minDistance = Math.max(MIN_DISTANCE, 1.05 + (columns.visible ? scale : 0));
      redraw();
    };
    // The stipple threshold: the statistic's default unless moved (shared `thresholds`); only a uniform changes.
    let [thresholds, stippled] = [initial.thresholds, undefined as { key: string; fallback: number } | undefined];
    const setThreshold = () => {
      const t = stippled ? (thresholds[stippled.key] ?? stippled.fallback) : 0;
      if (t === common.stippleThreshold.value) return;
      common.stippleThreshold.value = t;
      redraw();
    };
    let wanted = '';
    const setData = async (state: { node: string; metric: string; year: number; stipple: string }) => {
      const { node, metric, year, stipple } = state;
      const key = `${node} ${metric} ${year} ${stipple}`;
      if (key === wanted) return;
      wanted = key;
      const shown = metrics();
      const m = shown.find((x) => x.id === metric) ?? shown[0];
      const s = m.statistics.find((st) => st.id === stipple);
      const [f, st] = await Promise.all([m.load(year), s?.load(year)]);
      if (key !== wanted || !alive) return; // a newer request won
      common.field.value = fill(common.field.value, f);
      common.range.value = rangeOf(f);
      material.uniforms.stippleOn.value = st ? 1 : 0;
      stippling = Boolean(st);
      setScale();
      if (st) {
        common.stipple.value = fill(common.stipple.value, st);
        columnUniforms.statisticTop.value = s!.range[1];
        stippled = { key: `${m.id}/${s!.id}`, fallback: s!.threshold };
        setThreshold();
      }
      globe.visible = true;
      redraw();
    };

    let alive = true;
    let coast: LineSegments | undefined;
    // Coastlines a little above the surface, so they are not lost in it.
    const coastMaterial = new ShaderMaterial({
      uniforms: { lift: { value: 0.003 } },
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

    bake(lut, initial.colormap);
    setColumnColormap(initial.columnColormap);
    setData(initial);

    return {
      update(state) {
        bake(lut, state.colormap);
        setColumnColormap(state.columnColormap);
        setData(state);
        if (state.insetLeft !== inset[0] || state.insetTop !== inset[1]) {
          inset = [state.insetLeft, state.insetTop];
          redraw(); // eases toward it frame by frame
        }
        thresholds = state.thresholds;
        setThreshold();
        if (state.spin !== spinning) {
          spinning = state.spin;
          last = performance.now(); // no jump from the time it stood still
          redraw();
        }
        setSpacing(state.stippleSize);
        if (state.columnScale * state.columnMultiplier !== scale) {
          scale = state.columnScale * state.columnMultiplier;
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
        [common.field.value, common.stipple.value, lut, columnLut, material, coastMaterial, geometry, columnMaterial, columns.geometry, cylinder, haloMaterial, haloGeometry].forEach((r) => r?.dispose());
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
  },
});
