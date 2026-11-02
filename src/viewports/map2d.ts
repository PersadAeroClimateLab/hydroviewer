import type { Field } from '../data/cmip6';
import { loadMonth } from '../data/cmip6';
import type { Colormap } from '../state/shared.svelte';
import { colorAt } from './colormaps';
import type { Viewport } from './types';

// Flat equirectangular map of one month. Drawn from a width x height image that the
// browser scales, so per-frame work is a single drawImage.
export const map2d: Viewport = {
  mount(el, initial) {
    const canvas = document.createElement('canvas');
    el.append(canvas);
    const ctx = canvas.getContext('2d')!;
    let colormap = initial.colormap;
    let field: Field | undefined;
    let vmax = 1;
    let image: HTMLCanvasElement | undefined;
    let message = 'Loading…';
    let alive = true;

    // Colour scale tops out at the 99th percentile: precipitation has a long tail.
    const paint = () => {
      const f = field!;
      image ??= Object.assign(document.createElement('canvas'), { width: f.width, height: f.height });
      const data = new ImageData(f.width, f.height);
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          const [r, g, b] = colorAt(colormap, f.values[(f.height - 1 - y) * f.width + x] / vmax);
          data.data.set([r, g, b, 255], (y * f.width + x) * 4);
        }
      }
      image.getContext('2d')!.putImageData(data, 0, 0);
    };

    const draw = () => {
      const { width, height } = canvas;
      const scale = devicePixelRatio;
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${14 * scale}px system-ui, sans-serif`;
      if (!field || !image) {
        ctx.fillStyle = '#888';
        ctx.fillText(message, 16 * scale, 28 * scale);
        return;
      }
      const w = Math.min(width, 2 * height); // 360° x 180° is 2:1
      const h = w / 2;
      const [x, y] = [(width - w) / 2, (height - h) / 2];
      ctx.drawImage(image, x, y, w, h);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4 * scale;
      ctx.fillText(`pr · ${field.label} · 0–${vmax.toFixed(1)} ${field.units}`, x + 12 * scale, y + 24 * scale);
      ctx.shadowBlur = 0;
    };

    loadMonth(0).then(
      (f) => {
        if (!alive) return;
        field = f;
        vmax = [...f.values].sort((a, b) => a - b)[Math.floor(0.99 * f.values.length)];
        paint();
        draw();
      },
      (e) => {
        message = `Could not load data: ${e instanceof Error ? e.message : e}`;
        if (alive) draw();
      },
    );

    const observer = new ResizeObserver(() => {
      canvas.width = el.clientWidth * devicePixelRatio;
      canvas.height = el.clientHeight * devicePixelRatio;
      draw();
    });
    observer.observe(el);

    return {
      update(state) {
        colormap = state.colormap as Colormap;
        if (field) paint();
        draw();
      },
      destroy() {
        alive = false;
        observer.disconnect();
        canvas.remove();
      },
    };
  },
};
