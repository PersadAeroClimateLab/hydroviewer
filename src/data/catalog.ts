import * as zarr from 'zarrita';
import type { Dataset, Field, Metric, Series, Statistic } from './cmip6';
import { dataBase } from './config';

// catalog.json at the bucket root: the scenario › model › member tree and where each node's store is
// (docs/llm/DATA_TREE_PLAN.md, section 7). Names, units and ranges come from the arrays' attributes.
export interface Run {
  scenario: string;
  model: string;
  institution: string;
  members: string[];
  maps: string[]; // the members with a map store
  store: string; // a member's store, with `{member}` in place of its id
  ensemble: string; // the ensemble store: mean, agreement and spread across members
  series: number; // row of the first member in the series store
}

export interface Catalog {
  mock?: boolean;
  facets: string[];
  scenarios: { id: string; label: string }[];
  metrics: { id: string; group: string; statistics: string[] }[];
  series: string; // store of every member's and ensemble mean's global mean, for plumes
  multimodel: Record<string, { store: string; models: number }>; // per scenario
  runs: Run[];
}

// A node of the tree: a scenario's multi-model mean (no model), a model's ensemble (no member) or one member.
export interface Node {
  scenario: string;
  model?: string;
  member?: string;
}

// A node as a string, e.g. "ssp245/CanESM5/r1i1p1f1", to tell which node the views show.
export const nodeKey = ({ scenario, model, member }: Node) => [scenario, model, member].filter(Boolean).join('/');

type Attrs = { units: string; long_name: string; display_range: [number, number]; stipple_threshold: number; actual_range?: [number, number] };

export async function loadCatalog(): Promise<Catalog> {
  const response = await fetch(`${dataBase}/catalog.json`);
  if (!response.ok) throw new Error(`${dataBase}/catalog.json: HTTP ${response.status}`);
  return response.json();
}

// A store opened once per path (its consolidated metadata and year axis), so returning to a node fetches nothing.
const stores = new Map<string, ReturnType<typeof openStore>>();
const opened = (path: string) => {
  let store = stores.get(path);
  if (!store) stores.set(path, (store = openStore(path)));
  return store;
};
async function openStore(path: string) {
  const store = await zarr.withConsolidatedMetadata(new zarr.FetchStore(`${dataBase}/${path}`), { format: 'v3' });
  const root = await zarr.open.v3(store, { kind: 'group' });
  const open = (name: string) => zarr.open.v3(root.resolve(name), { kind: 'array' });
  const years = Array.from((await zarr.get(await open('year'))).data as Int32Array);
  return { open, years };
}

// The series store's arrays (every member's or ensemble mean's global mean, rows in catalog order), read whole
// once per metric: one small chunk each.
const rows = new Map<string, Promise<{ data: Float32Array; width: number }>>();
function seriesRows(catalog: Catalog, name: string) {
  let read = rows.get(name);
  if (!read) {
    read = opened(catalog.series)
      .then(({ open }) => open(name))
      .then(async (array) => ({ data: (await zarr.get(array)).data as Float32Array, width: array.shape[1] }));
    rows.set(name, read);
  }
  return read;
}

// A node's plume for a metric: its ensemble's members (an ensemble or a member), or the scenario's models'
// ensemble means (the multi-model mean), keyed by member or model.
async function plume(catalog: Catalog, node: Node, metric: string): Promise<{ key: string; y: number[] }[]> {
  const row = ({ data, width }: { data: Float32Array; width: number }, i: number) => Array.from(data.subarray(i * width, (i + 1) * width));
  if (!node.model) {
    const all = await seriesRows(catalog, `${metric}_ensemble_global_mean`);
    return catalog.runs.flatMap((r, i) => (r.scenario === node.scenario ? [{ key: r.model, y: row(all, i) }] : []));
  }
  const run = catalog.runs.find((r) => r.scenario === node.scenario && r.model === node.model)!;
  const all = await seriesRows(catalog, `${metric}_global_mean`);
  return run.members.map((member, i) => ({ key: member, y: row(all, run.series + i) }));
}

