import {
  AdditiveBlending,
  BackSide,
  DataTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Field } from '../data/cmip6';
import { colorAt, type Palette } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { gridTexture } from './fieldLayer';
import type { Viewport } from './types';

const LUT_SIZE = 256;
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

const toXyz = (lon: number, lat: number, r: number): [number, number, number] => {
  const [l, p] = [MathUtils.degToRad(lon), MathUtils.degToRad(lat)];
  return [r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l)];
};

// The main globe of the full-screen layout: a field on a sphere with coastlines, drag to rotate,
// scroll to zoom. `load` gives the field for the shared state (memoized by the caller). Draws only
// while something changes: a frame per input event, and frames while the rotation damps out.
export const stageGlobe = (load: (month: number) => Field | Promise<Field>): Viewport => ({
  name: 'Globe',
  engine: 'three.js',
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
    const scene = new Scene().add(new Mesh(haloGeometry, haloMaterial), globe);

    const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
    camera.position.set(...toXyz(START.lon, START.lat, 1 / Math.sin(MathUtils.degToRad(FOV / 2)) / FILL));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.25;
    controls.maxDistance = 10;

    let frame = 0;
    const draw = () => {
      frame = 0;
      // Slower rotation close up, so a drag moves the surface about as far as the pointer.
      controls.rotateSpeed = 0.15 + 0.3 * (camera.position.length() - 1);
      controls.update(); // fires 'change' (and so another frame) while damping
      renderer.render(scene, camera);
    };
    const redraw = () => (frame ||= requestAnimationFrame(draw));
    controls.addEventListener('change', redraw);

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

    let colormap: Palette | undefined;
    const setColormap = (c: Palette) => {
      if (c === colormap) return;
      colormap = c;
      for (let i = 0; i < LUT_SIZE; i++) lutData.set([...colorAt(c, i / (LUT_SIZE - 1)).map(Math.round), 255], i * 4);
      lut.needsUpdate = true;
      redraw();
    };

    // One field texture, refilled in place when only the values change (e.g. a new month), so
    // stepping through time re-uploads data without allocating.
    let texture: DataTexture | undefined;
    let wanted = -1;
    const setMonth = async (month: number) => {
      if (month === wanted) return;
      wanted = month;
      const f = await load(month);
      if (month !== wanted || !alive) return; // a newer request won
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
      scene.add((coast = lines));
      redraw();
    });

    setColormap(initial.colormap);
    setMonth(initial.month);

    return {
      update(state) {
        setColormap(state.colormap);
        setMonth(state.month);
      },
      destroy() {
        alive = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        if (coast) disposeCoastlines(coast);
        [texture, lut, material, geometry, haloMaterial, haloGeometry].forEach((r) => r?.dispose());
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
  },
});
