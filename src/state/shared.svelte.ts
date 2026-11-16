// State shared by every viewport. Kept to plain values: typed arrays must stay out of
// deep reactive state.
export const colormaps = ['viridis', 'magma'] as const;
export type Colormap = (typeof colormaps)[number];

export const shared = $state<{ colormap: Colormap; month: number }>({ colormap: 'viridis', month: 0 });

export type SharedState = typeof shared;
