import type { Colormap } from '../viewports/colormaps';
import { colormaps } from './colormaps.svelte';
import type { Globe } from './globes';

// State shared by every viewport. Kept to plain values: typed arrays must stay out of deep reactive state.
// The colormap itself (not its id) is shared, so viewports need no registry.
// `metric` is the id of the metric on the globes and timeline; `insetLeft` is how many pixels a side pane covers
// on the left (the globes centre right of it) and `insetTop` how many the open data tree covers at the top.
// `globes`, `focus` and `selected`: the globes side by side, each on its own node and year (set from the catalog
// before the app mounts), the one the tree and timeline follow, and the ones the timeline moves (src/state/globes.ts).
// `stipple` is the id of the statistic stippled ('' = off), with a column through each dot; `columnScale` is the
// height of a column at the top of the statistic's display range, as a fraction of the globe's radius (0: dots only).
export const COLUMN_SCALE = { min: 0, max: 0.2, initial: 0.08 };
// `columnMultiplier` (an integer) multiplies it, so the slider keeps its fine steps at any height; the globe
// keeps the closest zoom outside the tallest columns.
export const COLUMN_MULTIPLIER = { min: 1, max: 10 };
// `columnColormap` colours the columns (still by the metric's value) with a map of their own; null: the map's.
// `spin`: the globe turns slowly on its own (on unless the system asks for reduced motion).
// `stippleSize` is the spacing of stipple dots in degrees; each dot's radius (and its column's) is a fixed share of it. `thresholds`
// holds stipple thresholds moved from their statistic's default, by `<metric>/<statistic>` (units differ per metric).
// `ranges` and `columnRanges` hold colour ranges moved from the metric's display range, by metric id: the map's, and
// the columns' while they have a colormap of their own (otherwise they follow the map's).
export const STIPPLE_SIZE = { min: 1, max: 6, initial: 2.5 };
export const shared = $state<{
  colormap: Colormap;
  metric: string;
  insetLeft: number;
  insetTop: number;
  spin: boolean;
  globes: Globe[];
  focus: number;
  selected: number[];
  stipple: string;
  columnScale: number;
  columnMultiplier: number;
  columnColormap: Colormap | null;
  stippleSize: number;
  thresholds: Record<string, number>;
  ranges: Record<string, [number, number]>;
  columnRanges: Record<string, [number, number]>;
}>({
  colormap: colormaps.builtIn[0],
  metric: 'pr',
  insetLeft: 0,
  insetTop: 0,
  spin: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  globes: [],
  focus: 0,
  selected: [],
  stipple: 'spread',
  columnScale: COLUMN_SCALE.initial,
  columnMultiplier: COLUMN_MULTIPLIER.min,
  columnColormap: null,
  stippleSize: STIPPLE_SIZE.initial,
  thresholds: {},
  ranges: {},
  columnRanges: {},
});

export type SharedState = typeof shared;
