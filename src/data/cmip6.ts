import * as zarr from 'zarrita';
import { dataBase } from './config';

// One hard-coded dataset until catalog.json exists.
const PATH = 'CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701';

export interface Grid {
  values: Float32Array; // row-major, south to north, west to east
  width: number;
  height: number;
}

export interface Field extends Grid {
  units: string;
  label: string; // e.g. "pr · 1850-01"
  range?: [number, number]; // colour scale from prep; without it the client picks one
}

// What a panel can show: the first month, or an aggregate written by prep (aggregates.zarr).
export type Source = 'month' | 'pr_trend' | 'pr_wettest_month';

const openStore = async (name: string) => {
  const store = await zarr.withConsolidatedMetadata(new zarr.FetchStore(`${dataBase}/${PATH}/${name}`), {
    format: 'v3',
  });
  return zarr.open.v3(store, { kind: 'group' });
};

const opened = (async () => {
  const root = await openStore('map.zarr');
  const [pr, time] = await Promise.all([
    zarr.open.v3(root.resolve('pr'), { kind: 'array' }),
    zarr.open.v3(root.resolve('time'), { kind: 'array' }),
  ]);
  const [year, month] = String(time.attrs.units).match(/since (\d{4})-(\d{2})/)!.slice(1).map(Number);
  return { root, pr, year, month };
})();

let uncertainty: Promise<Grid> | undefined;

// A synthetic 0..1 uncertainty field (see prep/prep_cmip6.py), used for globe relief.
export function loadUncertainty(): Promise<Grid> {
  uncertainty ??= opened.then(async ({ root }) => {
    const array = await zarr.open.v3(root.resolve('uncertainty'), { kind: 'array' });
    const grid = await zarr.get(array);
    return { values: grid.data as Float32Array, height: array.shape[0], width: array.shape[1] };
  });
  return uncertainty;
}

const months = new Map<number, Promise<Field>>();

// Memoized per month so several viewports share one fetch.
export function loadMonth(index: number): Promise<Field> {
  let field = months.get(index);
  if (!field) {
    field = opened.then(async ({ pr, year, month }) => {
      const slab = await zarr.get(pr, [index, null, null]);
      const at = year * 12 + (month - 1) + index;
      return {
        values: slab.data as Float32Array,
        height: pr.shape[1],
        width: pr.shape[2],
        units: String(pr.attrs.units),
        label: `pr · ${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}`,
      };
    });
    months.set(index, field);
  }
  return field;
}

let aggregates: ReturnType<typeof openStore> | undefined;

// One array of aggregates.zarr, whole, with its attributes.
async function readAggregate(name: string) {
  const root = await (aggregates ??= openStore('aggregates.zarr'));
  const array = await zarr.open.v3(root.resolve(name), { kind: 'array' });
  const { data } = await zarr.get(array);
  return { array, data: data as Float32Array, attrs: array.attrs as Record<string, string & [number, number]> };
}

const fields = new Map<Source, Promise<Field>>();

// Memoized per source, like loadMonth.
export function loadField(source: Source): Promise<Field> {
  if (source === 'month') return loadMonth(0);
  let field = fields.get(source);
  if (!field) {
    field = readAggregate(source).then(({ array, data, attrs }) => ({
      values: data,
      height: array.shape[0],
      width: array.shape[1],
      units: attrs.units,
      label: `${attrs.long_name} · ${attrs.period}`,
      range: attrs.display_range,
    }));
    fields.set(source, field);
  }
  return field;
}

// The contour boxplot of the summer rain band (prep's contour_boxplot()): band levels, the fraction field
// whose 0.5 contour is the mean, and the fields of the median and outlier summers, contoured at `threshold`.
export interface Boxplot {
  level: Grid; // 1 or 3: 100% band, 2: 50% band, 4: inside every kept member
  fraction: Grid;
  median: Grid;
  outliers: Grid[];
  threshold: number;
  latRange: [number, number]; // analysed latitudes; nothing outside them
  medianYear: number;
  outlierYears: number[];
  label: string;
}

let boxplot: Promise<Boxplot> | undefined;

export function loadBoxplot(): Promise<Boxplot> {
  const names = ['pr_jja_band', 'pr_jja_mean_fraction', 'pr_jja_median', 'pr_jja_outliers', 'outlier'];
  boxplot ??= Promise.all(names.map(readAggregate)).then(([band, fraction, median, outliers, years]) => {
    const [height, width] = band.array.shape;
    const grid = (values: Float32Array) => ({ values, height, width });
    const { attrs } = band;
    return {
      level: grid(band.data),
      fraction: grid(fraction.data),
      median: grid(median.data),
      outliers: Array.from(years.data, (_, i) => grid(outliers.data.subarray(i * width * height, (i + 1) * width * height))),
      threshold: Number(attrs.threshold),
      latRange: attrs.lat_range,
      medianYear: Number(attrs.median_year),
      outlierYears: Array.from(years.data),
      label: `${attrs.long_name} · ${attrs.period}`,
    };
  });
  return boxplot;
}

// 1D series from aggregates.zarr, each over its own coordinate (years, latitudes or histogram bin starts).
export type SeriesSource = 'pr_global_mean' | 'pr_trend_zonal' | 'pr_wettest_month_global' | 'pr_wettest_month_hist';

export interface Series {
  x: number[];
  y: number[];
  label: string; // e.g. "Global-mean precipitation · 1850–2014"
  units: string; // of y
  xLabel: string;
  binWidth?: number; // set for histograms
  range?: [number, number]; // colour scale of the matching map
}

const series = new Map<SeriesSource, Promise<Series>>();

export function loadSeries(source: SeriesSource): Promise<Series> {
  let promise = series.get(source);
  if (!promise) {
    promise = readAggregate(source).then(async ({ array, data, attrs }) => {
      const x = await readAggregate(array.dimensionNames![0]!);
      return {
        x: Array.from(x.data),
        y: Array.from(data),
        label: `${attrs.long_name} · ${attrs.period}`,
        units: attrs.units,
        xLabel: x.attrs.units ? `${x.attrs.long_name} (${x.attrs.units})` : x.attrs.long_name,
        binWidth: Number(x.attrs.bin_width) || undefined,
        range: attrs.display_range,
      };
    });
    series.set(source, promise);
  }
  return promise;
}
