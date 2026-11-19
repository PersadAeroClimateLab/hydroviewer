import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadCatalog, nodeKey, openNode } from './data/catalog';
import { dataBase } from './data/config';
import { createTree } from './data/tree';
import { shared } from './state/shared.svelte';

// The catalog, and three globes (stage 1 of docs/llm/MULTI_GLOBE_PLAN.md: fixed, side by side): the multi-model means
// of SSP1-2.6, SSP2-4.5 and SSP5-8.5 where the catalog has them. The focused one (the tree's first selection) is
// opened before mounting; the app opens the others.
const STAGE_1 = ['ssp126', 'ssp245', 'ssp585'];
const target = document.getElementById('app')!;
loadCatalog()
  .then(async (catalog) => {
    const tree = createTree(catalog);
    const start = tree.initial();
    const ids = catalog.scenarios.map((s) => s.id);
    const scenarios = STAGE_1.every((id) => ids.includes(id)) ? STAGE_1 : ids.slice(0, 3);
    shared.globes = scenarios.map((scenario, id) => ({ id, selection: { scenario }, node: '', year: 2025 }));
    const first = shared.globes.find((g) => g.selection.scenario === start.selection.scenario) ?? shared.globes[0];
    first.node = nodeKey(tree.node({ selection: first.selection, hover: {} }));
    shared.focus = first.id;
    return { catalog, ...(await openNode(catalog, tree.node({ selection: first.selection, hover: {} }))) };
  })
  .then(
    (props) => mount(App, { target, props }),
    (e) => (target.textContent = `Could not load data from ${dataBase}: ${e instanceof Error ? e.message : e}`),
  );
