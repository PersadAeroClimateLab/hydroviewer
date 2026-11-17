import { parseColorMoves } from '../data/colormoves';
import type { Colormap } from '../viewports/colormaps';

// Built-in colormaps: every ColorMoves file in src/assets/colormaps (id = file name), viridis and magma first.
const files = import.meta.glob<string>('../assets/colormaps/*.json', { eager: true, query: '?raw', import: 'default' });
const ORDER = ['viridis', 'magma'];
const rank = (c: Colormap) => (ORDER.includes(c.id) ? ORDER.indexOf(c.id) : ORDER.length);
const builtIn = Object.entries(files)
  .flatMap(([path, text]) => {
    const file = path.split('/').pop()!.replace(/\.json$/, '');
    return parseColorMoves(text).maps.map((m, i) => ({ ...m, id: i ? `${file}-${i}` : file }));
  })
  .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

// Imported colormaps are kept in this browser only.
const KEY = 'hydroviewer.colormaps';
const load = (): Colormap[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
};
const save = (maps: Colormap[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(maps));
  } catch {
    // Storage unavailable (private window, blocked): the import still lasts for this visit.
  }
};

// Small plain objects (no typed arrays), so ordinary deep state is fine.
export const colormaps = $state({ builtIn, imported: load() });

export const findColormap = (id: string) => [...colormaps.imported, ...colormaps.builtIn].find((c) => c.id === id);

// Adds every map in a ColorMoves file, replacing imported maps of the same name. Throws on an unusable file.
export function importColormaps(text: string) {
  const { maps, warnings } = parseColorMoves(text, 'import:');
  const ids = new Set(maps.map((m) => m.id));
  const imported = [...colormaps.imported.filter((c) => !ids.has(c.id)), ...maps];
  colormaps.imported = imported;
  save(imported);
  return { maps, warnings };
}

export function removeColormap(id: string) {
  colormaps.imported = colormaps.imported.filter((c) => c.id !== id);
  save(colormaps.imported);
}
