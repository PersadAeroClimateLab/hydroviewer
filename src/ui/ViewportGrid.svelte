<script lang="ts">
  import { layouts, ui } from '../state/layout.svelte';
  import { trame } from '../state/trame.svelte';
  import { flatMap } from '../viewports/flatMap';
  import { globe } from '../viewports/globe';
  import { placeholder } from '../viewports/placeholder';
  import { trameView } from '../viewports/trameFrame';
  import type { Viewport } from '../viewports/types';
  import ViewportHost from './ViewportHost.svelte';

  // Until cells can be assigned a viewport type, A and B are three.js (flat map, globe) and, while a
  // trame server answers, C and D are the same two views rendered by trame.
  const viewports: Record<string, Viewport> = $derived({
    a: flatMap,
    b: globe,
    ...(trame.url && { c: trameView('flat', trame.url), d: trameView('globe', trame.url) }),
  });

  const layout = $derived(layouts.find((l) => l.id === ui.layoutId)!);
  const rows = $derived(layout.areas.map((row) => row.split(' ')));
  // Keyed by area letter, so cells that exist in both layouts keep their viewport mounted.
  const cells = $derived([...new Set(rows.flat())]);
</script>

<div
  class="grid"
  style:--areas={layout.areas.map((row) => `"${row}"`).join(' ')}
  style:--cols="repeat({rows[0].length}, minmax(0, 1fr))"
  style:--rows="repeat({rows.length}, minmax(0, 1fr))"
>
  {#each cells as cell (cell)}
    {@const viewport = viewports[cell] ?? placeholder}
    <section style:--area={cell}>
      <header>
        <h3>{cell.toUpperCase()} · {viewport.name}</h3>
        <span>{viewport.engine}</span>
      </header>
      <div class="body">
        {#key viewport}
          <ViewportHost {viewport} />
        {/key}
      </div>
    </section>
  {/each}
</div>

<style>
  .grid {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-areas: var(--areas);
    grid-template-columns: var(--cols);
    grid-template-rows: var(--rows);
    gap: 0.5rem;
    padding: 0.5rem;
  }
  section {
    grid-area: var(--area);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  h3 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }
  header span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  @media (max-width: 720px) {
    .grid {
      flex: none;
      grid-template-areas: none;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: none;
      grid-auto-rows: 18rem;
    }
    section {
      grid-area: auto;
    }
  }
</style>
