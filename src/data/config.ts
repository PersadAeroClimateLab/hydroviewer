// Base URL of the data bucket. Dev default is the nginx emulator (compose `data` service);
// production builds set VITE_DATA_URL (empty counts as unset: the Pages workflow passes an unset
// repository variable as ''). `?data=URL` overrides both, which is how the browser tool container
// reaches the emulator as http://data:9000.
export const dataBase: string =
  new URLSearchParams(location.search).get('data') ?? (import.meta.env.VITE_DATA_URL || 'http://localhost:9000');

// Where to look for a trame server at startup; the sidebar box (src/state/trame.svelte.ts) can change
// it. `?trame=URL` is for one page load, e.g. http://trame:8080 from the browser tool container;
// VITE_TRAME_URL is a build-time default. Both are undefined when trame is off (the default).
export const trameFromUrl: string | undefined = new URLSearchParams(location.search).get('trame') || undefined;
export const trameFromEnv: string | undefined = import.meta.env.VITE_TRAME_URL || undefined;
