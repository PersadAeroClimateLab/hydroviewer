import type { Field } from '../data/cmip6';
import { colorAt, type Palette } from './colormaps';

// The field as an equirectangular PNG, one pixel per grid cell (north up, longitude -180 to 180 left to
// right), coloured like the globe: same range, same colormap, no shading or coastlines.
export function fieldPng(f: Field, colormap: Palette): Promise<Blob> {
  const [vmin, vmax] = f.range ?? [0, Math.max(...f.values)];
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = [f.width, f.height];
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(f.width, f.height);
  for (let j = 0; j < f.height; j++) {
    const row = (f.height - 1 - j) * f.width; // the grid runs south to north, images top to bottom
    for (let i = 0; i < f.width; i++) {
      const [r, gr, b] = colorAt(colormap, (f.values[j * f.width + i] - vmin) / (vmax - vmin));
      image.data.set([r, gr, b, 255], (row + i) * 4);
    }
  }
  g.putImageData(image, 0, 0);
  return new Promise((done, fail) => canvas.toBlob((blob) => (blob ? done(blob) : fail(new Error('PNG encoding failed'))), 'image/png'));
}

export function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
