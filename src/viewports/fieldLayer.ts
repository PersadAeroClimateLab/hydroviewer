import {
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  type WebGLRenderer,
} from 'three';
import type { Field } from '../data/cmip6';
import type { Colormap } from '../state/shared.svelte';
import { colorAt } from './colormaps';

const LUT_SIZE = 256;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

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

// A gridded field coloured on the GPU, for any geometry with equirectangular UVs (u: west to
// east, v: south to north). The field stays a float texture; the colormap is a lookup texture.
export function createFieldLayer(renderer: WebGLRenderer, colormap: Colormap) {
  const lutData = new Uint8Array(LUT_SIZE * 4);
  const lut = new DataTexture(lutData, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
  lut.minFilter = lut.magFilter = LinearFilter;

  const material = new ShaderMaterial({
    uniforms: { field: { value: null }, lut: { value: lut }, vmax: { value: 1 } },
    vertexShader,
    fragmentShader,
  });
  let texture: DataTexture | undefined;

  const setColormap = (c: Colormap) => {
    for (let i = 0; i < LUT_SIZE; i++) {
      lutData.set([...colorAt(c, i / (LUT_SIZE - 1)).map(Math.round), 255], i * 4);
    }
    lut.needsUpdate = true;
  };
  setColormap(colormap);

  return {
    material,
    setColormap,
    // Uploads the field and returns the colour scale maximum: the 99th percentile, since
    // precipitation has a long tail.
    setField(f: Field): number {
      texture = new DataTexture(f.values, f.width, f.height, RedFormat, FloatType);
      texture.minFilter = texture.magFilter = renderer.extensions.has('OES_texture_float_linear')
        ? LinearFilter
        : NearestFilter;
      texture.wrapS = RepeatWrapping; // longitude is periodic, so filter across the antimeridian
      texture.needsUpdate = true;
      const vmax = [...f.values].sort((a, b) => a - b)[Math.floor(0.99 * f.values.length)];
      material.uniforms.field.value = texture;
      material.uniforms.vmax.value = vmax;
      return vmax;
    },
    dispose() {
      texture?.dispose();
      lut.dispose();
      material.dispose();
    },
  };
}
