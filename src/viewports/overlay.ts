import { STOPS, type Palette } from './colormaps';

// A small text chip at `place` in a viewport (default top left); follows the page theme.
// Mirrored by the chips of the trame pages (trame/app.py).
export function createOverlay(parent: HTMLElement, place = 'left:8px;top:8px'): HTMLDivElement {
  const chip = document.createElement('div');
  chip.style.cssText =
    `position:absolute;${place};padding:2px 8px;border-radius:4px;font:14px system-ui,sans-serif;` +
    'color:var(--fg);background:color-mix(in srgb, var(--bg) 80%, transparent);pointer-events:none';
  parent.append(chip);
  return chip;
}

// Evenly spaced stops with linear blending, the same as colorAt and the shader's lookup table.
export const gradient = (colormap: Palette) => `linear-gradient(to right, ${STOPS[colormap].join(', ')})`;

const format = (v: number) => String(Number(v.toPrecision(3)));

// Bottom-left colour bar over the colour scale, units on top so the end ticks stay short (and a
// middle zero tick centred); hidden until the range is known.
export function createColorbar(parent: HTMLElement, colormap: Palette) {
  const chip = createOverlay(parent, 'left:8px;bottom:8px;font-size:12px;display:none');
  chip.innerHTML =
    '<div></div><div style="width:160px;height:10px;margin-top:2px"></div>' +
    '<div style="display:flex;justify-content:space-between;gap:12px"></div>';
  const [unit, bar, ticks] = chip.children as HTMLCollectionOf<HTMLElement>;
  const setColormap = (c: Palette) => (bar.style.background = gradient(c));
  setColormap(colormap);
  return {
    setColormap,
    // A range below zero is diverging and symmetric, so zero gets the middle tick.
    setRange(vmin: number, vmax: number, units: string) {
      const labels = [format(vmin), ...(vmin < 0 ? ['0'] : []), format(vmax)];
      unit.textContent = units;
      ticks.replaceChildren(...labels.map((textContent) => Object.assign(document.createElement('span'), { textContent })));
      chip.style.display = '';
    },
    remove: () => chip.remove(),
  };
}

// Note under the top-left chip on viewports whose surface rises with uncertainty; stacked, not
// side by side, so the two fit in small square globe cells.
export function createReliefNote(parent: HTMLElement): HTMLDivElement {
  const chip = createOverlay(parent, 'left:8px;top:34px');
  chip.textContent = 'Elevation = uncertainty (dummy data)';
  return chip;
}
