// Svelte action: drag an element by an offset from where the layout puts it (the caller applies the offset
// as `translate`, owns it and may store it). Pointer (mouse, pen, touch) or arrow keys when focused (Shift for
// bigger steps); the element stays inside its parent, also when the window resizes. Moving only changes a
// transform, so nothing is laid out or redrawn underneath.
export interface Offset {
  x: number;
  y: number;
}

interface Options {
  at: Offset;
  move: (at: Offset) => void;
}

const MARGIN = 8; // px kept between the element and its parent's edges

export function draggable(node: HTMLElement, options: Options) {
  let { at, move } = options;

  // The offset nearest to `want` that keeps the element inside its parent.
  const clamp = (want: Offset): Offset => {
    const box = node.getBoundingClientRect();
    const area = node.parentElement!.getBoundingClientRect();
    const [left, top] = [box.left - at.x, box.top - at.y]; // where the layout puts it, without the offset
    const within = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));
    return {
      x: within(want.x, area.left + MARGIN - left, area.right - MARGIN - box.width - left),
      y: within(want.y, area.top + MARGIN - top, area.bottom - MARGIN - box.height - top),
    };
  };

  let start: { x: number; y: number; at: Offset; id: number } | undefined;
  const down = (e: PointerEvent) => {
    // Controls inside keep their clicks (pointer capture would send them to the panel).
    if (e.button !== 0 || (e.target as Element).closest('button, input, select, a')) return;
    start = { x: e.clientX, y: e.clientY, at, id: e.pointerId };
    node.setPointerCapture(e.pointerId);
    node.style.cursor = 'grabbing';
    e.preventDefault(); // no text selection while dragging
  };
  const drag = (e: PointerEvent) => {
    if (start?.id !== e.pointerId) return;
    move(clamp({ x: start.at.x + e.clientX - start.x, y: start.at.y + e.clientY - start.y }));
  };
  const up = (e: PointerEvent) => {
    if (start?.id !== e.pointerId) return;
    start = undefined;
    node.style.cursor = '';
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 8;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    move(clamp({ x: at.x + d[0], y: at.y + d[1] }));
  };
  const resize = () => {
    const next = clamp(at);
    if (next.x !== at.x || next.y !== at.y) move(next);
  };

  const listening = new AbortController();
  const { signal } = listening;
  node.addEventListener('pointerdown', down, { signal });
  node.addEventListener('pointermove', drag, { signal });
  node.addEventListener('pointerup', up, { signal });
  node.addEventListener('pointercancel', up, { signal });
  node.addEventListener('keydown', key, { signal });
  addEventListener('resize', resize, { signal });
  requestAnimationFrame(resize); // a stored offset may not fit this window

  return {
    update(next: Options) {
      ({ at, move } = next);
    },
    destroy: () => listening.abort(),
  };
}
