import type { Grid } from '../data/cmip6';

// Bilinear height at a longitude/latitude (degrees), the same interpolation the GPU applies to the
// relief texture: cell-centred grid, longitude wraps, latitude clamps. Used to lift coastlines.
export function reliefAt(grid: Grid) {
  const { values, width: w, height: h } = grid;
  return (lon: number, lat: number): number => {
    const x = ((lon + 180) / 360) * w - 0.5;
    const y = Math.min(Math.max(((lat + 90) / 180) * h - 0.5, 0), h - 1);
    const [x0, y0] = [Math.floor(x), Math.floor(y)];
    const [fx, fy] = [x - x0, y - y0];
    const [c0, c1] = [((x0 % w) + w) % w, (((x0 + 1) % w) + w) % w];
    const [r0, r1] = [y0 * w, Math.min(y0 + 1, h - 1) * w];
    return (
      values[r0 + c0] * (1 - fx) * (1 - fy) +
      values[r0 + c1] * fx * (1 - fy) +
      values[r1 + c0] * (1 - fx) * fy +
      values[r1 + c1] * fx * fy
    );
  };
}
