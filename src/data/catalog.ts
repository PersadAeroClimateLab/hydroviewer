import * as zarr from 'zarrita';
import type { Dataset, Field, Metric, Series, Statistic } from './cmip6';
import { dataBase } from './config';

// What catalog.json (at the bucket root) says about a dataset: its store and which arrays in it are metrics
// and statistics. Names, units and ranges come from the arrays' attributes.
interface Entry {
  name: string;
  detail: string;
  store: string; // relative to the bucket root
  metrics: { id: string; group: string; statistics: string[] }[];
}

type Attrs = { units: string; long_name: string; display_range: [number, number]; stipple_threshold: number };

// The first dataset in the catalog, and its first and last year. A metric `pr` is the array `pr` (year, lat, lon)
// with `pr_<statistic>` on the same axes and `pr_global_mean` (year); see prep/make_mock.py.
export async function loadDataset(): Promise<{ dataset: Dataset; years: [number, number] }> {
  const response = await fetch(`${dataBase}/catalog.json`);
  if (!response.ok) throw new Error(`${dataBase}/catalog.json: HTTP ${response.status}`);
  const entry = ((await response.json()) as { datasets: Entry[] }).datasets[0];
  const store = await zarr.withConsolidatedMetadata(new zarr.FetchStore(`${dataBase}/${entry.store}`), { format: 'v3' });
  const root = await zarr.open.v3(store, { kind: 'group' });
  const open = (name: string) => zarr.open.v3(root.resolve(name), { kind: 'array' });
  const years = Array.from((await zarr.get(await open('year'))).data as Int32Array);

  // A field per year, keeping only the latest request per array: the globe and the PNG export share it.
  const grids = (array: zarr.Array<zarr.DataType, zarr.Readable>) => {
    const attrs = array.attrs as Attrs;
    let kept: { year: number; field: Promise<Field> } | undefined;
    return (year: number) => {
      if (kept?.year !== year) {
        const field = zarr.get(array, [years.indexOf(year), null, null]).then(({ data }) => ({
          values: data as Float32Array,
          height: array.shape[1],
          width: array.shape[2],
          units: attrs.units,
          label: `${attrs.long_name} · ${year}`,
          range: attrs.display_range,
        }));
        kept = { year, field };
      }
      return kept.field;
    };
  };

  const metrics = await Promise.all(
    entry.metrics.map(async ({ id, group, statistics }): Promise<Metric> => {
      const [array, mean, ...stats] = await Promise.all([id, `${id}_global_mean`, ...statistics.map((s) => `${id}_${s}`)].map(open));
      const attrs = array.attrs as Attrs;
      let series: Promise<Series> | undefined;
      return {
        id,
        name: attrs.long_name,
        group,
        units: attrs.units,
        range: attrs.display_range,
        load: grids(array),
        series: () =>
          (series ??= zarr.get(mean).then(({ data }) => ({
            x: years,
            y: Array.from(data as Float32Array),
            label: (mean.attrs as Attrs).long_name,
            units: attrs.units,
            xLabel: 'year',
          }))),
        statistics: stats.map((s, i): Statistic => {
          const a = s.attrs as Attrs;
          return { id: statistics[i], name: a.long_name, units: a.units, range: a.display_range, threshold: a.stipple_threshold, load: grids(s) };
        }),
      };
    }),
  );
  return { dataset: { name: entry.name, detail: entry.detail, metrics }, years: [years[0], years[years.length - 1]] };
}
