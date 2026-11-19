import type { Series } from '../data/cmip6';
import { focused } from '../state/globes';
import type { Viewport } from './types';

const MARGIN = { top: 22, right: 22, bottom: 22, left: 36 }; // sides fit the end ticks and needle label
const NEAR = 6; // px: how close the pointer must be to a plume line to pick it out

// A time axis that doubles as a chart: the series as a line (Observable Plot, drawn once per resize) over its
// plume (the members or models behind a mean, faint), and a needle marking the year, all of the focused globe
// (src/state/globes.ts); small ticks on the axis mark the other globes' years. Drag the needle or click the chart to
// move it (`onYear` sets the year of the globes the timeline moves); it is also a keyboard slider (arrows, Page
// Up/Down, Home/End). Moving the needle only restyles a few elements, so it is cheap. The selected member's line is
// drawn in the accent colour, and a line near the pointer is picked out and named; both are an overlay redrawn on
// its own, not the chart.
export const timeline = (
  load: (node: string, metric: string) => Series | Promise<Series>, // a loaded node's series for a metric
  range: [number, number],
  onYear: (year: number) => void,
): Viewport => ({
  mount(el, initial) {
    el.tabIndex = 0;
    el.role = 'slider';
    el.ariaLabel = 'Year';
    el.ariaValueMin = String(range[0]);
    el.ariaValueMax = String(range[1]);
    el.style.cssText += ';cursor:ew-resize;touch-action:none';

    const needle = document.createElement('div');
    needle.style.cssText =
      `position:absolute;top:${MARGIN.top - 4}px;bottom:${MARGIN.bottom}px;width:2px;margin-left:-1px;` +
      'background:var(--accent);pointer-events:none;display:none';
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding:0 6px;border-radius:4px;' +
      'font:600 12px system-ui,sans-serif;background:var(--accent);color:var(--on-accent)';
    const dot = document.createElement('div');
    dot.style.cssText =
      'position:absolute;left:-3px;width:8px;height:8px;margin-top:-4px;border-radius:50%;' +
      'background:var(--accent);box-shadow:0 0 0 2px var(--bg)';
    needle.append(label, dot);
    const tip = document.createElement('div'); // the name and value of the line under the pointer
    tip.style.cssText =
      `position:absolute;top:2px;right:${MARGIN.right}px;font:11px system-ui,sans-serif;color:var(--fg);` +
      'pointer-events:none;display:none';
    const ticks = document.createElement('div'); // the other globes' years
    ticks.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    el.append(ticks, needle, tip);

    let year = focused(initial).year;
    let others: number[] = []; // the other globes' years, where they differ from the focus's
    let svg: (SVGSVGElement & { scale(name: string): { apply(v: number): number; invert(p: number): number } }) | undefined;
    let values = new Map<number, number>();
    let [xs, units] = [[] as number[], ''];
    let plume: { key: string; y: number[] }[] = [];
    let highlight = focused(initial).selection.member; // the selected member, even without maps (the node is then its ensemble)
    let hovered: { key: string; at: number } | undefined; // a plume line near the pointer, and the year index there

    // The overlay: the highlighted and hovered plume lines, drawn into the chart's SVG.
    let overlay: SVGGElement | undefined;
    const mark = () => {
      overlay?.remove();
      tip.style.display = hovered ? '' : 'none';
      if (!svg) return;
      const [x, y] = [svg.scale('x'), svg.scale('y')];
      overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const [key, stroke, width] of [[highlight, 'var(--accent)', 2], [hovered?.key, 'var(--fg)', 1.5]] as const) {
        const line = key && plume.find((l) => l.key === key);
        if (!line) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', line.y.map((v, i) => `${i ? 'L' : 'M'}${x.apply(xs[i])},${y.apply(v)}`).join(''));
        path.setAttribute('style', `fill:none;stroke:${stroke};stroke-width:${width}px`);
        overlay.append(path);
      }
      svg.append(overlay);
      if (hovered) {
        const v = plume.find((l) => l.key === hovered!.key)!.y[hovered.at];
        tip.textContent = `${hovered.key} · ${xs[hovered.at]}: ${Number(v.toPrecision(3))} ${units}`;
      }
    };

    const place = () => {
      el.ariaValueNow = String(year);
      label.textContent = String(year);
      if (!svg) return;
      const [x, y] = [svg.scale('x'), svg.scale('y')];
      needle.style.left = `${x.apply(year)}px`;
      needle.style.display = '';
      ticks.replaceChildren(
        ...others.map((o) => {
          const t = document.createElement('div');
          t.style.cssText =
            `position:absolute;left:${x.apply(o) - 1}px;bottom:${MARGIN.bottom}px;width:2px;height:10px;` +
            'background:var(--accent);opacity:0.6';
          return t;
        }),
      );
      const v = values.get(year);
      dot.style.display = v === undefined ? 'none' : '';
      if (v !== undefined) dot.style.top = `${y.apply(v) - (MARGIN.top - 4)}px`;
    };
    const set = (y: number) => {
      const next = Math.min(range[1], Math.max(range[0], Math.round(y)));
      if (next !== year) onYear(next); // comes back through update()
    };

    let draw = () => {};
    const observer = new ResizeObserver(() => draw());
    let alive = true;
    let shown = `${focused(initial).node} ${initial.metric}`; // the node and metric drawn (or loading)
    const plot = import('@observablehq/plot');
    // Loads a metric's series and draws it; a newer pick (another metric or node) or unmounting wins over a slow load.
    const show = async (key: string, node: string, id: string) => {
      const [Plot, s] = await Promise.all([plot, load(node, id)]);
      if (!alive || key !== shown) return;
      const rows = s.x.map((x, i) => ({ x, y: s.y[i] }));
      values = new Map(rows.map((r) => [r.x, r.y]));
      [xs, units, plume, hovered] = [s.x, s.units, s.plume ?? [], undefined];
      const plumeRows = plume.flatMap((l) => l.y.map((y, i) => ({ x: s.x[i], y, key: l.key })));
      const floor = Math.min(...s.y); // the area starts at the lowest value, not 0, so the trend shows
      draw = () => {
        if (!el.clientWidth || !el.clientHeight) return;
        svg?.remove();
        svg = Plot.plot({
          width: el.clientWidth,
          height: el.clientHeight,
          marginTop: MARGIN.top,
          marginRight: MARGIN.right,
          marginBottom: MARGIN.bottom,
          marginLeft: MARGIN.left,
          style: { background: 'transparent', color: 'var(--fg)', fontSize: '11px' },
          x: { domain: range, label: null, tickFormat: 'd', ticks: Math.max(2, Math.floor(el.clientWidth / 90)) },
          y: { label: `${s.label}, ${s.units}`, labelAnchor: 'top', ticks: 3, grid: true, nice: true },
          marks: [
            // Fainter the more lines there are, so 50 members stay a haze around the mean, not a dark band.
            Plot.lineY(plumeRows, { x: 'x', y: 'y', z: 'key', stroke: 'currentColor', strokeOpacity: Math.min(0.2, Math.max(0.05, 2.5 / plume.length)), strokeWidth: 1 }),
            Plot.areaY(rows, { x: 'x', y1: floor, y2: 'y', fill: 'var(--accent)', fillOpacity: 0.12 }),
            Plot.lineY(rows, { x: 'x', y: 'y', strokeWidth: 1.75 }),
          ],
        }) as typeof svg;
        el.prepend(svg!);
        mark();
        place();
      };
      draw();
      observer.observe(el); // redraws on resize (observing again is a no-op)
    };
    show(shown, focused(initial).node, initial.metric);

    const fromPointer = (e: PointerEvent) => svg && set(svg.scale('x').invert(e.clientX - el.getBoundingClientRect().left));
    let dragging = false;
    const listening = new AbortController();
    const { signal } = listening;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      fromPointer(e);
    }, { signal });
    // Without a button down, the pointer picks out the plume line nearest to it at its year (within NEAR px).
    const hover = (e: PointerEvent) => {
      let next: typeof hovered;
      if (svg && plume.length) {
        const box = el.getBoundingClientRect();
        const [x, y] = [svg.scale('x'), svg.scale('y')];
        const at = xs.indexOf(Math.round(x.invert(e.clientX - box.left)));
        let best = NEAR;
        for (const l of at < 0 ? [] : plume) {
          const d = Math.abs(y.apply(l.y[at]) - (e.clientY - box.top));
          if (d < best) [best, next] = [d, { key: l.key, at }];
        }
      }
      if (next?.key !== hovered?.key || next?.at !== hovered?.at) {
        hovered = next;
        mark();
      }
    };
    el.addEventListener('pointermove', (e) => (dragging ? fromPointer(e) : hover(e)), { signal });
    el.addEventListener('pointerleave', () => hovered && ((hovered = undefined), mark()), { signal });
    el.addEventListener('pointerup', () => (dragging = false), { signal });
    el.addEventListener('pointercancel', () => (dragging = false), { signal });
    el.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
      const to = e.key === 'Home' ? range[0] : e.key === 'End' ? range[1] : step && year + step;
      if (to === undefined) return;
      e.preventDefault();
      set(to);
    }, { signal });

    place();
    return {
      update(state) {
        const f = focused(state);
        year = f.year;
        others = [...new Set(state.globes.map((g) => g.year))].filter((y) => y !== year);
        place();
        const key = `${f.node} ${state.metric}`;
        if (key !== shown) show((shown = key), f.node, state.metric);
        if (f.selection.member !== highlight) {
          highlight = f.selection.member;
          mark();
        }
      },
      destroy() {
        alive = false;
        listening.abort();
        observer.disconnect();
        svg?.remove();
        needle.remove();
        tip.remove();
      },
    };
  },
});
