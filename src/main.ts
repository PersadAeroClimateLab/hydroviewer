import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { syncHash } from './state/hash.svelte';

syncHash();
mount(App, { target: document.getElementById('app')! });
