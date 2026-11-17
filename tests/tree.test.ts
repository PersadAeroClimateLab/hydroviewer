// src/data/tree.ts, the data tree's rules, against a small ragged catalog. Run: docker compose run --rm --no-deps web npm test
// (Node's own runner and type stripping; outside src/ so the type check, which has no Node types, skips it).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL, createTree, type TreeState } from '../src/data/tree.ts';

// s1: models A, B, C; s2: A only; s3: B only. B has the largest s1 ensemble. Only some members have maps.
const run = (scenario: string, model: string, members: string[], maps: string[]) => ({
  scenario, model, institution: 'X', members, maps, store: '', ensemble: '', series: 0,
});
const catalog = {
  scenarios: [{ id: 's1', label: 'S1' }, { id: 's2', label: 'S2' }, { id: 's3', label: 'S3' }],
  runs: [
    run('s1', 'A', ['r1', 'r2', 'r3'], ['r1']),
    run('s1', 'B', ['r1', 'r2', 'r10', 'r11'], ['r1', 'r2']),
    run('s1', 'C', ['r1'], ['r1']),
    run('s2', 'A', ['r1', 'r2'], ['r1']),
    run('s3', 'B', ['r1'], []),
  ],
};
const tree = createTree(catalog);
const start = tree.initial();
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const on = (items: { id: string; on: boolean }[]) => items.filter((i) => i.on).map((i) => i.id);
const fixed = (items: { id: string; fixed: boolean }[]) => items.filter((i) => i.fixed).map((i) => i.id);
const pick = (st: TreeState, ...steps: [0 | 1 | 2, string][]) => steps.reduce((s, [c, id]) => tree.pick(s, c, id), st);

test('starts on the multi-model mean of SSP2-4.5, or of the first scenario', () => {
  // Fails if the app would open a node that is not a multi-model mean, or ignore SSP2-4.5 when the catalog has it.
  assert.deepEqual(start, { selection: { scenario: 's1' }, hover: {} });
  const withSsp = createTree({ ...catalog, scenarios: [...catalog.scenarios, { id: 'ssp245', label: 'SSP2-4.5' }] });
  assert.deepEqual(withSsp.initial().selection, { scenario: 'ssp245' });
  assert.deepEqual(tree.node(start), { scenario: 's1' });
});

test('columns: scenarios with model counts, models largest ensemble first after "all", no members for all models', () => {
  // Fails if counts are wrong, models are not ordered by ensemble size (D5), or members show without a model.
  assert.deepEqual(tree.items(start, 0).map((i) => [i.id, i.count]), [['s1', 3], ['s2', 1], ['s3', 1]]);
  assert.deepEqual(tree.items(start, 1).map((i) => [i.id, i.count]), [[ALL, 3], ['B', 4], ['A', 3], ['C', 1]]);
  assert.deepEqual(on(tree.items(start, 1)), [ALL]);
  assert.deepEqual(fixed(tree.items(start, 1)), [ALL]);
  assert.deepEqual(tree.items(start, 2), []);
});

test('hovering previews without changing the selection, and leaving drops the preview', () => {
  // Fails if a hover changes what the globe shows, shows another scenario's models, or outlives leaving the pane.
  const st = tree.hover(start, 0, 's3');
  assert.deepEqual(st.selection, start.selection);
  assert.deepEqual(ids(tree.items(st, 1)), [ALL, 'B']);
  assert.deepEqual(on(tree.items(st, 0)), ['s3']);
  assert.deepEqual(fixed(tree.items(st, 0)), ['s1']);
  assert.deepEqual(fixed(tree.items(st, 1)), []); // s3's "all models" is not the selection
  const hoverModel = tree.hover(st, 1, 'B');
  assert.deepEqual(ids(tree.items(hoverModel, 2)), [ALL, 'r1']);
  assert.deepEqual(tree.leave(hoverModel), start);
});

test('picking a model selects its ensemble, with members and their maps', () => {
  // Fails if a model click does not open the ensemble, or members lose their order or maps flags.
  const st = pick(start, [1, 'B']);
  assert.deepEqual(st, { selection: { scenario: 's1', model: 'B' }, hover: {} });
  assert.deepEqual(tree.node(st), { scenario: 's1', model: 'B' });
  const members = tree.items(st, 2);
  assert.deepEqual(ids(members), [ALL, 'r1', 'r2', 'r10', 'r11']);
  assert.deepEqual(members.filter((i) => i.maps).map((i) => i.id), ['r1', 'r2']);
  assert.deepEqual(fixed(members), [ALL]);
  assert.deepEqual(on(members), ids(members)); // the ensemble: every member is in play
  assert.deepEqual(tree.path(st), ['S1', 'B', 'Ensemble (4)']);
});

test('a click on the picked model or member releases it one level; "all" and "ensemble" pick the aggregate', () => {
  // Fails if releasing goes to the wrong level, or the aggregate items do not select the aggregate.
  const model = pick(start, [1, 'B']);
  assert.deepEqual(pick(model, [1, 'B']).selection, { scenario: 's1' });
  assert.deepEqual(pick(model, [1, ALL]).selection, { scenario: 's1' });
  const member = pick(model, [2, 'r2']);
  assert.deepEqual(member.selection, { scenario: 's1', model: 'B', member: 'r2' });
  assert.deepEqual(pick(member, [2, 'r2']).selection, { scenario: 's1', model: 'B' });
  assert.deepEqual(pick(member, [2, ALL]).selection, { scenario: 's1', model: 'B' });
  assert.deepEqual(pick(member, [1, 'B']).selection, { scenario: 's1', model: 'B' }); // from a member: the ensemble
  assert.deepEqual(pick(start, [0, 's1']), start); // a scenario cannot be released
});

