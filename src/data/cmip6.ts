import * as zarr from 'zarrita';
import { dataBase } from './config';

// One hard-coded store until catalog.json exists.
const STORE = 'CMIP6/CMIP/NOAA-GFDL/GFDL-CM4/historical/r1i1p1f1/Amon/pr/gr1/v20180701/map.zarr';

export interface Grid {
  values: Float32Array; // row-major, south to north, west to east
  width: number;
  height: number;
}

export interface Field extends Grid {
  units: string;
  label: string; // e.g. "1850-01"
}

const opened = (async () => {
  const store = await zarr.withConsolidatedMetadata(new zarr.FetchStore(`${dataBase}/${STORE}`), { format: 'v3' });
  const root = await zarr.open.v3(store, { kind: 'group' });
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
        label: `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}`,
      };
    });
    months.set(index, field);
  }
  return field;
}