// A field per year, keeping the last few years asked for per array: globes, the PNG export and globes at other years
// share them (two globes on one node, or members of one ensemble, which share its statistics, would otherwise evict
// each other's year on every redraw). At most ~0.26 MB per kept year.
const KEEP = 8;
function grids(array: zarr.Array<zarr.DataType, zarr.Readable>, years: number[]) {
  const attrs = array.attrs as Attrs;
  const kept = new Map<number, Promise<Field>>(); // oldest first
  return (year: number) => {
    let field = kept.get(year);
    if (field) kept.delete(year); // moved to the newest end below
    else {
      field = zarr.get(array, [years.indexOf(year), null, null]).then(({ data }) => ({
        values: data as Float32Array,
        height: array.shape[1],
        width: array.shape[2],
        units: attrs.units,
        label: `${attrs.long_name} · ${year}`,
        range: attrs.display_range,
      }));
      if (kept.size >= KEEP) kept.delete(kept.keys().next().value!);
    }
    kept.set(year, field);
    return field;
  };
}

// The Dataset of a node, and its first and last year. A member's fields come from its own store and its
// statistics from its ensemble's (the spread it is drawn from).
export async function openNode(catalog: Catalog, node: Node): Promise<{ dataset: Dataset; years: [number, number] }> {
  const label = catalog.scenarios.find((s) => s.id === node.scenario)?.label ?? node.scenario;
  let fieldsPath: string, statsPath: string, name: string, detail: string;
  if (!node.model) {
    const mm = catalog.multimodel[node.scenario];
    if (!mm) throw new Error(`no multi-model mean for ${node.scenario}`);
    [fieldsPath, statsPath, name, detail] = [mm.store, mm.store, 'Multi-model mean', `${label} · ${mm.models} models`];
  } else {
    const run = catalog.runs.find((r) => r.scenario === node.scenario && r.model === node.model);
    if (!run) throw new Error(`${node.model} has no ${node.scenario}`);
    statsPath = run.ensemble;
    name = node.model;
    if (node.member) {
      if (!run.maps.includes(node.member)) throw new Error(`no maps for ${node.model} ${node.scenario} ${node.member}`);
      [fieldsPath, detail] = [run.store.replace('{member}', node.member), `${label} · ${node.member}`];
    } else [fieldsPath, detail] = [run.ensemble, `${label} · mean of ${run.members.length} members`];
  }
  if (catalog.mock) detail += ' · mock data';

  const [fields, stats] = await Promise.all([opened(fieldsPath), opened(statsPath)]);
  const metrics = await Promise.all(
    catalog.metrics.map(async ({ id, group, statistics }): Promise<Metric> => {
      const [array, mean, ...arrays] = await Promise.all([
        fields.open(id),
        fields.open(`${id}_global_mean`),
        ...statistics.map((s) => stats.open(`${id}_${s}`)),
      ]);
      const attrs = array.attrs as Attrs;
      let series: Promise<Series> | undefined;
      return {
        id,
        name: attrs.long_name.split(',')[0], // "Precipitation, mean of 50 members" -> "Precipitation"
        group,
        units: attrs.units,
        range: attrs.display_range,
        load: grids(array, fields.years),
        series: () =>
          (series ??= Promise.all([zarr.get(mean), plume(catalog, node, id)]).then(([{ data }, lines]) => ({
            x: fields.years,
            y: Array.from(data as Float32Array),
            label: (mean.attrs as Attrs).long_name,
            units: attrs.units,
            xLabel: 'year',
            plume: lines,
          }))),
        statistics: arrays.map((s, i): Statistic => {
          const a = s.attrs as Attrs;
          const extent = a.actual_range ?? a.display_range;
          return { id: statistics[i], name: a.long_name, units: a.units, range: a.display_range, threshold: a.stipple_threshold, extent, load: grids(s, stats.years) };
        }),
      };
    }),
  );
  const years = fields.years;
  return { dataset: { name, detail, metrics }, years: [years[0], years[years.length - 1]] };
}
