import type { Series } from '../data/cmip6';
import type { Viewport } from './types';

const MARGIN = { top: 22, right: 22, bottom: 22, left: 36 }; // sides fit the end ticks and needle label

// A time axis that doubles as a chart: the series as a line (Observable Plot, drawn once per resize) and a
// needle marking the shared year. Drag the needle or click the chart to move it; it is also a keyboard
// slider (arrows, Page Up/Down, Home/End). Moving the needle only restyles two elements, so it is cheap.
export const timeline = (
  load: (metric: string) => Series | Promise<Series>, // the selected metric's series
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
    el.append(needle);

    let year = initial.year;
    let svg: (SVGSVGElement & { scale(name: string): { apply(v: number): number; invert(p: number): number } }) | undefined;
    let values = new Map<number, number>();

    const place = () => {
      el.ariaValueNow = String(year);
      label.textContent = String(year);
      if (!svg) return;
      const [x, y] = [svg.scale('x'), svg.scale('y')];
      needle.style.left = `${x.apply(year)}px`;
      needle.style.display = '';
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
    let metric = initial.metric;
    const plot = import('@observablehq/plot');
    // Loads a metric's series and draws it; a newer pick or unmounting wins over a slow load.
    const show = async (id: string) => {
      const [Plot, s] = await Promise.all([plot, load(id)]);
      if (!alive || id !== metric) return;
      const rows = s.x.map((x, i) => ({ x, y: s.y[i] }));
      values = new Map(rows.map((r) => [r.x, r.y]));
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
          marks: [Plot.areaY(rows, { x: 'x', y1: floor, y2: 'y', fill: 'var(--accent)', fillOpacity: 0.12 }), Plot.lineY(rows, { x: 'x', y: 'y' })],
        }) as typeof svg;
        el.prepend(svg!);
        place();
      };
      draw();
      observer.observe(el); // redraws on resize (observing again is a no-op)
    };
    show(metric);

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
    el.addEventListener('pointermove', (e) => dragging && fromPointer(e), { signal });
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
        year = state.year;
        place();
        if (state.metric !== metric) show((metric = state.metric));
      },
      destroy() {
        alive = false;
        listening.abort();
        observer.disconnect();
        svg?.remove();
        needle.remove();
      },
    };
  },
});
