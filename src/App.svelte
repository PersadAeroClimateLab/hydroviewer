<script lang="ts">
  import { nodeKey, openNode, type Catalog } from './data/catalog';
  import type { Dataset } from './data/cmip6';
  import { createTree } from './data/tree';
  import { colormaps, findColormap, importColormaps, removeColormap } from './state/colormaps.svelte';
  import { ELEVATION_MULTIPLIER, ELEVATION_SCALE, STIPPLE_SIZE, shared } from './state/shared.svelte';
  import { draggable, type Offset } from './ui/draggable';
  import DataTree from './ui/DataTree.svelte';
  import MetricPane from './ui/MetricPane.svelte';
  import SettingsMenu from './ui/SettingsMenu.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { download, fieldPng } from './viewports/exportPng';
  import { bakeLut, LUT_SIZE } from './viewports/colormaps';
  import { stageGlobe } from './viewports/stageGlobe';
  import { timeline } from './viewports/timeline';

  // One full-screen globe with floating panels: a pane of the dataset's metrics on the left, the data tree at the
  // top, and a timeline of the selected metric's global mean whose needle sets the year. The catalog and the first
  // node's dataset are loaded before mounting (main.ts); the years are the first node's (every mock node has the
  // same).
  const { catalog, dataset: first, years }: { catalog: Catalog; dataset: Dataset; years: [number, number] } = $props();

  // The shown dataset follows the data tree's selection once the node has loaded (shared.node then changes and
  // the views reload); a newer pick wins over a slow load. Not deep state: it holds loaders and typed arrays.
  // svelte-ignore state_referenced_locally
  let dataset = $state.raw(first);
  // svelte-ignore state_referenced_locally
  const tree = createTree(catalog);
  let opening = '';
  $effect(() => {
    const node = tree.node({ selection: shared.selection, hover: {} });
    const key = (opening = nodeKey(node));
    if (key === shared.node) return;
    openNode(catalog, node).then(
      (opened) => {
        if (opening !== key) return;
        dataset = opened.dataset;
        shared.node = key;
      },
      (e) => say(`Could not open ${key}: ${e instanceof Error ? e.message : e}`, true),
    );
  });

  const globe = stageGlobe(() => dataset.metrics); // colour: the metric; elevation and stippling: its statistics
  const metric = $derived(dataset.metrics.find((m) => m.id === shared.metric) ?? dataset.metrics[0]);
  const statistic = (id: string) => metric.statistics.find((s) => s.id === id);
  const elevation = $derived(statistic(shared.elevation));
  const stipple = $derived(statistic(shared.stipple));
  // The stipple threshold: moved with the slider (per metric and statistic) or the statistic's default.
  const thresholdKey = $derived(`${metric.id}/${shared.stipple}`);
  const threshold = $derived(stipple ? (shared.thresholds[thresholdKey] ?? stipple.threshold) : 0);
  const swap = () => ([shared.elevation, shared.stipple] = [shared.stipple, shared.elevation]);
  const fmt = (v: number, units: string) =>
    units.startsWith('fraction') ? `${Math.round(v * 100)}%` : `${Number(v.toPrecision(3))} ${units}`;
  // svelte-ignore state_referenced_locally
  const time = timeline(
    (id) => (dataset.metrics.find((m) => m.id === id) ?? dataset.metrics[0]).series(),
    years,
    (year) => (shared.year = year),
  );
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const downloadPng = async () =>
    download(
      await fieldPng(await metric.load(shared.year), shared.colormap),
      `hydroviewer-${metric.id}-${shared.year}-${slug(shared.colormap.name)}.png`,
    );

  // The metric pane: open on wide screens, where the globe centres right of it; on phones it starts closed and
  // covers the page when opened, so it takes no room from the globe.
  const narrow = matchMedia('(max-width: 720px)');
  let wide = $state(!narrow.matches);
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
  $effect(() => {
    shared.insetTop = treeOpen && wide ? treeBottom : 0;
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
  const remove = (id: string) => {
    removeColormap(id);
    if (shared.colormap.id === id) shared.colormap = colormaps.builtIn[0];
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

  let bar: HTMLCanvasElement;
  $effect(() => {
    const lut = bakeLut(shared.colormap);
    bar.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(lut), LUT_SIZE, 1), 0, 0);
  });
  const step = (by: number) => (shared.year = Math.min(years[1], Math.max(years[0], shared.year + by)));
</script>

<main
  ondragover={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
  ondrop={(e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    importFile(file);
  }}
>
  <div class="stage"><ViewportHost viewport={globe} /></div>

  <div class="hud" class:pane-open={paneOpen && wide} class:tree-open={treeOpen}>
    <MetricPane
      dataset={dataset}
      selected={metric.id}
      year={shared.year}
      bind:open={paneOpen}
      bind:width={paneWidth}
      onSelect={(id) => {
        shared.metric = id;
        if (!wide) paneOpen = false; // on phones the pane covers the globe
      }}
    />

    <DataTree {catalog} bind:open={treeOpen} bind:bottom={treeBottom} />

    <section class="panel tools">
      <label>
        Colormap
        <select value={shared.colormap.id} onchange={(e) => (shared.colormap = findColormap(e.currentTarget.value)!)}>
          {#each colormaps.builtIn as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          {#if colormaps.imported.length}
            <optgroup label="Imported">
              {#each colormaps.imported as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
            </optgroup>
          {/if}
        </select>
      </label>
      <SettingsMenu onDownloadPng={downloadPng} onImport={importFile} imported={colormaps.imported} onRemove={remove}>
        <label class="setting">
          Elevation
          <select bind:value={shared.elevation}>
            <option value="">Off</option>
            {#each metric.statistics as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
        </label>
        <label class="setting">
          <span>Height <small>{Math.round(shared.elevationScale * shared.elevationMultiplier * 100)}% of radius</small></span>
          <input
            type="range"
            min={ELEVATION_SCALE.min}
            max={ELEVATION_SCALE.max}
            step="0.01"
            disabled={!shared.elevation}
            bind:value={shared.elevationScale}
          />
        </label>
        <div class="setting">
          <span>Height multiplier</span>
          <span class="stepper">
            <button
              aria-label="Lower the height multiplier"
              disabled={!shared.elevation || shared.elevationMultiplier <= ELEVATION_MULTIPLIER.min}
              onclick={() => shared.elevationMultiplier--}>−</button
            >
            <output>×{shared.elevationMultiplier}</output>
            <button
              aria-label="Raise the height multiplier"
              disabled={!shared.elevation || shared.elevationMultiplier >= ELEVATION_MULTIPLIER.max}
              onclick={() => shared.elevationMultiplier++}>+</button
            >
          </span>
        </div>
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
      ondblclick={resetLegend}
    >
      <div>{metric.name}, {metric.units}</div>
      <canvas class="bar" width={LUT_SIZE} height="1" bind:this={bar}></canvas>
      <div class="ticks"><span>{metric.range[0]}</span><span>{metric.range[1]}</span></div>
      {#if elevation || stipple}
        <button class="swap" aria-label="Swap elevation and stippling" title="Swap elevation and stippling" onclick={swap}>⇅</button>
      {/if}
      {#if elevation}
        <div class="extra">
          Elevation: {elevation.name.toLowerCase()}
          <span>flat = {fmt(elevation.range[0], elevation.units)}, highest = {fmt(elevation.range[1], elevation.units)}</span>
        </div>
      {/if}
      {#if stipple}
        <div class="extra">
          <i class="dots" aria-hidden="true"></i>Stippling: {stipple.name.toLowerCase()}
          <span>dots where ≥ {fmt(threshold, stipple.units)}</span>
        </div>
      {/if}
    </section>

    {#if notice}
      <div class="panel notice" class:error={notice.error} role="status">{notice.text}</div>
    {/if}

    <section class="panel time">
      <button aria-label="Previous year" disabled={shared.year <= years[0]} onclick={() => step(-1)}>◀</button>
      <div class="track"><ViewportHost viewport={time} /></div>
      <button aria-label="Next year" disabled={shared.year >= years[1]} onclick={() => step(1)}>▶</button>
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
  .swap {
    float: right;
    margin: 6px 0 0 8px;
  }
  .stepper button,
  .swap {
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
