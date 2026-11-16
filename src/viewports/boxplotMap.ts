import {
  type Camera,
  Color,
  type DataTexture,
  type BufferGeometry,
  Group,
  LinearSRGBColorSpace,
  MathUtils,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadBoxplot, type Grid } from '../data/cmip6';
import { BOXPLOT } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { GLOBE_BACKGROUND, gridTexture } from './fieldLayer';
import { createOverlay } from './overlay';
import type { Viewport } from './types';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Shared by both shaders: latitudes outside the analysed range show `outside`, or nothing.
const latitude = /* glsl */ `
  uniform vec2 latRange;
  varying vec2 vUv;
  bool analysed() {
    float lat = vUv.y * 180.0 - 90.0;
    return lat >= latRange.x && lat <= latRange.y;
  }
`;

// Band fills from the nested level field; thresholds halfway between levels give the band edges. The cells
// every kept member covers get their own colour, so the agreed-wet core and agreed-dry cells don't look alike.
const fillShader = /* glsl */ `
  ${latitude}
  uniform sampler2D level;
  uniform vec3 outside, background, inside, band100, band50;
  void main() {
    float l = texture2D(level, vUv).r;
    vec3 rgb = !analysed() ? outside
      : l < 0.5 ? background
      : l < 1.5 || (l >= 2.5 && l < 3.5) ? band100
      : l < 2.5 ? band50
      : inside;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

// One contour of a field, antialiased: distance to the level in pixels from screen-space derivatives,
// so no line geometry is traced. Dashes are a screen-space checker, good enough for short outlier dashes.
const lineShader = /* glsl */ `
  ${latitude}
  uniform sampler2D field;
  uniform float level, width, dash;
  uniform vec3 color;
  void main() {
    float v = texture2D(field, vUv).r - level;
    float d = abs(v) / max(fwidth(v), 1e-6);
    float a = 1.0 - smoothstep(width * 0.5 - 0.5, width * 0.5 + 0.5, d);
    if (dash > 0.0 && mod(floor(gl_FragCoord.x / dash) + floor(gl_FragCoord.y / dash), 2.0) > 0.5) a = 0.0;
    if (a <= 0.0 || !analysed()) discard;
    gl_FragColor = vec4(color, a);
  }
