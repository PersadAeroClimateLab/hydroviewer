import { loadSeries, type SeriesSource } from '../data/cmip6';
import { STOPS } from './colormaps';
import { createOverlay } from './overlay';
import type { Viewport } from './types';

const NAMES: Record<SeriesSource, string> = {
  pr_global_mean: 'Global mean',
  pr_wettest_month_hist: 'Histogram',
};

// A 2D chart of a series from prep, drawn with Observable Plot. Plot (with d3) is loaded lazily, as
// its own chunk, so analyses without charts don't pay for it. Redrawn as SVG on resize and colormap change.
export const chart = (source: SeriesSource): Viewport => ({
  name: NAMES[source],
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
        const width = s.binWidth ?? 0;
        draw = () => {
          if (!el.clientWidth || !el.clientHeight) return;
          // Histogram bars are coloured like the matching map; a series gets its least-squares line (with
          // a 95% band), fitted here since it is only ~165 points.
          const marks = width
            ? [Plot.rectY(rows, { x1: 'x', x2: (d) => d.x + width, y: 'y', fill: (d) => d.x + width / 2 }), Plot.ruleY([0])]
            : [Plot.lineY(rows, { x: 'x', y: 'y' }), Plot.linearRegressionY(rows, { x: 'x', y: 'y', stroke: 'var(--accent)' })];
          svg?.remove();
          svg = Plot.plot({
            width: el.clientWidth,
            height: el.clientHeight,
            marginTop: 40, // room for the label chip
            marginLeft: 48,
            style: { background: 'transparent', color: 'var(--fg)', fontSize: '12px' },
            x: { label: s.xLabel, tickFormat: width ? undefined : 'd' },
            y: { label: null, grid: true, zero: !!width },
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
