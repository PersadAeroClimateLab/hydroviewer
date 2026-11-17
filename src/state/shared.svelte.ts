import type { Selection } from '../data/tree';
import type { Colormap } from '../viewports/colormaps';
import { colormaps } from './colormaps.svelte';

// State shared by every viewport. Kept to plain values: typed arrays must stay out of deep reactive state.
// The colormap itself (not its id) is shared, so viewports need no registry.
// `metric` is the id of the metric on the globe and timeline; `insetLeft` is how many pixels a side pane covers
// on the left (the globe centres right of it) and `insetTop` how many the open data tree covers at the top.
// `selection` is the data tree's pick (scenario, model, member; set from the catalog before the app mounts) and
// `node` the key of the node whose dataset the views show (set once it has loaded, so views reload then). `elevation` and `stipple` are statistic ids ('' = off); `elevationScale` is the height of the top of the
// elevation's display range, as a fraction of the globe's radius.
export const ELEVATION_SCALE = { min: 0, max: 0.2, initial: 0.08 };
// `elevationMultiplier` (an integer) multiplies it, so the slider keeps its fine steps at any height; the globe
// keeps the closest zoom outside the peaks.
export const ELEVATION_MULTIPLIER = { min: 1, max: 10 };
// `spin`: the globe turns slowly on its own (on unless the system asks for reduced motion).
// `stippleSize` is the spacing of stipple dots in degrees; each dot's radius is a fixed share of it. `thresholds`
// holds stipple thresholds moved from their statistic's default, by `<metric>/<statistic>` (units differ per metric).
export const STIPPLE_SIZE = { min: 1, max: 6, initial: 2.5 };
export const shared = $state<{
  colormap: Colormap;
  metric: string;
  insetLeft: number;
  insetTop: number;
  spin: boolean;
  selection: Selection;
  node: string;
  year: number;
  elevation: string;
  stipple: string;
  elevationScale: number;
  elevationMultiplier: number;
  stippleSize: number;
  thresholds: Record<string, number>;
}>({
  colormap: colormaps.builtIn[0],
  metric: 'pr',
  insetLeft: 0,
  insetTop: 0,
  spin: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  selection: { scenario: '' },
  node: '',
  year: 2025,
  elevation: 'agreement',
  stipple: 'spread',
  elevationScale: ELEVATION_SCALE.initial,
  elevationMultiplier: ELEVATION_MULTIPLIER.min,
  stippleSize: STIPPLE_SIZE.initial,
  thresholds: {},
});

export type SharedState = typeof shared;
