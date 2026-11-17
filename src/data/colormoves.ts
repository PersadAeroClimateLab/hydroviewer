import type { Colormap, Rgb } from '../viewports/colormaps';

// Reads a SciVisColor ColorMoves JSON export: { colormaps: [{ name, space, points: [{ x, o, r, g, b }], ... }] }.
// Every map in the file is returned. `sections` and `group` are editor metadata and are ignored; opacity
// is ignored (warned when not 1). Throws an Error with a readable message when the file can't be used.
export function parseColorMoves(text: string, idPrefix = ''): { maps: Colormap[]; warnings: string[] } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file.');
  }
  const list = (root as { colormaps?: unknown })?.colormaps;
  if (!Array.isArray(list) || !list.length) throw new Error('No "colormaps" list: not a ColorMoves export.');

  const warnings: string[] = [];
  const maps = list.map((raw: Record<string, unknown>, n): Colormap => {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Colormap ${n + 1}`;
    if (!Array.isArray(raw.points)) throw new Error(`"${name}" has no points.`);
    const points = raw.points.map((p: Record<string, unknown>) => {
      const [x, r, g, b, o] = ['x', 'r', 'g', 'b', 'o'].map((k) => Number(p?.[k] ?? (k === 'o' ? 1 : NaN)));
      if (![x, r, g, b].every(Number.isFinite)) throw new Error(`"${name}" has a point without numeric x, r, g, b.`);
      if (o < 1) warnings.push(`"${name}": opacity is ignored.`);
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      return { x: clamp(x), rgb: [r, g, b].map(clamp) as Rgb };
    });
    if (points.length < 2) throw new Error(`"${name}" needs at least two points.`);
    points.sort((a, b) => a.x - b.x);

    const space = String(raw.space ?? 'rgb').toLowerCase();
    if (space !== 'lab' && space !== 'rgb') warnings.push(`"${name}": colour space "${raw.space}" is not supported; blending in RGB.`);
    if (raw.indexedLookup === true) warnings.push(`"${name}": indexed lookup is not supported; drawn as continuous.`);
    return { id: `${idPrefix}${name}`, name, space: space === 'lab' ? 'lab' : 'rgb', points };
  });
  return { maps, warnings: [...new Set(warnings)] };
}
