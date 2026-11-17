import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadCatalog, openNode } from './data/catalog';
import { dataBase } from './data/config';

// Until the data tree picks one, the first scenario's multi-model mean (SSP2-4.5 if there is one).
const target = document.getElementById('app')!;
loadCatalog()
  .then((catalog) => openNode(catalog, { scenario: (catalog.scenarios.find((s) => s.id === 'ssp245') ?? catalog.scenarios[0]).id }))
  .then(
    (props) => mount(App, { target, props }),
    (e) => (target.textContent = `Could not load data from ${dataBase}: ${e instanceof Error ? e.message : e}`),
  );
