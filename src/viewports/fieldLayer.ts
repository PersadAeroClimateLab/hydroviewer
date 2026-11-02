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
import type { Field, Grid } from '../data/cmip6';
import type { Colormap } from '../state/shared.svelte';
import { colorAt } from './colormaps';

const LUT_SIZE = 256;

// Behind both globes (the three.js one and the trame iframe): dark colormap ends read against it.
export const GLOBE_BACKGROUND = '#c9ced4';

// How far a full-uncertainty point rises above the unit sphere. Mirrored in trame/scene.py.
export const RELIEF_SCALE = 0.2;
const AMBIENT = 0.45; // headlight shading for relief, mirrored by the VTK surface's lighting

// With RELIEF defined, vertices move radially by the relief texture (a sphere only).
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vView;
  #ifdef RELIEF
  uniform sampler2D relief;
  uniform float reliefScale;
  #endif
  void main() {
    vUv = uv;
    vec3 p = position;
    #ifdef RELIEF
    p *= 1.0 + reliefScale * texture2D(relief, uv).r;
    #endif
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vView = view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D field;
  uniform sampler2D lut;
  uniform float vmax;
  varying vec2 vUv;
  varying vec3 vView;
  void main() {
    float t = clamp(texture2D(field, vUv).r / vmax, 0.0, 1.0);
    float u = (0.5 + t * ${(LUT_SIZE - 1).toFixed(1)}) / ${LUT_SIZE.toFixed(1)};
    vec3 rgb = texture2D(lut, vec2(u, 0.5)).rgb;
    #ifdef RELIEF
    // Normal from screen-space derivatives of the displaced surface; light from the camera.
    vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
    rgb *= ${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * max(n.z, 0.0);
    #endif
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

// A gridded field coloured on the GPU, for any geometry with equirectangular UVs (u: west to
// east, v: south to north). The field stays a float texture; the colormap is a lookup texture.
// Pass `relief` for a sphere that rises with a second grid (see setRelief).
export function createFieldLayer(renderer: WebGLRenderer, colormap: Colormap, relief = false) {
  const lutData = new Uint8Array(LUT_SIZE * 4);
  const lut = new DataTexture(lutData, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
  lut.minFilter = lut.magFilter = LinearFilter;

  const material = new ShaderMaterial({
    uniforms: {
      field: { value: null },
      lut: { value: lut },
      vmax: { value: 1 },
      relief: { value: null },
      reliefScale: { value: RELIEF_SCALE },
    },
    defines: relief ? { RELIEF: 1 } : {},
    vertexShader,
    fragmentShader,
  });
  const textures: DataTexture[] = [];

  const gridTexture = (grid: Grid) => {
    const texture = new DataTexture(grid.values, grid.width, grid.height, RedFormat, FloatType);
    texture.minFilter = texture.magFilter = renderer.extensions.has('OES_texture_float_linear')
      ? LinearFilter
      : NearestFilter;
    texture.wrapS = RepeatWrapping; // longitude is periodic, so filter across the antimeridian
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  };

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
      const vmax = [...f.values].sort((a, b) => a - b)[Math.floor(0.99 * f.values.length)];
      material.uniforms.field.value = gridTexture(f);
      material.uniforms.vmax.value = vmax;
      return vmax;
    },
    // Heights in 0..1, on the same kind of grid as the field.
    setRelief(grid: Grid) {
      material.uniforms.relief.value = gridTexture(grid);
    },
    dispose() {
      textures.forEach((t) => t.dispose());
      lut.dispose();
      material.dispose();
    },
  };
}
