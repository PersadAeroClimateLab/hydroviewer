import type { Selection } from '../data/tree';

// The globes side by side (docs/llm/MULTI_GLOBE_PLAN.md): each shows its own node of the data tree at its own year;
// everything else (metric, colours, stippling, orientation) is shared. Plain functions over plain data, so the
// viewports (no Svelte) and the tests can use them.
export interface Globe {
  id: number;
  selection: Selection; // the data tree's pick for this globe
  node: string; // the key of the node shown, set once it has loaded
  year: number;
}

// `focus` is the globe the data tree edits and the timeline charts; `selected` are the globes the timeline moves
// (none: all of them).
export interface Globes {
  globes: Globe[];
  focus: number;
  selected: number[];
}

// At most this many globes (decision D6; D8 for phones): bandwidth while scrubbing them together, and cell size.
export const MAX_GLOBES = { wide: 6, narrow: 3 };

export const focused = (s: Globes): Globe => s.globes.find((g) => g.id === s.focus) ?? s.globes[0];

export const timed = (s: Globes): Globe[] => (s.selected.length ? s.globes.filter((g) => s.selected.includes(g.id)) : s.globes);

// A click on a globe. Plain: that globe alone is selected, or, if it already was, none is (the timeline then moves
// all). Additive (Shift, Ctrl, Cmd): it is toggled. The focus follows a globe that becomes selected; when one is
// taken out, it moves to the last one left, or stays where it is if none is left.
export function pick(s: Pick<Globes, 'focus' | 'selected'>, id: number, additive: boolean): Pick<Globes, 'focus' | 'selected'> {
  if (!additive) return s.selected.length === 1 && s.selected[0] === id ? { focus: id, selected: [] } : { focus: id, selected: [id] };
  if (!s.selected.includes(id)) return { focus: id, selected: [...s.selected, id] };
  const selected = s.selected.filter((x) => x !== id);
  return { focus: selected.at(-1) ?? s.focus, selected };
}

// A new globe: a copy of the focused one (pick, node and year), placed after it and focused, so the data tree then
// edits it. If globes were selected, it replaces them (the timeline charts the focus, so it should also move it).
// Unchanged at `max` globes.
export function add(s: Globes, max: number): Globes {
  if (s.globes.length >= max) return s;
  const f = focused(s);
  const id = Math.max(...s.globes.map((g) => g.id)) + 1;
  const globes = [...s.globes];
  globes.splice(globes.indexOf(f) + 1, 0, { ...f, id, selection: { ...f.selection } });
  return { globes, focus: id, selected: s.selected.length ? [id] : [] };
}

// Without a globe; the last one stays. If it was the focus, the focus moves to the last selected globe left, else
// to its neighbour (the next one, or the one before at the end).
export function remove(s: Globes, id: number): Globes {
  const at = s.globes.findIndex((g) => g.id === id);
  if (at < 0 || s.globes.length === 1) return s;
  const globes = s.globes.filter((g) => g.id !== id);
  const selected = s.selected.filter((x) => x !== id);
  const focus = s.focus !== id ? s.focus : (selected.at(-1) ?? globes[Math.min(at, globes.length - 1)].id);
  return { globes, focus, selected };
}
