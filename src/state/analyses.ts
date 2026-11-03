// What each analysis shows, per cell (area letter). A comes first in every analysis because the
// one-cell layout shows only A. By default flat maps are 2D and drawn with three.js, and globes are 3D
// and drawn by trame, which needs a connected server (see ViewportGrid.svelte). `engine` overrides that.
export type Engine = 'three.js' | 'trame';

export interface Panel {
  view: 'flat' | 'globe';
  engine?: Engine;
}

export interface Analysis {
  id: string;
  label: string;
  cells: Record<string, Panel>;
}

export const analyses: Analysis[] = [
  { id: 'total', label: 'Total Precip.', cells: { a: { view: 'flat' }, b: { view: 'globe' } } },
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
