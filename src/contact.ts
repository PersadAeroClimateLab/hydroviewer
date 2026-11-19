// The developer's contact, for the metric pane's foot and the About dialog. The address is decoded when the page runs,
// so it never appears whole in the published files, which simple address scrapers read (the minifier folds string
// joins back into the address, but cannot run atob).
export const DEVELOPER = 'Cameron Cummins';
export const EMAIL = atob('Y2FtZXJvbi5jdW1taW5zQHV0ZXhhcy5lZHU=');
// A subject, so feedback is easy to spot and filter.
export const MAIL = `mailto:${EMAIL}?subject=${encodeURIComponent('Hydroviewer feedback')}`;
export const ISSUES = 'https://github.com/PersadAeroClimateLab/hydroviewer/issues/new';

// Copies text to the clipboard. The Clipboard API needs a secure page (https or localhost); elsewhere (e.g. the
// dev server reached by another name) a hidden text area and the older copy command stand in.
export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // not a secure page, or refused: fall through
  }
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}