`;

// Line styles in CSS pixels, drawn bottom to top.
const LINES = {
  mean: { width: 1.25, dash: 0 },
  outlier: { width: 1, dash: 3 },
  median: { width: 1.5, dash: 0 },
};

const FOV = 35; // as globe.ts, widened for portrait viewports so the sphere always fits
const DISTANCE = 1 / Math.sin(MathUtils.degToRad(FOV / 2));

// The two shapes: a 2 x 1 plane under an orthographic camera, letterboxed like flatMap.ts, or a sphere
// (equirectangular UVs, longitude 0 facing the camera) to rotate and zoom like globe.ts.
function shape(view: 'flat' | 'globe', el: HTMLElement, canvas: HTMLElement, render: () => void) {
  if (view === 'flat') {
    const camera = new OrthographicCamera(-1, 1, 0.5, -0.5, 0, 2);
    camera.position.z = 1;
    return {
      geometry: new PlaneGeometry(2, 1) as BufferGeometry,
      camera: camera as Camera,
      world: new Group(),
      project: (lon: number, lat: number): [number, number, number] => [lon / 180, lat / 180, 0.01],
      resize(aspect: number) {
        const halfW = Math.max(1, aspect / 2);
        const halfH = halfW / aspect;
        Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
        camera.updateProjectionMatrix();
      },
      dispose() {},
    };
  }
  el.style.background = GLOBE_BACKGROUND; // the canvas is transparent
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 20);
  camera.position.set(0, 0, DISTANCE);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 8;
  controls.rotateSpeed = 0.6;
  controls.addEventListener('change', render);
  const world = new Group();
  world.rotation.y = -Math.PI / 2; // longitude 0 faces the camera (it starts at +x)
  return {
    geometry: new SphereGeometry(1, 288, 180) as BufferGeometry, // one segment per cell of the 180 x 288 grid
    camera: camera as Camera,
    world,
    // Same mapping as SphereGeometry's UVs, just above the surface.
    project(lon: number, lat: number): [number, number, number] {
      const phi = MathUtils.degToRad(lon + 180);
      const theta = MathUtils.degToRad(90 - lat);
      const r = 1.003;
      return [-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta)];
    },
    resize(aspect: number) {
      camera.aspect = aspect;
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(FOV / 2)) / Math.min(1, aspect)));
      camera.updateProjectionMatrix();
    },
    dispose: () => controls.dispose(),
  };
}

const swatch = (style: string) => `<i style="display:inline-block;width:18px;margin-right:6px;vertical-align:middle;${style}"></i>`;

// Contour boxplot of the summer rain band (Whitaker et al. 2013, computed in prep): where the regions of
// June-August rain above the threshold lie across all summers, on a flat map or a globe. Its own colours,
// so the sidebar colormap does not apply.
export const boxplotMap = (view: 'flat' | 'globe'): Viewport => ({
  name: view === 'flat' ? 'Contour boxplot' : 'Contour boxplot globe',
  engine: 'three.js',
  mount(el) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // colours are display colours
    el.append(renderer.domElement);
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';
    const legend = createOverlay(el, 'left:8px;bottom:8px;font-size:12px;line-height:18px;display:none');

    const render = () => renderer.render(scene, camera);
    const { geometry, camera, world, project, resize, dispose } = shape(view, el, renderer.domElement, render);
    const scene = new Scene().add(world);
    const materials: ShaderMaterial[] = [];
    const textures: DataTexture[] = [];
    // Taken as display colours: three.js would otherwise linearize them, and nothing converts back.
    const color = (hex: string) => ({ value: new Color().setStyle(hex, LinearSRGBColorSpace) });

    // Layers share the geometry, so they have equal depths and draw in order (the depth test is
    // less-or-equal); it still hides the far side of the globe.
    const add = (fragmentShader: string, uniforms: Record<string, { value: unknown }>, latRange: number[]) => {
      const material = new ShaderMaterial({
        uniforms: { ...uniforms, latRange: { value: latRange } },
        vertexShader,
        fragmentShader,
        transparent: true,
      });
      materials.push(material);
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = world.children.length;
      world.add(mesh);
    };
    const texture = (grid: Grid) => textures[textures.push(gridTexture(renderer, grid)) - 1];

    const observer = new ResizeObserver(() => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      resize(w / h);
      render();
    });
    observer.observe(el);

    let alive = true;
    let coast: Awaited<ReturnType<typeof createCoastlines>> | undefined;
    Promise.all([loadBoxplot(), createCoastlines(project)]).then(
      ([b, lines]) => {
        if (!alive) return disposeCoastlines(lines);
        const ratio = renderer.getPixelRatio();
        const line = (grid: Grid, level: number, hex: string, style: { width: number; dash: number }) =>
          add(
            lineShader,
            {
              field: { value: texture(grid) },
              level: { value: level },
              width: { value: style.width * ratio },
              dash: { value: style.dash * ratio },
              color: color(hex),
            },
            b.latRange,
          );
        const { outside, background, inside, band100, band50 } = BOXPLOT;
        add(
          fillShader,
          {
            level: { value: texture(b.level) },
            ...Object.fromEntries(Object.entries({ outside, background, inside, band100, band50 }).map(([k, v]) => [k, color(v)])),
          },
          b.latRange,
        );
        coast = lines;
        lines.material.color.setStyle(BOXPLOT.coast, LinearSRGBColorSpace);
        lines.renderOrder = world.children.length;
        world.add(lines);
        line(b.fraction, 0.5, BOXPLOT.mean, LINES.mean);
        b.outliers.forEach((o) => line(o, b.threshold, BOXPLOT.outlier, LINES.outlier));
        line(b.median, b.threshold, BOXPLOT.median, LINES.median);

        const [south, north] = b.latRange.map((l) => `${Math.abs(l)}°${l < 0 ? 'S' : 'N'}`);
        overlay.textContent = `${b.label} · ${south}–${north}`;
        legend.innerHTML = [
          `${swatch(`height:10px;background:${BOXPLOT.inside}`)}Above ${b.threshold} mm/day, all but outliers`,
          `${swatch(`height:10px;background:${BOXPLOT.band50}`)}50% band`,
          `${swatch(`height:10px;background:${BOXPLOT.band100}`)}100% band`,
          `${swatch(`border-top:3px solid ${BOXPLOT.median}`)}Median (${b.medianYear})`,
          `${swatch(`border-top:2px solid ${BOXPLOT.mean}`)}Mean`,
          `${swatch(`border-top:2px dashed ${BOXPLOT.outlier}`)}Outliers (${b.outlierYears.join(', ') || 'none'})`,
        ]
          .map((row) => `<div>${row}</div>`)
          .join('');
        legend.style.display = '';
        render();
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update() {}, // nothing here follows the shared state
      destroy() {
        alive = false;
        observer.disconnect();
        dispose();
        if (coast) disposeCoastlines(coast);
        materials.forEach((m) => m.dispose());
        textures.forEach((t) => t.dispose());
        geometry.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        el.style.background = '';
        overlay.remove();
        legend.remove();
      },
    };
  },
});
