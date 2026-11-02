// State shared by every viewport. Kept to plain values: typed arrays must stay out of
// deep reactive state.
export type Colormap = 'viridis' | 'magma';

export const shared = $state<{ colormap: Colormap }>({ colormap: 'viridis' });

export type SharedState = typeof shared;
