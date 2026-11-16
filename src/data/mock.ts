import type { Field, Series } from './cmip6';

// Stand-in data for the layout mockup: an analytic monthly precipitation climatology on the target
// 1° grid (360 x 180, cell-centred, south to north, west to east), so the globe can be built without
// the bucket. Not real data; replace with loadField/loadSeries once the layout settles.
const W = 360;
const H = 180;
export const MOCK = { units: 'mm/day', range: [0, 14] as [number, number] };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const rad = Math.PI / 180;
const fields = new Map<number, Field>();

// A rain band that follows the sun (north in July), wetter over the Maritime Continent, Amazon and
// Congo, mid-latitude storm tracks, and some ripples so the texture has structure.
export function mockField(month: number): Field {
  let field = fields.get(month);
  if (field) return field;
  const values = new Float32Array(W * H);
  const itcz = 8 * Math.sin(((month - 3) / 12) * 2 * Math.PI);
  for (let j = 0; j < H; j++) {
    const lat = -90 + j + 0.5;
    for (let i = 0; i < W; i++) {
      const lon = -180 + i + 0.5;
      const land = Math.exp(-(((lon - 120) / 35) ** 2)) + 0.7 * Math.exp(-(((lon + 60) / 20) ** 2)) + 0.6 * Math.exp(-(((lon - 20) / 15) ** 2));
      const band = (6 + 6 * land) * Math.exp(-(((lat - itcz) / 7) ** 2));
      const storms = 4 * Math.exp(-(((Math.abs(lat) - 45) / 10) ** 2)) * (0.7 + 0.3 * Math.cos(2 * lon * rad + lat * rad * 3));
      const ripple = 0.8 * Math.sin(5 * lon * rad + 3 * lat * rad) * Math.sin(7 * lat * rad - 2 * lon * rad + month);
      values[j * W + i] = Math.max(0, 0.4 + band + storms + ripple);
    }
  }
  field = { values, width: W, height: H, units: MOCK.units, label: `Precipitation · ${MONTHS[month]}`, range: MOCK.range };
  fields.set(month, field);
  return field;
}

// A yearly global mean with a slight trend and wiggles, for the chart panel.
export function mockSeries(): Series {
  const x = Array.from({ length: 165 }, (_, i) => 1850 + i);
  const y = x.map((t, i) => 2.9 + 0.0004 * i + 0.02 * Math.sin(i * 0.37) + 0.012 * Math.sin(i * 1.31 + 1) + 0.008 * Math.sin(i * 2.9 + 2));
  return { x, y, label: '1850–2014, mock', units: 'mm/day', xLabel: 'year' };
}
