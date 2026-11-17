import type { Colormap } from '../viewports/colormaps';
import { colormaps } from './colormaps.svelte';

// State shared by every viewport. Kept to plain values: typed arrays must stay out of deep reactive state.
// The colormap itself (not its id) is shared, so viewports need no registry.
// `metric` is the id of the metric on the globe and timeline; `insetLeft` is how many pixels a side pane covers
// on the left (the globe centres right of it). `elevation` and `stipple` are statistic ids ('' = off); `elevationScale` is the height of the top of the
// elevation's display range, as a fraction of the globe's radius.
export const ELEVATION_SCALE = { min: 0, max: 0.2, initial: 0.08 }; // max keeps peaks clear of the closest zoom
// `stippleSize` is the spacing of stipple dots in degrees; each dot's radius is a fixed share of it.
export const STIPPLE_SIZE = { min: 1, max: 6, initial: 2.5 };
export const shared = $state<{
  colormap: Colormap;
  metric: string;
  insetLeft: number;
  year: number;
  elevation: string;
  stipple: string;
  elevationScale: number;
  stippleSize: number;
}>({
  colormap: colormaps.builtIn[0],
  metric: 'pr',
  insetLeft: 0,
  year: 2025,
  elevation: 'agreement',
  stipple: 'spread',
  elevationScale: ELEVATION_SCALE.initial,
  stippleSize: STIPPLE_SIZE.initial,
});

export type SharedState = typeof shared;
