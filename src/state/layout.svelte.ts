// Page layout. Separate from shared.svelte.ts because viewports never see it.
// `areas` are CSS grid-template-areas rows; each distinct letter is one cell.
export const layouts = [
  { id: '1', label: '1', areas: ['a'] },
  { id: '1x2', label: '1×2', areas: ['a b'] },
  { id: '2x2', label: '2×2', areas: ['a b', 'c d'] },
  { id: '1+2', label: '1+2', areas: ['a b', 'a c'] },
] as const;

export type LayoutId = (typeof layouts)[number]['id'];

export const ui = $state<{ layoutId: LayoutId; sidebarOpen: boolean }>({
  layoutId: '2x2',
  sidebarOpen: !matchMedia('(max-width: 720px)').matches,
});
