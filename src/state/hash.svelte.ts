import { analyses } from './analyses';
import { layouts, ui } from './layout.svelte';
import { colormaps, shared } from './shared.svelte';

// Mirrors the view state to location.hash (#analysis=total&layout=2x2&colormap=magma) so a view can be
// shared by URL. Unknown values in the hash are ignored.
const read = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const analysis = analyses.find((a) => a.id === params.get('analysis'));
  if (analysis) ui.analysisId = analysis.id;
  const layout = layouts.find((l) => l.id === params.get('layout'));
  if (layout) ui.layoutId = layout.id;
  const colormap = colormaps.find((c) => c === params.get('colormap'));
  if (colormap) shared.colormap = colormap;
};

export function syncHash() {
  read();
  $effect.root(() => {
    $effect(() => {
      const hash = `#${new URLSearchParams({ analysis: ui.analysisId, layout: ui.layoutId, colormap: shared.colormap })}`;
      // replaceState, not assignment: changing a control should not add a history entry.
      if (hash !== location.hash) history.replaceState(null, '', hash);
    });
  });
  addEventListener('hashchange', read);
}
