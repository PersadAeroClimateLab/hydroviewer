import stops from '../assets/colormaps.json';

// Evenly spaced colour stops per colormap.
export type Palette = keyof typeof stops;
export const STOPS: Record<Palette, string[]> = stops;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Colour at t in [0, 1], interpolated linearly between the stops.
export function colorAt(colormap: Palette, t: number): number[] {
  const stops = STOPS[colormap];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const [a, b] = [rgb(stops[i]), rgb(stops[i + 1])];
  return a.map((v, k) => v + (b[k] - v) * (x - i));
}

// The same colours as a CSS gradient (evenly spaced stops, linear blending), for the colour bar.
export const gradient = (colormap: Palette) => `linear-gradient(to right, ${STOPS[colormap].join(', ')})`;
