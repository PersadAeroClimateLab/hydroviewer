import type { SharedState } from '../state/shared.svelte';

// A viewport is a plain module with no UI-framework imports; the Svelte shell only hosts it.
export interface ViewportHandle {
  update(state: SharedState): void;
  destroy(): void;
}

export interface Viewport {
  name: string; // shown in the cell header
  engine: string; // rendering library, shown in the cell header
  mount(el: HTMLElement, state: SharedState): ViewportHandle;
}
