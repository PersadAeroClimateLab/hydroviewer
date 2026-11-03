import type { Colormap } from '../state/shared.svelte';
import { STOPS } from './colormaps';

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
export const gradient = (colormap: Colormap) => `linear-gradient(to right, ${STOPS[colormap].join(', ')})`;

// Bottom-left colour bar, 0 to the colour scale max; hidden until the range is known.
export function createColorbar(parent: HTMLElement, colormap: Colormap) {
  const chip = createOverlay(parent, 'left:8px;bottom:8px;font-size:12px;display:none');
  chip.innerHTML =
    '<div style="width:160px;height:10px;margin-top:4px"></div>' +
    '<div style="display:flex;justify-content:space-between"><span>0</span><span></span></div>';
  const [bar, ticks] = chip.children as HTMLCollectionOf<HTMLElement>;
  const setColormap = (c: Colormap) => (bar.style.background = gradient(c));
  setColormap(colormap);
  return {
    setColormap,
    setRange(vmax: number, units: string) {
      ticks.lastElementChild!.textContent = `${vmax.toFixed(1)} ${units}`;
      chip.style.display = '';
    },
    remove: () => chip.remove(),
  };
}

// Top-right note on viewports whose surface rises with uncertainty.
export function createReliefNote(parent: HTMLElement): HTMLDivElement {
  const chip = createOverlay(parent, 'right:8px;top:8px');
  chip.textContent = 'Elevation = uncertainty (dummy data)';
  return chip;
}
