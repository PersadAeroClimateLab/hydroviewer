// Natural Earth 110m coastlines as polylines of flat [lon, lat, lon, lat, ...] lists, built by
// prep/make_coastlines.py. Loaded on demand, as its own chunk, and shared by every viewport.
let lines: Promise<number[][]> | undefined;

export const loadCoastlines = () => (lines ??= import('../assets/coastlines.json').then((m) => m.default));
