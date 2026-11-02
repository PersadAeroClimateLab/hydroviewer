// Base URL of the data bucket. Dev default is the nginx emulator (compose `data` service);
// production builds set VITE_DATA_URL. `?data=URL` overrides both, which is how the browser
// tool container reaches the emulator as http://data:9000.
export const dataBase: string =
  new URLSearchParams(location.search).get('data') ?? import.meta.env.VITE_DATA_URL ?? 'http://localhost:9000';

// Base URL of the trame server, or undefined when trame is off (the default). Like the data URL,
// `?trame=URL` overrides the build setting, e.g. http://trame:8080 from the browser tool container.
export const trameBase: string | undefined =
  new URLSearchParams(location.search).get('trame') || import.meta.env.VITE_TRAME_URL || undefined;
