import type { Colormap } from '../viewports/colormaps';
import { colormaps } from './colormaps.svelte';

// State shared by every viewport. Kept to plain values: typed arrays must stay out of deep reactive state.
// The colormap itself (not its id) is shared, so viewports need no registry.
export const shared = $state<{ colormap: Colormap; year: number }>({ colormap: colormaps.builtIn[0], year: 2025 });

export type SharedState = typeof shared;
