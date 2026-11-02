import type { Colormap } from '../state/shared.svelte';

export const STOPS: Record<Colormap, string[]> = {
  viridis: ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Colour at t in [0, 1], interpolated linearly between the stops.
export function colorAt(colormap: Colormap, t: number): number[] {
  const stops = STOPS[colormap];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const [a, b] = [rgb(stops[i]), rgb(stops[i + 1])];
  return a.map((v, k) => v + (b[k] - v) * (x - i));
}