test('a picked member is the only one in play, and one without maps opens its ensemble', () => {
  // Fails if the globe would request a member store that does not exist, or the readout hides that it shows the ensemble.
  const withMaps = pick(start, [1, 'B'], [2, 'r2']);
  assert.deepEqual(tree.node(withMaps), { scenario: 's1', model: 'B', member: 'r2' });
  assert.deepEqual(on(tree.items(withMaps, 2)), ['r2']);
  assert.deepEqual(fixed(tree.items(withMaps, 2)), ['r2']);
  const without = pick(start, [1, 'B'], [2, 'r10']);
  assert.deepEqual(without.selection.member, 'r10');
  assert.deepEqual(tree.node(without), { scenario: 's1', model: 'B' });
  assert.deepEqual(tree.path(without), ['S1', 'B', 'r10 (no maps)']);
});

test('a click fixes the hovered items it hangs from', () => {
  // Fails if picking a model or member under a previewed scenario or model applies it to the old selection's parents.
  const st = tree.hover(tree.hover(start, 0, 's2'), 1, 'A');
  assert.deepEqual(tree.pick(st, 1, 'A').selection, { scenario: 's2', model: 'A' });
  assert.deepEqual(tree.pick(st, 2, 'r2').selection, { scenario: 's2', model: 'A', member: 'r2' });
  assert.deepEqual(tree.pick(st, 2, 'r2').hover, {});
});

test('another scenario keeps the model and member where it has them', () => {
  // Fails if switching scenarios loses a comparable model or member, or keeps one the scenario does not have.
  const member = pick(start, [1, 'A'], [2, 'r2']);
  assert.deepEqual(pick(member, [0, 's2']).selection, { scenario: 's2', model: 'A', member: 'r2' });
  const r3 = pick(start, [1, 'A'], [2, 'r3']);
  assert.deepEqual(pick(r3, [0, 's2']).selection, { scenario: 's2', model: 'A' }); // s2 has no r3
  assert.deepEqual(pick(member, [0, 's3']).selection, { scenario: 's3' }); // s3 has no A
});

test('previewing a scenario without the selected model shows its "all models", not a missing run', () => {
  // Fails if the members column shows a run that does not exist, or the selected model looks available there.
  const st = tree.hover(pick(start, [1, 'A']), 0, 's3');
  assert.deepEqual(on(tree.items(st, 1)), [ALL]);
  assert.deepEqual(tree.items(st, 2), []);
});

test('hovering another model in the selected scenario keeps the selection fixed and previews the other', () => {
  // Fails if the bold (fixed) item follows the pointer, or the members column ignores the hover.
  const st = tree.hover(pick(start, [1, 'B'], [2, 'r1']), 1, 'A');
  assert.deepEqual(on(tree.items(st, 1)), ['A']);
  assert.deepEqual(fixed(tree.items(st, 1)), ['B']);
  assert.deepEqual(ids(tree.items(st, 2)), [ALL, 'r1', 'r2', 'r3']);
  assert.deepEqual(fixed(tree.items(st, 2)), []); // A's r1 is not the selected B r1
  assert.deepEqual(on(tree.items(st, 2)), ids(tree.items(st, 2)));
});

test('links: one per level for what is shown, plus the selection when a preview differs; weights count the runs', () => {
  // Fails if links multiply per item (which would not fit 50 models and 70 members), lose the selection's path
  // during a preview, or bundles have the wrong weight.
  assert.deepEqual(tree.links(start), [{ level: 0, from: 's1', to: ALL, fixed: true, weight: 3 }]);
  const ensemble = pick(start, [1, 'B']);
  assert.deepEqual(tree.links(ensemble), [
    { level: 0, from: 's1', to: 'B', fixed: true, weight: 1 },
    { level: 1, from: 'B', to: ALL, fixed: true, weight: 4 },
  ]);
  const member = pick(ensemble, [2, 'r2']);
  assert.deepEqual(tree.links(member)[1], { level: 1, from: 'B', to: 'r2', fixed: true, weight: 1 });
  const preview = tree.hover(member, 1, 'A');
  assert.deepEqual(tree.links(preview), [
    { level: 0, from: 's1', to: 'A', fixed: false, weight: 1 },
    { level: 0, from: 's1', to: 'B', fixed: true, weight: 1 },
    { level: 1, from: 'A', to: ALL, fixed: false, weight: 3 },
  ]);
  const otherScenario = tree.hover(member, 0, 's2');
  assert.ok(tree.links(otherScenario).every((l) => !l.fixed)); // s2's links are all previews
});

test('clicks on items that are not shown change nothing', () => {
  // Fails if a stale click (an item that has gone from its column) changes the selection to a node that does not exist.
  assert.equal(tree.pick(start, 2, 'r1'), start); // no model, so no members column
  const s3 = tree.hover(start, 0, 's3');
  assert.equal(tree.pick(s3, 1, 'A'), s3); // s3 has no A
  assert.equal(tree.pick(start, 0, 'nope'), start);
  const ensemble = pick(start, [1, 'C']);
  assert.equal(tree.pick(ensemble, 2, 'r9'), ensemble);
});
