// Base URL of the data bucket. Dev default is the nginx emulator (compose `data` service);
// production builds set VITE_DATA_URL. `?data=URL` overrides both, which is how the browser
// tool container reaches the emulator as http://data:9000.
export const dataBase: string =
  new URLSearchParams(location.search).get('data') ?? import.meta.env.VITE_DATA_URL ?? 'http://localhost:9000';
