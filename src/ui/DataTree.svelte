<script lang="ts">
  import { tick } from 'svelte';
  import { datasetLabel, type Catalog } from '../data/catalog';
  import { ALL, createTree, type Item, type TreeState } from '../data/tree';
  import { focused } from '../state/globes';
  import { shared } from '../state/shared.svelte';

  // The data tree (docs/llm/DATA_TREE_PLAN.md): how the data is organised, dataset › scenarios › models › members,
  // as columns joined by links (the dataset, one per bucket, is only a label); the rules are in data/tree.ts, this only draws them. Closed, a chip at the top reads out the
  // selection; open, the pane drops below it. It shows and changes the focused globe's pick
  // (src/state/globes.ts); its + adds a globe (a copy of the focused one, which the tree then edits). `bottom` is the
  // open pane's lower edge in the HUD and `chipBottom` the chip's, so the globes can stay below them.
  let {
    catalog,
    open = $bindable(false),
    bottom = $bindable(0),
    chipBottom = $bindable(0),
    onAdd,
    canAdd,
  }: { catalog: Catalog; open: boolean; bottom?: number; chipBottom?: number; onAdd: () => void; canAdd: boolean } = $props();
  let chipEl: HTMLDivElement;
  $effect(() => {
    const chip = chipEl;
    const observer = new ResizeObserver(() => (chipBottom = chip.offsetTop + chip.offsetHeight));
    observer.observe(chip);
    return () => observer.disconnect();
  });

  // svelte-ignore state_referenced_locally
  const tree = createTree(catalog); // the catalog is loaded once, before the app mounts
  let hover = $state<TreeState['hover']>({});
  const st = $derived<TreeState>({ selection: focused(shared).selection, hover });
  const set = (next: TreeState) => {
    focused(shared).selection = next.selection;
    hover = next.hover;
  };
  const [scenarios, models, members] = $derived(([0, 1, 2] as const).map((c) => tree.items(st, c)));
  const path = $derived(tree.path(st));
  // Models per sub-column: 9 ("all" and the 8 default mock models fit one), more for many models so about 4
  // sub-columns hold 50; beyond the room left by the members, the models column scrolls sideways.
  const rows = $derived(Math.min(14, Math.max(9, Math.ceil(models.length / 4))));

  // A member's id while the pointer is on its cell (cells are too small for labels).
  let pointed = $state<string>();
  const memberTitle = (m: Item) => `${m.id}${m.maps ? '' : ' (no maps: shows the ensemble)'}`;

  // The links (tree.links), as curves between the items' boxes, measured after every change and resize.
  let columnsEl = $state<HTMLDivElement>();
  let paneEl = $state<HTMLElement>();
  let curves = $state<{ d: string; fixed: boolean; width: number }[]>([]);
  const measure = () => {
    if (!columnsEl) return;
    const origin = columnsEl.getBoundingClientRect();
    const find = (column: number | string, id: string) => columnsEl!.querySelector(`[data-column="${column}"][data-id="${CSS.escape(id)}"]`);
    const modelBoxes = [...columnsEl.querySelectorAll('[data-column="1"]')].map((e) => e.getBoundingClientRect());
    const band = (modelsEl?.querySelector('ul')?.getBoundingClientRect().top ?? origin.top) - 3 - origin.top;
    // The dataset to the scenario the columns show (hovered or picked), then the tree's links.
    const scenario = st.hover.scenario ?? st.selection.scenario;
    const pairs = [
      { from: find('dataset', 'dataset'), to: find(0, scenario), fixed: scenario === st.selection.scenario, weight: 1 },
      ...tree.links(st).map((l) => ({ from: find(l.level, l.from), to: find(l.level + 1, l.to), fixed: l.fixed, weight: l.weight })),
    ];
    curves = pairs.flatMap((link) => {
      const [a, b] = [link.from, link.to].map((e) => e?.getBoundingClientRect());
      if (!a || !b || !a.width || !b.width) return [];
      const [x1, y1, x2, y2] = [a.right + 4 - origin.left, a.top + a.height / 2 - origin.top, b.left - 4 - origin.left, b.top + b.height / 2 - origin.top];
      // A link that would cross other models' names (several sub-columns) runs along the band above the first row
      // instead, rising in the gap after its source and dropping in the gap before its target.
      const crosses = modelBoxes.some((m) => m.left > a.right + 1 && m.right < b.left - 1);
      const mid = (x1 + x2) / 2;
      const d = crosses
        ? `M${x1},${y1}C${x1 + 8},${y1} ${x1 + 4},${band} ${x1 + 12},${band}L${x2 - 12},${band}C${x2 - 4},${band} ${x2 - 8},${y2} ${x2},${y2}`
        : `M${x1},${y1}C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
      // A bundle (all models, a whole ensemble) is drawn thicker, by how many runs it stands for.
      return [{ d, fixed: link.fixed, width: Math.min(6, 1.25 + Math.log2(link.weight)) }];
    });
  };
  $effect(() => {
    void st;
    if (open) tick().then(measure);
  });
  // On opening, the picked model is scrolled into view (the models column may scroll sideways).
  let modelsEl = $state<HTMLElement>();
  $effect(() => {
    modelsEl?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  $effect(() => {
    if (!columnsEl || !paneEl) return;
    const pane = paneEl;
    const observer = new ResizeObserver(() => {
      measure();
      bottom = pane.offsetTop + pane.offsetHeight;
    });
    observer.observe(columnsEl);
    observer.observe(pane);
    return () => {
      observer.disconnect();
      bottom = 0;
    };
  });

  // Arrow keys move through a column's items (Tab moves between columns); Escape closes the pane.
  const keydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      open = false;
      return;
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    const button = (e.target as HTMLElement).closest('button');
    const column = button?.closest('.column');
    if (!step || !button || !column) return;
    const buttons = [...column.querySelectorAll('button')];
    buttons[buttons.indexOf(button) + step]?.focus();
    e.preventDefault();
  };
</script>

<div class="panel chip" bind:this={chipEl} data-no-shot>
  <button class="toggle" aria-expanded={open} aria-controls="data-tree" onclick={() => (open = !open)}>
    <span class="path">{#each path as part, i}{#if i}<span class="sep">›</span>{/if}<span>{part}</span>{/each}</span>
    <span aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>
  <button
    class="add"
    aria-label="Add a globe (a copy of this one)"
    title={canAdd ? 'Add a globe: a copy of this one, which the tree then changes' : 'No room for more globes'}
    disabled={!canAdd}
    onclick={onAdd}>+</button
  >
</div>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions: arrow keys move between its buttons, Escape closes -->
  <section data-no-shot id="data-tree" class="panel tree" aria-label="Data: dataset, scenarios, models and members" bind:this={paneEl} onkeydown={keydown}>
    <button class="close" aria-label="Close the data tree" onclick={() => (open = false)}>▴</button>
    <!-- svelte-ignore a11y_no_static_element_interactions: the pointer leaving the columns drops the preview -->
    <div class="columns" bind:this={columnsEl} onmouseleave={() => set(tree.leave(st))}>
      <svg class="links" aria-hidden="true">
        {#each curves as c}<path d={c.d} class:fixed={c.fixed} stroke-width={c.width} />{/each}
      </svg>

      <section class="column dataset">
        <h2>Dataset</h2>
        <ul>
          <li>
            <div class="item on fixed" data-column="dataset" data-id="dataset">
              {datasetLabel(catalog)}<small>{catalog.scenarios.length} scenarios</small>
            </div>
          </li>
        </ul>
      </section>

      <section class="column scenarios">
        <h2>Scenario</h2>
        <ul>
          {#each scenarios as s (s.id)}
            <li>
              <button
                data-column="0"
                data-id={s.id}
                class:on={s.on}
                class:fixed={s.fixed}
                aria-pressed={s.fixed}
                onmouseenter={() => set(tree.hover(st, 0, s.id))}
                onfocus={() => set(tree.hover(st, 0, s.id))}
                onclick={() => set(tree.pick(st, 0, s.id))}
              >
                {s.label}<small>{s.count} models</small>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      <section class="column models" bind:this={modelsEl} onscroll={measure}>
        <h2>Model <small>· members</small></h2>
        <ul style:--rows={Math.min(rows, models.length)}>
          {#each models as m (m.id)}
            <li>
              <button
                data-column="1"
                data-id={m.id}
                class:on={m.on}
                class:fixed={m.fixed}
                class:all={m.id === ALL}
                aria-pressed={m.fixed}
                onmouseenter={() => set(tree.hover(st, 1, m.id))}
                onfocus={() => set(tree.hover(st, 1, m.id))}
                onclick={() => set(tree.pick(st, 1, m.id))}
              >
                {m.label}<small>{m.count}</small>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      {#if members.length}
        {@const [ensemble, ...cells] = members}
        <section class="column members">
          <h2>Members <small>· {pointed ?? 'solid: with maps, hollow: line only'}</small></h2>
          <button
            data-column="2"
            data-id={ALL}
            class="ensemble"
            class:on={ensemble.on}
            class:fixed={ensemble.fixed}
            aria-pressed={ensemble.fixed}
            onclick={() => set(tree.pick(st, 2, ALL))}
          >
            Ensemble mean<small>{ensemble.count} members</small>
          </button>
          <div class="cells" role="group" aria-label="Members">
            {#each cells as c (c.id)}
              <button
                data-column="2"
                data-id={c.id}
                class="cell"
                class:on={c.on}
                class:fixed={c.fixed}
                class:hollow={!c.maps}
                aria-pressed={c.fixed}
                aria-label={memberTitle(c)}
                title={memberTitle(c)}
                onmouseenter={() => (pointed = memberTitle(c))}
                onmouseleave={() => (pointed = undefined)}
                onfocus={() => (pointed = memberTitle(c))}
                onblur={() => (pointed = undefined)}
                onclick={() => set(tree.pick(st, 2, c.id))}
              ></button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </section>
{/if}

<style>
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    border-radius: 6px;
  }
  .chip {
    grid-area: chip;
    justify-self: center;
    align-self: start;
    max-width: 100%;
    min-width: 0;
    padding: 4px;
    display: flex;
    align-items: center;
  }
  .add {
    flex: none;
    width: 28px;
    height: 28px;
    margin-left: 2px;
    border-left: 1px solid var(--border);
    border-radius: 0 6px 6px 0;
    font-size: 18px;
    line-height: 1;
  }
  .add:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  .add:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toggle {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    padding: 4px 8px;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    margin: 0 6px;
    color: var(--muted);
  }
  .tree {
    grid-area: tree;
    position: relative;
    max-height: 45vh;
    overflow: auto;
    padding: 10px 14px 12px;
  }
  .close {
    position: absolute;
    top: 6px;
    right: 8px;
    padding: 2px 8px;
    color: var(--muted);
  }
  .columns {
    position: relative;
    display: flex;
    gap: 56px; /* room for the links */
    align-items: flex-start;
  }
  .links {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .links path {
    fill: none;
    stroke: var(--muted);
    stroke-opacity: 0.5;
    stroke-linecap: round;
  }
  .links path.fixed {
    stroke: var(--fg);
    stroke-opacity: 0.85;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  h2 small {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .models {
    flex: 0 1 auto;
    min-width: 160px;
    overflow-x: auto;
  }
  .models ul {
    /* Sub-columns of `rows` models, filled top to bottom (D5). */
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(var(--rows), auto);
    column-gap: 16px;
  }
  li button,
  li .item,
  .ensemble {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 2px 8px;
    text-align: left;
    white-space: nowrap;
    color: var(--muted);
  }
  small {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .on,
  li .item.on {
    color: var(--fg);
  }
  .fixed {
    font-weight: 600;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  li button:hover,
  .ensemble:hover {
    background: color-mix(in srgb, var(--fg) 8%, transparent);
  }
  .all {
    font-style: italic;
  }
  .members {
    flex: 1 0 260px;
    max-width: 440px;
  }
  .ensemble {
    width: auto;
    margin-bottom: 6px;
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(auto-fill, 14px);
    gap: 4px;
  }
  .cell {
    width: 14px;
    height: 14px;
    padding: 0;
    border-radius: 3px;
    border: 1.5px solid var(--fg);
    background: var(--fg);
    opacity: 0.3;
  }
  .cell.on {
    opacity: 0.85;
  }
  .cell.hollow {
    background: transparent;
  }
  .cell.fixed {
    opacity: 1;
    border-color: var(--accent);
    background: var(--accent);
    outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .cell.fixed.hollow {
    background: transparent;
  }
  .cell:hover {
    opacity: 1;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Phones: the open pane covers the page, columns stacked, without links. */
  @media (max-width: 720px) {
    .tree {
      position: fixed;
      inset: 0;
      z-index: 2;
      max-height: none;
      border-radius: 0;
    }
    .columns {
      flex-direction: column;
      gap: 16px;
    }
    .links {
      display: none;
    }
    .members {
      max-width: none;
    }
  }
</style>
