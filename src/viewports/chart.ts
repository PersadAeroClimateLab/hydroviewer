import { loadSeries, type SeriesSource } from '../data/cmip6';
import { STOPS } from './colormaps';
import { createOverlay } from './overlay';
import type { Viewport } from './types';

// How each series is drawn: a yearly series with its least-squares line (and 95% band, fitted here since it
// is only ~165 points), a latitude profile around zero, or histogram bars coloured like the matching map.
const CHARTS: Record<SeriesSource, { name: string; kind: 'fit' | 'profile' | 'bars' }> = {
  pr_global_mean: { name: 'Global mean', kind: 'fit' },
  pr_trend_zonal: { name: 'By latitude', kind: 'profile' },
  pr_wettest_month_global: { name: 'Global mean', kind: 'fit' },
  pr_wettest_month_hist: { name: 'Histogram', kind: 'bars' },
};

// A 2D chart of a series from prep, drawn with Observable Plot. Plot (with d3) is loaded lazily, as
// its own chunk, so analyses without charts don't pay for it. Redrawn as SVG on resize and colormap change.
export const chart = (source: SeriesSource): Viewport => ({
  name: CHARTS[source].name,
  engine: 'Observable Plot',
  mount(el, initial) {
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';
    let colormap = initial.colormap;
    let svg: Element | undefined;
    let draw = () => {};
    const observer = new ResizeObserver(() => draw());

    let alive = true;
    Promise.all([import('@observablehq/plot'), loadSeries(source)]).then(
      ([Plot, s]) => {
        if (!alive) return;
        overlay.textContent = `${s.label} · ${s.units}`; // y units here: Plot puts its y label under the chip
        const rows = s.x.map((x, i) => ({ x, y: s.y[i] }));
        const { kind } = CHARTS[source];
        const width = s.binWidth ?? 0;
        draw = () => {
          if (!el.clientWidth || !el.clientHeight) return;
          const marks = {
            fit: [Plot.lineY(rows, { x: 'x', y: 'y' }), Plot.linearRegressionY(rows, { x: 'x', y: 'y', stroke: 'var(--accent)' })],
            profile: [Plot.ruleY([0]), Plot.lineY(rows, { x: 'x', y: 'y' })],
            bars: [Plot.rectY(rows, { x1: 'x', x2: (d) => d.x + width, y: 'y', fill: (d) => d.x + width / 2 }), Plot.ruleY([0])],
          }[kind];
          svg?.remove();
          svg = Plot.plot({
            width: el.clientWidth,
            height: el.clientHeight,
            marginTop: 40, // room for the label chip
            marginLeft: 48,
            style: { background: 'transparent', color: 'var(--fg)', fontSize: '12px' },
            x: {
              label: s.xLabel,
              tickFormat: kind === 'fit' ? 'd' : undefined, // years, without thousands separators
              ...(kind === 'profile' && { domain: [-90, 90], ticks: [-90, -60, -30, 0, 30, 60, 90] }),
            },
            y: { label: null, grid: true, zero: kind === 'bars' },
            color: { type: 'linear', domain: s.range, range: STOPS[colormap], clamp: true },
            marks,
          });
          el.append(svg);
        };
        observer.observe(el); // draws once on observe
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update(state) {
        colormap = state.colormap;
        draw();
      },
      destroy() {
        alive = false;
        observer.disconnect();
        svg?.remove();
        overlay.remove();
      },
    };
  },
});
