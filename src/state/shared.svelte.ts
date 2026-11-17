import type { Colormap } from '../viewports/colormaps';
import { colormaps } from './colormaps.svelte';

// State shared by every viewport. Kept to plain values: typed arrays must stay out of deep reactive state.
// The colormap itself (not its id) is shared, so viewports need no registry.
// `elevation` and `stipple` are statistic ids ('' = off); `elevationScale` is the height of the top of the
// elevation's display range, as a fraction of the globe's radius.
export const ELEVATION_SCALE = { min: 0, max: 0.2, initial: 0.08 }; // max keeps peaks clear of the closest zoom
export const shared = $state<{
  colormap: Colormap;
  year: number;
  elevation: string;
  stipple: string;
  elevationScale: number;
}>({
  colormap: colormaps.builtIn[0],
  year: 2025,
  elevation: 'agreement',
  stipple: 'spread',
  elevationScale: ELEVATION_SCALE.initial,
});

export type SharedState = typeof shared;
