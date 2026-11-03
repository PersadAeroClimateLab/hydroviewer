import { trameFromEnv, trameFromUrl } from '../data/config';

export type TrameStatus = 'off' | 'checking' | 'ready' | 'unreachable';

const KEY = 'hydroviewer.trameUrl';
const saved = (): string | undefined => {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined; // storage can be unavailable (private windows, blocked site data)
  }
};
const save = (url: string | undefined) => {
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {}
};

// The trame server for cells C and D. `url` is set only while that server answers, so the cells
// fall back to placeholders when it is missing: a static page can use a local server if one is running.
export const trame = $state<{ input: string; url: string | undefined; status: TrameStatus }>({
  input: trameFromUrl ?? saved() ?? trameFromEnv ?? '',
  url: undefined,
  status: 'off',
});

// Accepts "localhost:8080" as well as a full URL; returns the base without a trailing slash.
function normalize(text: string): string | undefined {
  text = text.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

// A no-cors request settles for any server that answers (even with an error status) and rejects
// when nothing is listening. A browser that blocks the request looks the same, so callers can only
// say "not reachable".
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/index.html`, { mode: 'no-cors', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

let attempt = 0;

// `remember` is for what the user typed; the startup value (?trame= or the build default) is not saved.
export async function connect(text: string, remember = true) {
  const mine = ++attempt;
  const url = normalize(text);
  trame.input = url ?? text.trim();
  if (remember) save(url);
  if (!url) {
    trame.url = undefined;
    trame.status = text.trim() ? 'unreachable' : 'off';
    return;
  }
  trame.status = 'checking'; // keep the current url meanwhile, so the cells do not flicker
  const ok = await reachable(url);
  if (mine !== attempt) return; // a newer connect superseded this one
  trame.url = ok ? url : undefined;
  trame.status = ok ? 'ready' : 'unreachable';
}

if (trame.input) connect(trame.input, false);
