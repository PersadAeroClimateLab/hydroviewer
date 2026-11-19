// The globes' grid (docs/llm/MULTI_GLOBE_PLAN.md §4): plain arithmetic, no three.js, so it is tested on its own.

// A globe's place on the stage, in CSS px from the stage's top left.
export interface Cell {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Area = Omit<Cell, 'id'>;

// Cells for the ids, in reading order, `gap` px apart: the column count that gives the biggest globe (a globe fills a
// share of its cell's shorter side); on a tie (within half a pixel), the one with fewer empty places, so four make
// 2 × 2 rather than 3 + 1. A short last row is centred. Cells are at least 1 px.
export function layout(ids: number[], area: Area, gap: number): Cell[] {
  const n = ids.length;
  if (!n) return [];
  let best = { columns: 1, rows: n, width: 0, height: 0, size: -1, empty: 0 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const width = Math.max(1, (area.width - gap * (columns - 1)) / columns);
    const height = Math.max(1, (area.height - gap * (rows - 1)) / rows);
    const [size, empty] = [Math.min(width, height), columns * rows - n];
    if (size > best.size + 0.5 || (size >= best.size - 0.5 && empty < best.empty)) best = { columns, rows, width, height, size, empty };
  }
  const { columns, rows, width, height } = best;
  return ids.map((id, i) => {
    const [row, column] = [Math.floor(i / columns), i % columns];
    const inRow = row < rows - 1 ? columns : n - columns * (rows - 1);
    const shift = ((columns - inRow) * (width + gap)) / 2;
    return { id, x: area.x + shift + column * (width + gap), y: area.y + row * (height + gap), width, height };
  });
}
