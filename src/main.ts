import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadCatalog, nodeKey, openNode } from './data/catalog';
import { dataBase } from './data/config';
import { createTree } from './data/tree';
import { shared } from './state/shared.svelte';

// The catalog, and the data tree's first selection (SSP2-4.5's multi-model mean if there is one) opened.
const target = document.getElementById('app')!;
loadCatalog()
  .then(async (catalog) => {
    const tree = createTree(catalog);
    const start = tree.initial();
    shared.selection = start.selection;
    shared.node = nodeKey(tree.node(start));
    return { catalog, ...(await openNode(catalog, tree.node(start))) };
  })
  .then(
    (props) => mount(App, { target, props }),
    (e) => (target.textContent = `Could not load data from ${dataBase}: ${e instanceof Error ? e.message : e}`),
  );
