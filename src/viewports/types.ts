import type { SharedState } from '../state/shared.svelte';

// A viewport is a plain module with no UI-framework imports; the Svelte shell only hosts it.
export interface ViewportHandle {
  update(state: SharedState): void;
  destroy(): void;
}

export interface Viewport {
  mount(el: HTMLElement, state: SharedState): ViewportHandle;
}
