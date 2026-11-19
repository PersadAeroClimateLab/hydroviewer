<script lang="ts">
  import { nodeKey, openNode, type Catalog } from './data/catalog';
  import type { Dataset } from './data/cmip6';
  import { createTree } from './data/tree';
  import { colormaps, findColormap, importColormaps, removeColormap } from './state/colormaps.svelte';
  import { add, focused, MAX_GLOBES, pick, remove, timed } from './state/globes';
  import { COLUMN_MULTIPLIER, COLUMN_SCALE, STIPPLE_SIZE, shared } from './state/shared.svelte';
  import { draggable, type Offset } from './ui/draggable';
  import DataTree from './ui/DataTree.svelte';
  import MetricPane from './ui/MetricPane.svelte';
  import About from './ui/About.svelte';
  import ColormapPicker from './ui/ColormapPicker.svelte';
  import RangeSlider from './ui/RangeSlider.svelte';
  import SettingsMenu from './ui/SettingsMenu.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { download, fieldPng } from './viewports/exportPng';
  import { bakeLut, LUT_SIZE, type Colormap } from './viewports/colormaps';
  import { FILL, globeStage, type Cell } from './viewports/globeStage';
  import { timeline } from './viewports/timeline';

  // Globes side by side with floating panels (docs/llm/MULTI_GLOBE_PLAN.md): a pane of the focused globe's metrics on
  // the left, the data tree (editing the focused globe) at the top, and a timeline of the selected metric's global
  // mean whose needle sets the year of the selected globes (all of them when none is). The catalog and the focused
  // globe's dataset are loaded before mounting (main.ts); the years are its node's (every mock node has the same).
  const { catalog, dataset: first, years }: { catalog: Catalog; dataset: Dataset; years: [number, number] } = $props();

  // A dataset per node, opened once and shared by the globes on it. Each globe's node follows its pick once that
  // has loaded (its `node` then changes and the views reload); a newer pick wins over a slow load. Not deep state:
  // datasets hold loaders and typed arrays.
  // svelte-ignore state_referenced_locally
  let datasets = $state.raw(new Map([[focused(shared).node, first]]));
  // svelte-ignore state_referenced_locally
  const tree = createTree(catalog);
  const opened = new Map<string, Promise<Dataset>>();
  const opening = new Map<number, string>(); // per globe, the node it waits for
  $effect(() => {
    for (const g of shared.globes) {
      const node = tree.node({ selection: g.selection, hover: {} });
      const key = nodeKey(node);
      if (key === g.node) opening.delete(g.id);
      if (key === g.node || opening.get(g.id) === key) continue;
      opening.set(g.id, key);
      if (!opened.has(key)) opened.set(key, datasets.get(key) ? Promise.resolve(datasets.get(key)!) : openNode(catalog, node).then((o) => o.dataset));
      const id = g.id;
      opened.get(key)!.then(
        (dataset) => {
          if (opening.get(id) !== key) return;
          if (!datasets.has(key)) datasets = new Map(datasets).set(key, dataset);
          const globe = shared.globes.find((x) => x.id === id);
          if (globe) globe.node = key;
        },
        (e) => {
          opened.delete(key);
          say(`Could not open ${key}: ${e instanceof Error ? e.message : e}`, true);
        },
      );
    }
  });
  // The focused globe's dataset (the last one loaded while its new pick loads) feeds the panes and the legend.
  // svelte-ignore state_referenced_locally
  let dataset = $state.raw(first);
  $effect(() => {
    const d = datasets.get(focused(shared).node);
    if (d) dataset = d;
  });
  const focus = $derived(focused(shared));

  // Where each globe's cell is, for its label; reported by the stage as the layout changes.
  let cells = $state<Cell[]>([]);
  const pickGlobe = (id: number, additive: boolean) => Object.assign(shared, pick(shared, id, additive));
  // colour: the metric; stippling and columns: a statistic
  const globe = globeStage((node) => datasets.get(node)?.metrics, pickGlobe, (c) => (cells = c));
  const metric = $derived(dataset.metrics.find((m) => m.id === shared.metric) ?? dataset.metrics[0]);
  const statistic = (id: string) => metric.statistics.find((s) => s.id === id);
  const stipple = $derived(statistic(shared.stipple));
  // The stipple threshold: moved with the slider (per metric and statistic) or the statistic's default.
  const thresholdKey = $derived(`${metric.id}/${shared.stipple}`);
  const threshold = $derived(stipple ? (shared.thresholds[thresholdKey] ?? stipple.threshold) : 0);
  const fmt = (v: number, units: string) =>
    units.startsWith('fraction') ? `${Math.round(v * 100)}%` : `${Number(v.toPrecision(3))} ${units}`;
  // svelte-ignore state_referenced_locally
  const time = timeline(
    // By node, not the focused `dataset`, which follows a moment after the focus's node changes.
    (node, id) => {
      const d = datasets.get(node) ?? dataset;
      return (d.metrics.find((m) => m.id === id) ?? d.metrics[0]).series();
    },
    years,
    (year) => timed(shared).forEach((g) => (g.year = year)),
  );
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const downloadPng = async () =>
    download(
      await fieldPng(await metric.load(focus.year), shared.colormap, shared.ranges[metric.id] ?? metric.range),
      `hydroviewer-${metric.id}-${focus.year}-${slug(shared.colormap.name)}.png`,
    );

  // The metric pane: open on wide screens, where the globe centres right of it; on phones it starts closed and
  // covers the page when opened, so it takes no room from the globe.
  const narrow = matchMedia('(max-width: 720px)');
  let wide = $state(!narrow.matches);
  const max = $derived(wide ? MAX_GLOBES.wide : MAX_GLOBES.narrow);
  const addGlobe = () => Object.assign(shared, add(shared, max));
  const removeGlobe = (id: number) => Object.assign(shared, remove(shared, id));
  narrow.addEventListener('change', () => (wide = !narrow.matches));
  let paneOpen = $state(!narrow.matches);
  let paneWidth = $state(0);
  const HUD_PADDING = 16;
  $effect(() => {
    shared.insetLeft = paneOpen && wide ? paneWidth + HUD_PADDING : 0;
  });

  // The data tree: closed, a chip reading out the selection; open, a pane under the top row, and the globe centres
  // below it (on phones it covers the page instead).
  let treeOpen = $state(false);
  let treeBottom = $state(0);
  let chipBottom = $state(0);
  $effect(() => {
    shared.insetTop = (treeOpen && wide ? treeBottom : chipBottom) + 8;
  });
  // The timeline: no row of globes sits behind it.
  let timeHeight = $state(0);
  $effect(() => {
    shared.insetBottom = timeHeight + HUD_PADDING + 8;
  });

  // A short message over the globe: import results and errors.
  let notice = $state<{ text: string; error?: boolean }>();
  let noticeTimer = 0;
  const say = (text: string, error = false) => {
    notice = { text, error };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = undefined), error ? 8000 : 5000);
  };

  // Reads a ColorMoves export (from the menu or dropped on the page) and switches to its first map.
  const importFile = async (file: File) => {
    try {
      const { maps, warnings } = importColormaps(await file.text());
      shared.colormap = findColormap(maps[0].id)!;
      say([`Imported ${maps.map((m) => m.name).join(', ')}.`, ...warnings].join(' '));
    } catch (e) {
      say(`Could not import ${file.name}: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  const removeMap = (id: string) => {
    removeColormap(id);
    if (shared.colormap.id === id) shared.colormap = colormaps.builtIn[0];
    if (shared.columnColormap?.id === id) shared.columnColormap = null;
  };

  // The legend can be dragged anywhere over the globe; where it was left is kept in this browser.
  const LEGEND_KEY = 'hydroviewer.legend';
  let legendAt = $state<Offset>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(LEGEND_KEY) ?? '') as Offset;
      } catch {
        return { x: 0, y: 0 };
      }
    })(),
  );
  $effect(() => {
    try {
      localStorage.setItem(LEGEND_KEY, JSON.stringify(legendAt));
    } catch {
      // Storage unavailable: the position lasts for this visit.
    }
  });
  const resetLegend = () => (legendAt = { x: 0, y: 0 });

  const paint = (canvas: HTMLCanvasElement, c: Colormap) =>
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bakeLut(c)), LUT_SIZE, 1), 0, 0);
  let bar: HTMLCanvasElement;
  $effect(() => paint(bar, shared.colormap));
  // The columns' own colour bar, shown while columns are drawn with a map other than the surface's.
  const columnColours = $derived(
    stipple && shared.columnScale > 0 && shared.columnColormap && shared.columnColormap.id !== shared.colormap.id
      ? shared.columnColormap
      : undefined,
  );
  let columnBar = $state<HTMLCanvasElement>();
  $effect(() => {
    if (columnBar && columnColours) paint(columnBar, columnColours);
  });
  let about: ReturnType<typeof About>;
  const step = (by: number) => {
    const year = Math.min(years[1], Math.max(years[0], focus.year + by));
    timed(shared).forEach((g) => (g.year = year));
  };
</script>

<!-- A colour bar's range: a double slider within the metric's display range, moved ranges kept by metric. -->
{#snippet scale(moved: Record<string, [number, number]>, label: string)}
  {@const value = moved[metric.id] ?? metric.range}
  <RangeSlider min={metric.range[0]} max={metric.range[1]} {value} {label} onchange={(v) => (moved[metric.id] = v)} />
  <div class="ticks">
    <span>{Number(value[0].toPrecision(3))}</span>
    {#if moved[metric.id]}<button class="reset-range" onclick={() => delete moved[metric.id]}>Reset</button>{/if}
    <span>{Number(value[1].toPrecision(3))}</span>
  </div>
{/snippet}

<main
  ondragover={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
  ondrop={(e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    importFile(file);
  }}
>
  <div class="stage">
    <!-- Behind the (transparent) canvas: the selected globes' cells. Over it: each globe's label, just above the
         globe at the starting zoom (below, the legend would cover the left one); a click on it picks the globe like a
         click on the globe (Shift, Ctrl, Cmd add). -->
    {#each cells as c (c.id)}
      <div
        class="cell"
        class:selected={shared.selected.includes(c.id)}
        style:left="{c.x}px"
        style:top="{c.y}px"
        style:width="{c.width}px"
        style:height="{c.height}px"
      ></div>
    {/each}
    <ViewportHost viewport={globe} />
    {#each cells as c (c.id)}
      {@const g = shared.globes.find((x) => x.id === c.id)}
      {#if g}
        <div
          class="cell-label"
          class:selected={shared.selected.includes(c.id)}
          class:focus={c.id === shared.focus}
          style:left="{c.x + c.width / 2}px"
          style:max-width="{c.width - 8}px"
          style:top="{c.y + c.height / 2 - (FILL * Math.min(c.width, c.height)) / 2 - 12}px"
        >
          <button
            class="name"
            aria-pressed={shared.selected.includes(c.id)}
            title="Click: move only this globe with the timeline (again: all). Shift-click: add or remove it."
            onclick={(e) => pickGlobe(c.id, e.shiftKey || e.ctrlKey || e.metaKey)}
          >
            {tree.path({ selection: g.selection, hover: {} }).join(' › ')} · {g.year}
          </button>
          {#if shared.globes.length > 1}
            <button class="remove" aria-label="Remove this globe" title="Remove this globe" onclick={() => removeGlobe(c.id)}>×</button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="hud" class:pane-open={paneOpen && wide} class:tree-open={treeOpen}>
    <MetricPane
      dataset={dataset}
      selected={metric.id}
      year={focus.year}
      bind:open={paneOpen}
      bind:width={paneWidth}
      onSelect={(id) => {
        shared.metric = id;
        if (!wide) paneOpen = false; // on phones the pane covers the globe
      }}
    />

    <DataTree
      {catalog}
      bind:open={treeOpen}
      bind:bottom={treeBottom}
      bind:chipBottom
      onAdd={addGlobe}
      canAdd={shared.globes.length < max}
    />

    <section class="panel tools">
      <label class="switch">
        <input type="checkbox" role="switch" bind:checked={shared.spin} />
        <span class="switch-text">Spin</span>
      </label>
      <div>
        <span aria-hidden="true">Colormap</span>
        <ColormapPicker label="Colormap" value={shared.colormap} onchange={(c) => (shared.colormap = c!)} />
      </div>
      <SettingsMenu onDownloadPng={downloadPng} onImport={importFile} imported={colormaps.imported} onRemove={removeMap} onAbout={() => about.show()}>
        <label class="setting">
          Stippling
          <select bind:value={shared.stipple}>
            <option value="">Off</option>
            {#each metric.statistics as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
        </label>
        <label class="setting">
          <span>Threshold <small>{stipple ? `≥ ${fmt(threshold, stipple.units)}` : ''}</small></span>
          <input
            type="range"
            min={stipple?.extent[0] ?? 0}
            max={stipple?.extent[1] ?? 1}
            step={stipple ? (stipple.extent[1] - stipple.extent[0]) / 200 : 0.01}
            disabled={!stipple}
            value={threshold}
            oninput={(e) => (shared.thresholds[thresholdKey] = Number(e.currentTarget.value))}
          />
        </label>
        <label class="setting">
          <span>Dot size <small>one per {shared.stippleSize}°</small></span>
          <input
            type="range"
            min={STIPPLE_SIZE.min}
            max={STIPPLE_SIZE.max}
            step="0.5"
            disabled={!shared.stipple}
            bind:value={shared.stippleSize}
          />
        </label>
        <label class="setting">
          <span>Column height <small>{Math.round(shared.columnScale * shared.columnMultiplier * 100)}% of radius</small></span>
          <input
            type="range"
            min={COLUMN_SCALE.min}
            max={COLUMN_SCALE.max}
            step="0.01"
            disabled={!stipple}
            bind:value={shared.columnScale}
          />
        </label>
        <div class="setting">
          <span>Height multiplier</span>
          <span class="stepper">
            <button
              aria-label="Lower the height multiplier"
              disabled={!stipple || shared.columnMultiplier <= COLUMN_MULTIPLIER.min}
              onclick={() => shared.columnMultiplier--}>−</button
            >
            <output>×{shared.columnMultiplier}</output>
            <button
              aria-label="Raise the height multiplier"
              disabled={!stipple || shared.columnMultiplier >= COLUMN_MULTIPLIER.max}
              onclick={() => shared.columnMultiplier++}>+</button
            >
          </span>
        </div>
        <div class="setting">
          <span aria-hidden="true">Column colours</span>
          <ColormapPicker
            label="Column colours"
            none="Same as map"
            value={shared.columnColormap}
            disabled={!stipple}
            onchange={(c) => (shared.columnColormap = c)}
          />
        </div>
        <button class="reset" onclick={resetLegend}>Reset legend position</button>
      </SettingsMenu>
    </section>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex: focusable so arrow keys can move it -->
    <section
      class="panel legend"
      aria-label="Legend (drag or use arrow keys to move, double-click to reset)"
      tabindex="0"
      style:translate="{legendAt.x}px {legendAt.y}px"
      use:draggable={{ at: legendAt, move: (at) => (legendAt = at) }}
      ondblclick={(e) => !(e.target as Element).closest('input, button') && resetLegend()}
    >
      <div>{metric.name}, {metric.units}</div>
      <canvas class="bar" width={LUT_SIZE} height="1" bind:this={bar}></canvas>
      {@render scale(shared.ranges, 'Colour range')}
      {#if stipple}
        <div class="extra">
          <i class="dots" aria-hidden="true"></i>Stippling: {stipple.name.toLowerCase()}
          <span>dots where ≥ {fmt(threshold, stipple.units)}</span>
          {#if shared.columnScale > 0}
            <span>columns: height ∝ value, tallest at ≥ {fmt(stipple.range[1], stipple.units)}</span>
          {/if}
        </div>
      {/if}
      {#if columnColours}
        <div class="extra">Column colours: {metric.name.toLowerCase()}, {metric.units}</div>
        <canvas class="bar" width={LUT_SIZE} height="1" bind:this={columnBar}></canvas>
        {@render scale(shared.columnRanges, 'Column colour range')}
      {/if}
    </section>

    <About mock={catalog.mock ?? false} bind:this={about} />

    {#if notice}
      <div class="panel notice" class:error={notice.error} role="status">{notice.text}</div>
    {/if}

    <section class="panel time" bind:offsetHeight={timeHeight}>
      <button aria-label="Previous year" disabled={focus.year <= years[0]} onclick={() => step(-1)}>◀</button>
      <div class="track"><ViewportHost viewport={time} /></div>
      <button aria-label="Next year" disabled={focus.year >= years[1]} onclick={() => step(1)}>▶</button>
    </section>
  </div>
</main>

<style>
  main {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .stage {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 45%, var(--stage-inner), var(--stage-outer));
  }
  .cell {
    position: absolute;
    border-radius: 16px;
    pointer-events: none;
  }
  .cell.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .cell-label {
    position: absolute;
    translate: -50% -100%;
    display: flex;
    font-size: 12px;
    color: var(--fg);
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .cell-label button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .cell-label .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 10px;
  }
  .cell-label .remove {
    padding: 0 8px 0 2px;
    opacity: 0.7;
  }
  .cell-label .remove:hover {
    opacity: 1;
  }
  .cell-label.focus {
    font-weight: 600;
  }
  .cell-label.selected {
    color: var(--on-accent);
    background: var(--accent);
    border-color: var(--accent);
  }

  /* Panels float over the globe; the empty middle passes pointer events through to it. */
  .hud {
    position: absolute;
    inset: 0;
    padding: 16px;
    display: grid;
    gap: 12px;
    /* The pane's column is as wide as the closed chip or the open pane; with the pane open, the panels below
       sit right of it (the globe is centred there too). */
    grid-template:
      'pane chip tools' auto
      '. notice .' 1fr
      'legend legend .' auto
      'time time time' auto / auto 1fr auto;
    pointer-events: none;
  }
  .hud.pane-open {
    grid-template:
      'pane chip tools' auto
      'pane notice .' 1fr
      'pane legend .' auto
      'pane time time' auto / auto 1fr auto;
  }
  /* The open data tree takes a row under the top one, right of the metric pane. */
  .hud.tree-open {
    grid-template:
      'pane chip tools' auto
      'tree tree tree' auto
      '. notice .' 1fr
      'legend legend .' auto
      'time time time' auto / auto 1fr auto;
  }
  .hud.pane-open.tree-open {
    grid-template:
      'pane chip tools' auto
      'pane tree tree' auto
      'pane notice .' 1fr
      'pane legend .' auto
      'pane time time' auto / auto 1fr auto;
  }
  /* A checkbox drawn as a switch: a track with a knob that slides right when on. */
  .switch {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .switch input {
    appearance: none;
    position: relative;
    width: 30px;
    height: 18px;
    margin: 0;
    border-radius: 9px;
    background: var(--border);
    cursor: pointer;
    transition: background 0.15s;
  }
  .switch input::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--bg);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: translate 0.15s;
  }
  .switch input:checked {
    background: var(--accent);
  }
  .switch input:checked::before {
    translate: 12px 0;
  }
  .switch input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tools {
    grid-area: tools;
    justify-self: end;
    align-self: start;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 12px;
  }
  select {
    font: inherit;
    margin-left: 6px;
    max-width: 14em;
  }
  .notice {
    grid-area: notice;
    justify-self: center;
    align-self: start;
    max-width: min(520px, 100%);
  }
  .notice.error {
    border-color: #d0342c;
  }
  .legend {
    grid-area: legend;
    position: relative;
    z-index: 1; /* above the other panels when dragged over them */
    cursor: grab;
    user-select: none;
    touch-action: none; /* a touch drag moves the legend, not the page */
    justify-self: start;
    align-self: end;
    font-size: 12px;
  }
  .bar {
    display: block;
    width: 160px;
    height: 10px;
    margin: 2px 0;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    width: 160px;
  }
  .extra {
    margin-top: 6px;
    max-width: 220px;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stepper button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .stepper output {
    min-width: 2.2em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .reset-range {
    font: inherit;
    color: var(--muted);
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .stepper button {
    font: inherit;
    color: var(--fg);
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0 6px;
    cursor: pointer;
  }
  .extra span {
    display: block;
    color: var(--muted);
  }
  .dots {
    display: inline-block;
    width: 14px;
    height: 10px;
    margin-right: 6px;
    vertical-align: -1px;
    background: radial-gradient(circle, var(--fg) 1.6px, transparent 2px) 0 0 / 7px 5px;
  }
  .setting select,
  .setting input {
    max-width: 150px;
  }
  .setting small {
    color: var(--muted);
  }
  .reset {
    font: inherit;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 4px 0 0;
    cursor: pointer;
  }
  .setting {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }
  .time {
    grid-area: time;
    justify-self: center;
    width: min(960px, 100%);
    box-sizing: border-box;
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 8px 4px;
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 104px;
  }
  .track :global([role='slider']:focus-visible) {
    outline: 2px solid var(--accent);
    border-radius: 6px;
  }
  .time button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    border-radius: 6px;
    padding: 0 8px;
    cursor: pointer;
  }
  .time button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  .time button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @media (max-width: 720px) {
    /* Phones: the data tree's chip gets its own row; the open tree and metric pane cover the page instead. */
    /* No room for the switch's word beside the colormap: screen readers still read it. */
    .switch-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .hud,
    .hud.tree-open {
      padding: 12px;
      grid-template:
        'pane tools' auto
        'chip chip' auto
        'notice notice' 1fr
        'legend .' auto
        'time time' auto / 1fr auto;
    }
    .track {
      height: 88px;
    }
  }
</style>
