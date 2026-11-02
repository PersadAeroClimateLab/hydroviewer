// State shared by every viewport. Kept to plain values: typed arrays must stay out of
// deep reactive state.
export const colormaps = ['viridis', 'magma'] as const;
export type Colormap = (typeof colormaps)[number];

export const shared = $state<{ colormap: Colormap }>({ colormap: 'viridis' });

export type SharedState = typeof shared;
