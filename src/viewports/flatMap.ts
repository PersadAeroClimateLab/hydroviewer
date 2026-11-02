import {
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderer,
} from 'three';
import { loadMonth } from '../data/cmip6';
import { colorAt } from './colormaps';
import type { Viewport } from './types';

const LUT_SIZE = 256;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The field stays a float texture; the colormap is applied per pixel on the GPU.
const fragmentShader = /* glsl */ `
  uniform sampler2D field;
  uniform sampler2D lut;
  uniform float vmax;
  varying vec2 vUv;
  void main() {
    float t = clamp(texture2D(field, vUv).r / vmax, 0.0, 1.0);
    float u = (0.5 + t * ${(LUT_SIZE - 1).toFixed(1)}) / ${LUT_SIZE.toFixed(1)};
    gl_FragColor = vec4(texture2D(lut, vec2(u, 0.5)).rgb, 1.0);
  }
`;

// Flat equirectangular map of one month: a 2:1 plane under an orthographic camera.
export const flatMap: Viewport = {
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:4px;font:14px system-ui,sans-serif;' +
      'color:var(--fg);background:color-mix(in srgb, var(--bg) 80%, transparent);pointer-events:none';
    el.append(overlay);
    overlay.textContent = 'Loading…';

    const lutData = new Uint8Array(LUT_SIZE * 4);
    const lut = new DataTexture(lutData, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
    lut.minFilter = lut.magFilter = LinearFilter;
    const fillLut = (colormap: typeof initial.colormap) => {
      for (let i = 0; i < LUT_SIZE; i++) {
        lutData.set([...colorAt(colormap, i / (LUT_SIZE - 1)).map(Math.round), 255], i * 4);
      }
      lut.needsUpdate = true;
    };
    fillLut(initial.colormap);

    const geometry = new PlaneGeometry(2, 1);
    const material = new ShaderMaterial({
      uniforms: { field: { value: null }, lut: { value: lut }, vmax: { value: 1 } },
      vertexShader,
      fragmentShader,
    });
    const mesh = new Mesh(geometry, material);
    mesh.visible = false; // until the field arrives
    const scene = new Scene().add(mesh);
    const camera = new OrthographicCamera(-1, 1, 0.5, -0.5, 0, 1);

    const render = () => renderer.render(scene, camera);

    const resize = () => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      const aspect = w / h;
      const halfW = Math.max(1, aspect / 2); // fit the 2 x 1 plane, letterboxed
      const halfH = halfW / aspect;
      Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    let alive = true;
    let fieldTexture: DataTexture | undefined;
    loadMonth(0).then(
      (f) => {
        if (!alive) return;
        fieldTexture = new DataTexture(f.values, f.width, f.height, RedFormat, FloatType);
        fieldTexture.minFilter = fieldTexture.magFilter = renderer.extensions.has('OES_texture_float_linear')
          ? LinearFilter
          : NearestFilter;
        fieldTexture.needsUpdate = true;
        material.uniforms.field.value = fieldTexture;
        // Colour scale tops out at the 99th percentile: precipitation has a long tail.
        const vmax = [...f.values].sort((a, b) => a - b)[Math.floor(0.99 * f.values.length)];
        material.uniforms.vmax.value = vmax;
        overlay.textContent = `pr · ${f.label} · 0–${vmax.toFixed(1)} ${f.units}`;
        mesh.visible = true;
        render();
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update(state) {
        fillLut(state.colormap);
        render();
      },
      destroy() {
        alive = false;
        observer.disconnect();
        fieldTexture?.dispose();
        lut.dispose();
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        overlay.remove();
      },
    };
  },
};
