// A colormap as SciVisColor ColorMoves (and ParaView) describe one: colours at positions x in 0..1 across the
// colour range, blended in Lab or RGB. Everything that colours data (globe shader, colour bar, PNG export)
// samples one lookup table baked from it, so they always agree.
export type Rgb = [number, number, number]; // 0..1, sRGB

export interface Colormap {
  id: string;
  name: string;
  space: 'lab' | 'rgb';
  points: { x: number; rgb: Rgb }[]; // sorted by x, at least two
}

export const LUT_SIZE = 1024; // fine enough for hard steps (two points 1e-5 apart) to stay one entry wide

// sRGB <-> CIE Lab (D65), as ParaView/VTK convert for Lab interpolation.
const WHITE = [0.95047, 1, 1.08883];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);

export function rgbToLab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / WHITE[0];
  const y = (0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / WHITE[1];
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / WHITE[2];
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function labToRgb([l, a, b]: Rgb): Rgb {
  const fy = (l + 16) / 116;
  const [x, y, z] = [fInv(fy + a / 500) * WHITE[0], fInv(fy) * WHITE[1], fInv(fy - b / 200) * WHITE[2]];
  const lin = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
  return lin.map((c) => Math.min(1, Math.max(0, fromLinear(c)))) as Rgb;
}

// RGBA bytes, LUT_SIZE entries from x = 0 to 1. Outside the first and last points the end colours hold.
// About a millisecond, so it is simply redone when needed.
export function bakeLut(c: Colormap): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE * 4);
  const { points } = c;
  const coords = points.map((p) => (c.space === 'lab' ? rgbToLab(p.rgb) : p.rgb));
  let k = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    while (k < points.length - 2 && t > points[k + 1].x) k++;
    const [x0, x1] = [points[k].x, points[k + 1].x];
    const w = Math.min(1, Math.max(0, x1 > x0 ? (t - x0) / (x1 - x0) : 1));
    const mixed = coords[k].map((v, j) => v + (coords[k + 1][j] - v) * w) as Rgb;
    const rgb = c.space === 'lab' ? labToRgb(mixed) : mixed;
    lut.set([...rgb.map((v) => Math.round(v * 255)), 255], i * 4);
  }
  return lut;
}

// The lookup-table colour at t in [0, 1] (nearest entry), as 0..255 RGB.
export function lutColor(lut: Uint8Array, t: number): number[] {
  const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_SIZE - 1)) * 4;
  return [lut[i], lut[i + 1], lut[i + 2]];
}
