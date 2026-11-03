import { GLOBE_BACKGROUND } from './fieldLayer';
import type { Viewport } from './types';

// The trame pages assume a fixed shape (see trame/app.py), so the iframe is letterboxed to it.
const ASPECT = { flat: 2, globe: 1 } as const;
const NAME = { flat: 'Flat map', globe: 'Globe' } as const;

// A trame page in an iframe. Only the initial state travels in the URL: the page is picked by
// view and colormap, and a colormap change reloads it. Nothing is synced live.
export function trameView(kind: keyof typeof ASPECT, base: string): Viewport {
  return {
    name: NAME[kind],
    engine: 'trame',
    mount(el, initial) {
      const frame = document.createElement('iframe');
      frame.title = `${NAME[kind]} (trame)`;
      frame.style.cssText = 'position:absolute;border:0;background:transparent';
      let url = '';
      const show = (colormap: string) => {
        const next = `${base}/index.html?ui=${kind}-${colormap}`;
        if (next === url) return;
        // replace() rather than setting src, so reloads do not add browser history entries
        if (url) frame.contentWindow?.location.replace(next);
        else frame.src = next;
        url = next;
      };
      show(initial.colormap);
      // The trame page is transparent and letterboxed, so the cell behind it is the backdrop.
      if (kind === 'globe') el.style.background = GLOBE_BACKGROUND;
      el.append(frame);

      const resize = () => {
        const [w, h] = [el.clientWidth, el.clientHeight];
        const width = Math.min(w, h * ASPECT[kind]);
        const height = width / ASPECT[kind];
        Object.assign(frame.style, {
          width: `${width}px`,
          height: `${height}px`,
          left: `${(w - width) / 2}px`,
          top: `${(h - height) / 2}px`,
        });
      };
      const observer = new ResizeObserver(resize);
      observer.observe(el);

      return {
        update: (state) => show(state.colormap),
        destroy() {
          observer.disconnect();
          frame.remove();
        },
      };
    },
  };
}
