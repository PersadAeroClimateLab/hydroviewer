import type { Dataset, Field, Metric, Series, Statistic } from './cmip6';

// Stand-in data for the layout mockup: annual means from analytic formulas on the target 1° grid (360 x 180,
// cell-centred, south to north, west to east), 1950-2100, so the globe, timeline and metric list can be built
// without the bucket. Not real data; replace with the bucket once the layout settles.
const W = 360;
const H = 180;
export const YEARS: [number, number] = [1950, 2100];

const rad = Math.PI / 180;
type At = (lon: number, lat: number, year: number, wobble?: boolean) => number;

// Warming from about 1970, in degrees by 2100.
const warming = (year: number) => 3 * Math.max(0, (year - 1970) / 130) ** 1.6;

// Precipitation (mm/day): a tropical rain band that wobbles from year to year, wetter over the Maritime
// Continent, Amazon and Congo, mid-latitude storm tracks and some ripples. Warming makes the band wetter, the
// subtropics drier and moves the storm tracks poleward. Without `wobble`, only the forced change (no
// year-to-year wobble of the band or ripples), as an ensemble mean would show it.
const pr: At = (lon, lat, year, wobble = true) => {
  const warm = warming(year);
  const itcz = wobble ? 2 + 1.5 * Math.sin(year * 0.9) + Math.sin(year * 0.37) : 2;
  const land = Math.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * Math.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * Math.exp(-(((lon - 20) / 15) ** 2));
  const band = (6 + 6 * land) * (1 + 0.07 * warm) * Math.exp(-(((lat - itcz) / 8) ** 2));
  const dry = 1 - 0.06 * warm * Math.exp(-(((Math.abs(lat) - 25) / 8) ** 2));
  const track = 45 + 1.5 * warm;
  const storms = 4 * (1 + 0.04 * warm) * Math.exp(-(((Math.abs(lat) - track) / 10) ** 2)) * (0.7 + 0.3 * Math.cos(2 * lon * rad + 3 * lat * rad));
  const ripple = 0.8 * Math.sin(5 * lon * rad + 3 * lat * rad) * Math.sin(7 * lat * rad - 2 * lon * rad + (wobble ? year * 0.5 : 0));
  return Math.max(0, (0.4 + band + storms + ripple) * dry);
};
// Wettest day of the year (mm/day): heavier where it rains more, and heavier with warming.
const rx1day: At = (lon, lat, year, wobble) => (4 + 3.5 * pr(lon, lat, year, wobble)) * (1 + 0.05 * warming(year));
// Longest dry spell (days): long where it rains little.
const cdd: At = (lon, lat, year, wobble) => 3 + 110 * Math.exp(-pr(lon, lat, year, wobble) / 1.2);
// Near-surface temperature (°C): warm tropics, cold poles, warming stronger toward the poles.
const tas: At = (lon, lat, year, wobble = true) =>
  -28 + 55 * Math.cos(lat * rad) ** 1.4 + 4 * Math.sin(2 * lon * rad) * Math.cos(lat * rad) +
  warming(year) * (1 + Math.abs(lat) / 60) + (wobble ? 0.4 * Math.sin(year * 1.3 + lon * rad) : 0);

// A grid from a formula, keeping only the latest year per key: a field is 260 kB and takes a few ms to make.
const latest = new Map<string, Field>();
const grid = (key: string, units: string, range: [number, number], name: string, at: (lon: number, lat: number) => number, year: number): Field => {
  const label = `${name} · ${year}`;
  const kept = latest.get(key);
  if (kept?.label === label) return kept;
  const values = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) values[j * W + i] = at(-180 + i + 0.5, -90 + j + 0.5);
  }
  const field = { values, width: W, height: H, units, label, range };
  latest.set(key, field);
  return field;
};

// Ensemble statistics of a metric's change since 1970. Spread (standard deviation across models, `scale` sets
// its size in the metric's units) grows with warming. Agreement (fraction of models agreeing on the sign of
// the change, 0.5 = a coin flip, IPCC style) is high where the forced change is large against the spread; both
// show no signal before the warming starts.
function statistics(id: string, units: string, at: At, scale: number): Statistic[] {
  const spread = (lon: number, lat: number, year: number) =>
    scale * (1 + 0.5 * Math.sin(3 * lon * rad) * Math.cos(4 * lat * rad)) * (1 + warming(year) / 6);
  const agreement = (lon: number, lat: number, year: number) =>
    0.5 + 0.5 * Math.tanh(Math.abs(at(lon, lat, year, false) - at(lon, lat, 1970, false)) / (1.6 * spread(lon, lat, year)));
  const stat = (s: Omit<Statistic, 'load'>, f: (lon: number, lat: number, year: number) => number): Statistic => ({
    ...s,
    load: (year) => grid(`${id}/${s.id}`, s.units, s.range, s.name, (lon, lat) => f(lon, lat, year), year),
  });
  return [
    stat({ id: 'agreement', name: 'Model agreement', units: 'fraction of models', range: [0.5, 1], threshold: 0.8 }, agreement),
    stat({ id: 'spread', name: 'Model spread', units, range: [0, 3 * scale], threshold: 1.6 * scale }, spread),
  ];
}

// Area-weighted global mean per year, sampled every 3° (about 20 ms for all years), computed once.
function globalMean(name: string, units: string, at: At): () => Series {
  let series: Series | undefined;
  return () => {
    if (series) return series;
    const [x, y]: number[][] = [[], []];
    for (let year = YEARS[0]; year <= YEARS[1]; year++) {
      let [sum, weight] = [0, 0];
      for (let lat = -88.5; lat < 90; lat += 3) {
        const w = Math.cos(lat * rad);
        for (let lon = -178.5; lon < 180; lon += 3) {
          sum += w * at(lon, lat, year);
          weight += w;
        }
      }
      x.push(year);
      y.push(sum / weight);
    }
    return (series = { x, y, label: `Global mean ${name.toLowerCase()} (mock)`, units, xLabel: 'year' });
  };
}

const metric = (id: string, name: string, group: string, units: string, range: [number, number], at: At, spread: number): Metric => ({
  id,
  name,
  group,
  units,
  range,
  load: (year) => grid(id, units, range, name, (lon, lat) => at(lon, lat, year), year),
  series: globalMean(name, units, at),
  statistics: statistics(id, units, at, spread),
});

export const DATASET: Dataset = {
  name: 'GFDL-CM4',
  detail: 'historical + SSP2-4.5 · r1i1p1f1 · mock data',
  metrics: [
    metric('pr', 'Precipitation', 'Precipitation', 'mm/day', [0, 14], pr, 0.5),
    metric('rx1day', 'Wettest day', 'Precipitation', 'mm/day', [0, 60], rx1day, 2),
    metric('cdd', 'Longest dry spell', 'Precipitation', 'days', [0, 120], cdd, 6),
    metric('tas', 'Temperature', 'Temperature', '°C', [-30, 35], tas, 0.8),
  ],
};
