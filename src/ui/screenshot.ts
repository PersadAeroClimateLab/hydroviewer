// A picture of what the globes show, as a PNG: the globes with their labels, the legend and the timeline, under a
// heading; not the data tree, the metric pane, the tools or menus (anything marked `data-no-shot`). The page is
// rendered by html-to-image (loaded on first use), which draws the DOM through the browser itself, so the picture
// matches the screen; it is then cropped to the globes' cells, the legend and the timeline (`keep`).
const PAD = 12; // px around what is kept
const HEADING = 40; // px for the heading line
const SCALE = 2; // pixels per CSS px

export async function screenshot(root: HTMLElement, keep: Element[], heading: string): Promise<Blob> {
  const { toCanvas } = await import('html-to-image');
  // The globes' WebGL canvas cannot be read after it was drawn (see the capture event in globeStage.ts): ask for a
  // fresh picture of it and lay that over it while the page is rendered.
  const gl = root.querySelector<HTMLCanvasElement>('.stage canvas')!;
  const png = await new Promise<string>((done) => gl.dispatchEvent(new CustomEvent('capture', { detail: done })));
  const still = Object.assign(new Image(), { src: png });
  still.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  await still.decode();
  gl.after(still);
  let page: HTMLCanvasElement;
  try {
    page = await toCanvas(root, {
      pixelRatio: SCALE,
      skipFonts: true, // system fonts only; nothing to embed
      filter: (n) => !(n instanceof Element && (n === gl || n.hasAttribute('data-no-shot'))),
    });
  } finally {
    still.remove();
  }

  // The union of the kept parts, in the root's coordinates, padded and kept inside the page.
  const box = root.getBoundingClientRect();
  const rects = keep.map((e) => e.getBoundingClientRect());
  const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - box.left - PAD);
  const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - box.top - PAD);
  const right = Math.min(box.width, Math.max(...rects.map((r) => r.right)) - box.left + PAD);
  const bottom = Math.min(box.height, Math.max(...rects.map((r) => r.bottom)) - box.top + PAD);

  const style = getComputedStyle(root);
  const out = Object.assign(document.createElement('canvas'), {
    width: Math.round((right - left) * SCALE),
    height: Math.round((bottom - top + HEADING) * SCALE),
  });
  const g = out.getContext('2d')!;
  g.fillStyle = style.getPropertyValue('--stage-inner').trim() || '#eef1f4';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(page, left * SCALE, top * SCALE, (right - left) * SCALE, (bottom - top) * SCALE, 0, HEADING * SCALE, out.width, out.height - HEADING * SCALE);
  g.fillStyle = style.getPropertyValue('--fg').trim() || '#1a1d21';
  g.font = `600 ${18 * SCALE}px ${style.fontFamily}`;
  g.textBaseline = 'middle';
  g.fillText(heading, PAD * SCALE, (HEADING / 2 + 4) * SCALE, out.width - 2 * PAD * SCALE);
  return new Promise((done, fail) => out.toBlob((b) => (b ? done(b) : fail(new Error('PNG encoding failed'))), 'image/png'));
}
