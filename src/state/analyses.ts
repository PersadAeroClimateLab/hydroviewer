// What each analysis shows, per cell (area letter). A comes first in every analysis because the
// one-cell layout shows only A. By default flat maps are 2D and drawn with three.js, and globes are 3D
// and drawn by trame, which needs a connected server (see ViewportGrid.svelte). `engine` overrides that.
// `data` (default: the first month) applies to flat maps and trame views; the three.js globe shows the month. Charts are 2D and
// drawn with Observable Plot.
import type { SeriesSource, Source } from '../data/cmip6';

export type Engine = 'three.js' | 'trame';

export type Panel =
  | { view: 'flat' | 'globe'; engine?: Engine; data?: Source }
  | { view: 'chart'; data: SeriesSource };

export interface Analysis {
  id: string;
  label: string;
  cells: Record<string, Panel>;
}

export const analyses: Analysis[] = [
  { id: 'total', label: 'Total Precip.', cells: { a: { view: 'flat' }, b: { view: 'globe' } } },
  // Statistics over the whole historical run, computed in prep (aggregates.zarr).
  {
    id: 'trend',
    label: 'Trend',
    cells: {
      a: { view: 'flat', data: 'pr_trend' },
      b: { view: 'globe', data: 'pr_trend' },
      c: { view: 'chart', data: 'pr_global_mean' },
    },
  },
  {
    id: 'extremes',
    label: 'Extremes',
    cells: {
      a: { view: 'flat', data: 'pr_wettest_month' },
      b: { view: 'globe', data: 'pr_wettest_month' },
      c: { view: 'chart', data: 'pr_wettest_month_hist' },
    },
  },
  // Kept on purpose: the same views from both engines side by side, for the rendering-library discussion.
  {
    id: 'engines',
    label: 'Engines',
    cells: {
      a: { view: 'flat', engine: 'three.js' },
      b: { view: 'globe', engine: 'three.js' },
      c: { view: 'flat', engine: 'trame' },
      d: { view: 'globe', engine: 'trame' },
    },
  },
];
