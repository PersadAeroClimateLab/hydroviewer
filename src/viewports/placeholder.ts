import { STOPS } from './colormaps';
import type { Viewport } from './types';

// Stand-in until real renderers exist: a colormap ramp that follows the shared state.
export const placeholder: Viewport = {
  name: 'Placeholder',
  engine: 'canvas 2D',
  mount(el, initial) {
    const canvas = document.createElement('canvas');
    el.append(canvas);
    const ctx = canvas.getContext('2d')!;
    let colormap = initial.colormap;

    const draw = () => {
      const { width, height } = canvas;
      const ramp = ctx.createLinearGradient(0, 0, width, 0);
      STOPS[colormap].forEach((color, i, all) => ramp.addColorStop(i / (all.length - 1), color));
      ctx.fillStyle = ramp;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.font = `${16 * devicePixelRatio}px system-ui, sans-serif`;
      ctx.fillText(`${colormap} · ${el.clientWidth}×${el.clientHeight}`, 16 * devicePixelRatio, 32 * devicePixelRatio);
    };

    const observer = new ResizeObserver(() => {
      canvas.width = el.clientWidth * devicePixelRatio;
      canvas.height = el.clientHeight * devicePixelRatio;
      draw();
    });
    observer.observe(el);

    return {
      update(state) {
        colormap = state.colormap;
        draw();
      },
      destroy() {
        observer.disconnect();
        canvas.remove();
      },
    };
  },
};
