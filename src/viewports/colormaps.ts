import stops from '../assets/colormaps.json';

// Shared with the trame server (trame/scene.py), so both render the same colours. The sidebar's
// colormaps (shared.svelte.ts) are a subset; BrBG is the diverging scale for fields with negative values.
export type Palette = keyof typeof stops;
export const STOPS: Record<Palette, string[]> = stops;
export const DIVERGING: Palette = 'BrBG';

// Contour boxplot (boxplotMap.ts, flat and globe), after Whitaker et al. 2013: neutral bands, a yellow
// median, a purple mean and red outliers. The map is opaque, so these suit both page themes.
export const BOXPLOT = {
  outside: '#e1e4e8', // latitudes not analysed
  background: '#f7f8fa', // outside every kept member
  inside: '#9fcbef', // inside every kept member: a hue, not a grey, so it can't pass for a band
  band100: '#c3cdd9',
  band50: '#8d9db2',
  median: '#e3a600',
  mean: '#8e3cad',
  outlier: '#d0342c',
  coast: '#5b6573',
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Colour at t in [0, 1], interpolated linearly between the stops.
export function colorAt(colormap: Palette, t: number): number[] {
  const stops = STOPS[colormap];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const [a, b] = [rgb(stops[i]), rgb(stops[i + 1])];
  return a.map((v, k) => v + (b[k] - v) * (x - i));
}
