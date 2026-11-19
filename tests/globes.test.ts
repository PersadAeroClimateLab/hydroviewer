// src/state/globes.ts: which globes a click selects and which one the timeline and tree follow.
// Run: docker compose run --rm --no-deps web npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { add, pick, remove, timed } from '../src/state/globes.ts';

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

test('adding copies the focused globe next to it and focuses the copy, up to the cap', () => {
  // Fails if a new globe appears somewhere else, starts on another node or year than the one it copies, is not the
  // one the tree then edits, or if the cap (decision D6) can be passed.
  const globes = [0, 1].map((id) => ({ id, selection: { scenario: `s${id}` }, node: `n${id}`, year: 2000 + id }));
  const s = add({ globes, focus: 0, selected: [1] }, 6);
  assert.deepEqual(s.globes.map((g) => [g.id, g.node, g.year]), [[0, 'n0', 2000], [2, 'n0', 2000], [1, 'n1', 2001]]);
  assert.deepEqual([s.focus, s.selected], [2, [2]]);
  assert.notEqual(s.globes[1].selection, globes[0].selection); // its own pick, not shared with the original
  assert.equal(add(s, 3), s);
});

test('removing moves the focus off the removed globe and keeps the last one', () => {
  // Fails if the focus is left on a globe that no longer exists (the tree and timeline would follow nothing), if the
  // removed globe stays selected, or if the grid can be emptied.
  const globes = [0, 1, 2].map((id) => ({ id, selection: { scenario: 's' }, node: '', year: 2000 }));
  assert.deepEqual(remove({ globes, focus: 1, selected: [] }, 1).focus, 2);
  assert.deepEqual(remove({ globes, focus: 2, selected: [] }, 2).focus, 1);
  const r = remove({ globes, focus: 1, selected: [0, 1] }, 1);
  assert.deepEqual([r.focus, r.selected], [0, [0]]);
  const one = { globes: globes.slice(0, 1), focus: 0, selected: [] };
  assert.equal(remove(one, 0), one);
});
