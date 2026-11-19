import { bakeLut, LUT_SIZE, type Colormap } from '../viewports/colormaps';

// A colormap's preview as an image URL, drawn from the lookup table the globe samples, so Lab blending and hard
// steps look as they will on the globe. Cached by content, not id: an import can replace a map under the same id.
const cache = new Map<string, string>();

export function swatch(c: Colormap): string {
  const key = JSON.stringify([c.space, c.points]);
  let url = cache.get(key);
  if (!url) {
    const canvas = Object.assign(document.createElement('canvas'), { width: LUT_SIZE, height: 1 });
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bakeLut(c)), LUT_SIZE, 1), 0, 0);
    cache.set(key, (url = canvas.toDataURL()));
  }
  return url;
}
