import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LineSegments,
  MathUtils,
  Mesh,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Field, Metric } from '../data/cmip6';
import type { Globe } from '../state/globes';
import type { SharedState } from '../state/shared.svelte';
import { bakeLut, LUT_SIZE, type Colormap } from './colormaps';

const AMBIENT = 0.5; // share of the colour kept on surfaces facing away from the light
// Light from the upper left of the camera, the usual hillshade direction: column sides read as light and shadow,
// which a light from the camera itself would show only faintly face-on.
export const LIGHT = new Vector3(-0.45, 0.5, 0.74).normalize();
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
export const toXyz = (lon: number, lat: number, r: number): [number, number, number] => {
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

// What every globe shares, made once by the stage: the lookup tables (the map's and the columns' own), the light,
// the geometry (sphere, halo, coastlines once loaded, the columns for the current dot spacing) and the shared
// uniforms. Setting one of these changes every globe.
export function globeKit(renderer: WebGLRenderer, spacing: number) {
  const lookup = () => {
    const texture = new DataTexture(new Uint8Array(LUT_SIZE * 4), LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
    texture.minFilter = texture.magFilter = LinearFilter;
    return texture;
  };
  const [lut, columnLut] = [lookup(), lookup()];
  const uniforms = {
    lut: { value: lut },
    columnLut: { value: lut }, // the map's, or the columns' own (setColumnColormap)
    light: { value: new Vector3() }, // in globe coordinates; the globes all turn together
    stippleSpacing: { value: spacing },
    columnScale: { value: 0 },
    columnRadius: { value: MathUtils.degToRad(DOT_RADIUS * spacing) },
  };
  // Columns: one instance per stipple dot, drawn in one call; the shader hides those below the threshold. A new
  // geometry per dot spacing (three fixes an instanced geometry's largest instance count when first drawn).
  const cylinder = new CylinderGeometry(1, 1, 1, COLUMN_SIDES).translate(0, 0.5, 0);
  const columnGeometry = (sp: number) => {
    const g = new InstancedBufferGeometry();
    g.setIndex(cylinder.index);
    g.setAttribute('position', cylinder.getAttribute('position'));
    g.setAttribute('normal', cylinder.getAttribute('normal'));
    const centres = dotCentres(sp);
    g.setAttribute('centre', new InstancedBufferAttribute(centres, 2));
    g.instanceCount = centres.length / 2;
    return g;
  };
  const kit = {
    renderer,
    uniforms,
    sphere: new SphereGeometry(1, 96, 48), // colours are per pixel, so a coarse mesh will do
    halo: new SphereGeometry(HALO, 64, 32),
    haloMaterial: new ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloShader,
      side: BackSide,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
    // Coastlines a little above the surface, so they are not lost in it.
    coastMaterial: new ShaderMaterial({ uniforms: { lift: { value: 0.003 } }, vertexShader, fragmentShader: coastShader, transparent: true }),
    coast: undefined as BufferGeometry | undefined,
    columns: columnGeometry(spacing),
    // Returns whether anything changed.
    setSpacing(sp: number) {
      if (sp === uniforms.stippleSpacing.value) return false;
      kit.columns.dispose();
      kit.columns = columnGeometry(sp);
      uniforms.stippleSpacing.value = sp;
      uniforms.columnRadius.value = MathUtils.degToRad(DOT_RADIUS * sp);
      return true;
    },
    // The current maps, by content: an import can replace a map under the same id. Returns whether anything changed.
    setColormaps(map: Colormap, columns: Colormap | null) {
      const changed = [bake(lut, map), columns ? bake(columnLut, columns) : false].some(Boolean);
      const target = columns ? columnLut : lut;
      if (uniforms.columnLut.value === target) return changed;
      uniforms.columnLut.value = target;
      return true;
    },
    dispose() {
      [lut, columnLut, kit.sphere, kit.halo, kit.haloMaterial, kit.coastMaterial, kit.coast, kit.columns, cylinder].forEach((r) => r?.dispose());
    },
  };
  const baked = new Map<DataTexture, string>();
  const bake = (texture: DataTexture, c: Colormap) => {
    const key = JSON.stringify(c);
    if (key === baked.get(texture)) return false;
    baked.set(texture, key);
    (texture.image.data as Uint8Array).set(bakeLut(c));
    texture.needsUpdate = true;
    return true;
  };
  return kit;
}
export type GlobeKit = ReturnType<typeof globeKit>;

// One globe: the selected metric's field for its node and year on a sphere with coastlines, stippled where the
// picked statistic passes its threshold, with a column through each dot as high as the statistic's value. Its
// scene is drawn by the stage (globeStage.ts) into the globe's cell; `earth` is turned by the stage. `metrics(node)`
// gives a loaded node's metrics (undefined while it loads). Loads are latest-wins: a newer year, node, metric or
// statistic drops a slow one. `redraw` asks the stage for a frame.
export function createGlobe(kit: GlobeKit, metrics: (node: string) => Metric[] | undefined, redraw: () => void) {
  const own = {
    field: { value: null as DataTexture | null },
    range: { value: [0, 1] },
    stipple: { value: null as DataTexture | null },
    stippleThreshold: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms: {
      ...own,
      lut: kit.uniforms.lut,
      light: kit.uniforms.light,
      lift: { value: 0 },
      stippleOn: { value: 0 },
      stippleSpacing: kit.uniforms.stippleSpacing,
    },
    vertexShader,
    fragmentShader,
  });
  const surface = new Mesh(kit.sphere, material);
  surface.visible = false; // until the first field arrives
  const columnOwn = { range: { value: [0, 1] }, statisticTop: { value: 1 } }; // the map's range, or the columns' own
  const columnMaterial = new ShaderMaterial({
    uniforms: {
      ...own,
      ...columnOwn,
      lut: kit.uniforms.columnLut,
      light: kit.uniforms.light,
      columnScale: kit.uniforms.columnScale,
      columnRadius: kit.uniforms.columnRadius,
    },
    vertexShader: columnVertex,
    fragmentShader: columnFragment,
  });
  const columns = new Mesh(kit.columns, columnMaterial);
  columns.frustumCulled = false; // the base geometry's bounds say nothing about where the instances stand
  columns.visible = false;
  // The camera stays on +z; the globe and its coastlines turn (see solveGrab).
  const earth = new Group().add(surface, columns);
  const scene = new Scene().add(new Mesh(kit.halo, kit.haloMaterial), earth);
  let coast: LineSegments | undefined;

  // One texture per field, refilled in place when only the values change (e.g. a new year), so stepping through
  // time re-uploads data without allocating.
  const fill = (texture: DataTexture | null, f: Field): DataTexture => {
    if (texture && texture.image.width === f.width && texture.image.height === f.height) {
      texture.image.data = f.values;
      texture.needsUpdate = true;
      return texture;
    }
    texture?.dispose();
    return gridTexture(kit.renderer, f);
  };
  const rangeOf = (f: Field) => f.range ?? [0, Math.max(...f.values)];

  // The latest shared settings, applied whenever they or the data change; each only sets uniforms.
  let settings: Pick<SharedState, 'thresholds' | 'ranges' | 'columnRanges' | 'columnColormap' | 'colormap'> | undefined;
  let stippled: { key: string; fallback: number } | undefined; // the stippled statistic, for its threshold
  let showing: { id: string; range: [number, number] } | undefined; // the metric on the globe now
  const apply = () => {
    if (!settings || !showing) return;
    // The stipple threshold: the statistic's default unless moved (shared `thresholds`).
    const t = stippled ? (settings.thresholds[stippled.key] ?? stippled.fallback) : 0;
    // Colour ranges: the metric's (from its field) unless moved (shared `ranges`, `columnRanges`); the columns
    // follow the map's range unless they have a colormap of their own.
    const map = settings.ranges[showing.id] ?? showing.range;
    const ownMap = Boolean(settings.columnColormap) && settings.columnColormap!.id !== settings.colormap.id;
    const column = ownMap ? (settings.columnRanges[showing.id] ?? showing.range) : map;
    const [u, v] = [material.uniforms.range.value, columnOwn.range.value];
    if (t === material.uniforms.stippleThreshold.value && u[0] === map[0] && u[1] === map[1] && v[0] === column[0] && v[1] === column[1]) return;
    material.uniforms.stippleThreshold.value = t;
    material.uniforms.range.value = [map[0], map[1]];
    columnOwn.range.value = [column[0], column[1]];
    redraw();
  };

  let wanted = '';
  let alive = true;
  const load = async (node: string, metric: string, year: number, stipple: string) => {
    const shown = metrics(node);
    const key = `${node} ${metric} ${year} ${stipple}`;
    if (!shown || key === wanted) return; // not loaded yet: asked again once it is
    wanted = key;
    const m = shown.find((x) => x.id === metric) ?? shown[0];
    const s = m.statistics.find((st) => st.id === stipple);
    const [f, st] = await Promise.all([m.load(year), s?.load(year)]);
    if (key !== wanted || !alive) return; // a newer request won
    material.uniforms.field.value = fill(material.uniforms.field.value, f);
    showing = { id: m.id, range: rangeOf(f) };
    material.uniforms.stippleOn.value = st ? 1 : 0;
    stippled = undefined;
    if (st) {
      material.uniforms.stipple.value = fill(material.uniforms.stipple.value, st);
      columnOwn.statisticTop.value = s!.range[1];
      stippled = { key: `${m.id}/${s!.id}`, fallback: s!.threshold };
    }
    surface.visible = true;
    apply();
    redraw();
  };

  return {
    scene,
    earth,
    // Before each frame: coastlines once loaded, the column geometry for the current dot spacing, columns shown
    // only while stippling with some height.
    prepare() {
      if (kit.coast && !coast) earth.add((coast = new LineSegments(kit.coast, kit.coastMaterial)));
      if (columns.geometry !== kit.columns) columns.geometry = kit.columns;
      columns.visible = Boolean(stippled) && kit.uniforms.columnScale.value > 0;
    },
    update(globe: Globe, state: SharedState) {
      settings = state;
      apply();
      load(globe.node, state.metric, globe.year, state.stipple);
    },
    dispose() {
      alive = false;
      [material.uniforms.field.value, material.uniforms.stipple.value, material, columnMaterial].forEach((r) => r?.dispose());
    },
  };
}
