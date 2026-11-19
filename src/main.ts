import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadCatalog, nodeKey, openNode } from './data/catalog';
import { dataBase } from './data/config';
import { createTree } from './data/tree';
import { shared } from './state/shared.svelte';

// The catalog, and one globe on the data tree's first selection (SSP2-4.5's multi-model mean if there is one), opened
// before mounting; the tree's + adds more (docs/llm/MULTI_GLOBE_PLAN.md).
const target = document.getElementById('app')!;
loadCatalog()
  .then(async (catalog) => {
    const tree = createTree(catalog);
    const start = tree.initial();
    const node = tree.node(start);
    shared.globes = [{ id: 0, selection: start.selection, node: nodeKey(node), year: 2025 }];
    shared.focus = 0;
    return { catalog, ...(await openNode(catalog, node)) };
  })
  .then(
    (props) => mount(App, { target, props }),
    (e) => (target.textContent = `Could not load data from ${dataBase}: ${e instanceof Error ? e.message : e}`),
  );
