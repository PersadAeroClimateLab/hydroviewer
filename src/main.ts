import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadDataset } from './data/catalog';
import { dataBase } from './data/config';

const target = document.getElementById('app')!;
loadDataset().then(
  (props) => mount(App, { target, props }),
  (e) => (target.textContent = `Could not load data from ${dataBase}: ${e instanceof Error ? e.message : e}`),
);
