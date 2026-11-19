// src/state/globes.ts: which globes a click selects and which one the timeline and tree follow.
// Run: docker compose run --rm --no-deps web npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { pick, timed } from '../src/state/globes.ts';

const none = { focus: 1, selected: [] as number[] };

test('a plain click selects that globe alone, and again deselects it', () => {
  // Fails if a click adds to the selection instead of replacing it, or if there is no way back to "none selected"
  // (the timeline moving every globe).
  const one = pick({ focus: 1, selected: [0, 1] }, 2, false);
  assert.deepEqual(one, { focus: 2, selected: [2] });
  assert.deepEqual(pick(one, 2, false), { focus: 2, selected: [] });
});

test('an additive click toggles, and the focus follows what is left', () => {
  // Fails if Shift/Ctrl-click replaces the selection, or if the focus stays on a globe just taken out while others
  // are still selected (the timeline would chart a globe it does not move).
  const two = pick(pick(none, 0, true), 2, true);
  assert.deepEqual(two, { focus: 2, selected: [0, 2] });
  assert.deepEqual(pick(two, 2, true), { focus: 0, selected: [0] });
  assert.deepEqual(pick({ focus: 0, selected: [0] }, 0, true), { focus: 0, selected: [] });
});

test('the timeline moves the selected globes, or all of them when none is selected', () => {
  // Fails if "none selected" moves no globe (decision D5) or a selection leaks to unselected globes.
  const globes = [0, 1, 2].map((id) => ({ id, selection: { scenario: 's' }, node: '', year: 2000 }));
  assert.deepEqual(timed({ globes, ...none }).map((g) => g.id), [0, 1, 2]);
  assert.deepEqual(timed({ globes, focus: 2, selected: [2, 0] }).map((g) => g.id), [0, 2]);
});
