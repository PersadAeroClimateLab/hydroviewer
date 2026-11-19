// src/viewports/grid.ts: how the globes are laid out for their number and the room they have.
// Run: docker compose run --rm --no-deps web npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { layout, type Area } from '../src/viewports/grid.ts';

const wide: Area = { x: 0, y: 0, width: 1000, height: 600 };
const phone: Area = { x: 0, y: 0, width: 360, height: 700 };
const ids = (n: number) => [...Array(n).keys()];
// Columns and rows, from the distinct x and y positions.
const shape = (cells: { x: number; y: number }[]) => [new Set(cells.map((c) => c.x)).size, new Set(cells.map((c) => c.y)).size];

test('the grid follows the room: a row when wide, a column on a phone, 2 × 2 for four', () => {
  // Fails if the layout ignores the area's shape (three globes squeezed in a row on a portrait phone, or stacked on a
  // wide screen), which is what decides how big each globe is, or if a tie in globe size goes to a ragged grid
  // (four as 3 + 1 in a 1000 × 600 area, where 2 × 2 gives globes as big).
  assert.deepEqual(shape(layout(ids(3), wide, 16)), [3, 1]);
  assert.deepEqual(shape(layout(ids(3), phone, 16)), [1, 3]);
  assert.deepEqual(shape(layout(ids(4), wide, 16)), [2, 2]);
  assert.deepEqual(layout(ids(1), wide, 16), [{ id: 0, ...wide }]);
});

test('a short last row is centred, and cells keep the gap and stay inside the area', () => {
  // Fails if five globes leave a hole at the bottom right instead of centring the last two, or if cells overlap,
  // touch (zoomed-in globes would run into each other) or spill out of the area.
  const cells = layout(ids(5), wide, 16);
  const [top, bottom] = [cells.slice(0, 3), cells.slice(3)];
  const centre = (cs: typeof cells) => (cs[0].x + cs.at(-1)!.x + cs.at(-1)!.width) / 2;
  assert.equal(centre(bottom), centre(top));
  for (const r of [top, bottom]) assert.equal(r[1].x - (r[0].x + r[0].width), 16);
  assert.equal(bottom[0].y - (top[0].y + top[0].height), 16);
  for (const c of cells) assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= 1000 + 1e-9 && c.y + c.height <= 600 + 1e-9);
});
