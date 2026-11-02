// A small text chip in the corner of a viewport; follows the page theme.
export function createOverlay(parent: HTMLElement): HTMLDivElement {
  const chip = document.createElement('div');
  chip.style.cssText =
    'position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:4px;font:14px system-ui,sans-serif;' +
    'color:var(--fg);background:color-mix(in srgb, var(--bg) 80%, transparent);pointer-events:none';
  parent.append(chip);
  return chip;
}
