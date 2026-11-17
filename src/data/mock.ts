import type { Field, Series } from './cmip6';

// Stand-in data for the layout mockup: annual-mean precipitation from an analytic formula on the target
// 1° grid (360 x 180, cell-centred, south to north, west to east), 1950-2100, so the globe and timeline
// can be built without the bucket. Not real data; replace with the bucket once the layout settles.
const W = 360;
const H = 180;
export const YEARS: [number, number] = [1950, 2100];
export const MOCK = { units: 'mm/day', range: [0, 14] as [number, number] };

const rad = Math.PI / 180;

// A tropical rain band that wobbles from year to year, wetter over the Maritime Continent, Amazon and
// Congo, mid-latitude storm tracks and some ripples. Warming (from about 1970) makes the band wetter,
// the subtropics drier and moves the storm tracks poleward.
function value(lon: number, lat: number, year: number): number {
  const warm = 3 * Math.max(0, (year - 1970) / 130) ** 1.6;
  const itcz = 2 + 1.5 * Math.sin(year * 0.9) + Math.sin(year * 0.37);
  const land = Math.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * Math.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * Math.exp(-(((lon - 20) / 15) ** 2));
  const band = (6 + 6 * land) * (1 + 0.07 * warm) * Math.exp(-(((lat - itcz) / 8) ** 2));
  const dry = 1 - 0.06 * warm * Math.exp(-(((Math.abs(lat) - 25) / 8) ** 2));
  const track = 45 + 1.5 * warm;
  const storms = 4 * (1 + 0.04 * warm) * Math.exp(-(((Math.abs(lat) - track) / 10) ** 2)) * (0.7 + 0.3 * Math.cos(2 * lon * rad + 3 * lat * rad));
  const ripple = 0.8 * Math.sin(5 * lon * rad + 3 * lat * rad) * Math.sin(7 * lat * rad - 2 * lon * rad + year * 0.5);
  return Math.max(0, (0.4 + band + storms + ripple) * dry);
}

let last: Field | undefined; // only the latest year: a field is 260 kB and they take a few ms to make

export function mockField(year: number): Field {
  if (last?.label.endsWith(String(year))) return last;
  const values = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) values[j * W + i] = value(-180 + i + 0.5, -90 + j + 0.5, year);
  }
  return (last = { values, width: W, height: H, units: MOCK.units, label: `Precipitation · ${year}`, range: MOCK.range });
}

// Area-weighted global mean of the same formula per year, sampled every 3° (about 20 ms for all years).
export function mockSeries(): Series {
  const x: number[] = [];
  const y: number[] = [];
  for (let year = YEARS[0]; year <= YEARS[1]; year++) {
    let [sum, weight] = [0, 0];
    for (let lat = -88.5; lat < 90; lat += 3) {
      const w = Math.cos(lat * rad);
      for (let lon = -178.5; lon < 180; lon += 3) {
        sum += w * value(lon, lat, year);
        weight += w;
      }
    }
    x.push(year);
    y.push(sum / weight);
  }
  return { x, y, label: 'Global mean (mock)', units: MOCK.units, xLabel: 'year' };
}
