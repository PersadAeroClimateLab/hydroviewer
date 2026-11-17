<script lang="ts">
  import { MOCK, STATISTICS, YEARS, mockField, mockSeries } from './data/mock';
  import { colormaps, findColormap, importColormaps, removeColormap } from './state/colormaps.svelte';
  import { ELEVATION_SCALE, STIPPLE_SIZE, shared } from './state/shared.svelte';
  import { draggable, type Offset } from './ui/draggable';
  import SettingsMenu from './ui/SettingsMenu.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { download, fieldPng } from './viewports/exportPng';
  import { bakeLut, LUT_SIZE } from './viewports/colormaps';
  import { stageGlobe } from './viewports/stageGlobe';
  import { timeline } from './viewports/timeline';

  // Layout mockup: one full-screen globe with floating panels, and a timeline of the global mean whose
  // needle sets the year. Data is mock (src/data/mock.ts).
  const globe = stageGlobe(mockField, STATISTICS); // colour: precipitation; elevation and stippling: statistics
  const statistic = (id: string) => STATISTICS.find((s) => s.id === id);
  const elevation = $derived(statistic(shared.elevation));
  const stipple = $derived(statistic(shared.stipple));
  const fmt = (v: number, units: string) => (units.startsWith('fraction') ? `${Math.round(v * 100)}%` : `${v} ${units}`);
  const time = timeline(mockSeries, YEARS, (year) => (shared.year = year));
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const downloadPng = async () =>
    download(
      await fieldPng(await mockField(shared.year), shared.colormap),
      `hydroviewer-pr-${shared.year}-${slug(shared.colormap.name)}.png`,
    );

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
  const step = (by: number) => (shared.year = Math.min(YEARS[1], Math.max(YEARS[0], shared.year + by)));
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

  <div class="hud">
    <section class="panel title">
      <h1>Hydroviewer</h1>
      <p>Precipitation · {shared.year} <span class="tag">mock data</span></p>
    </section>

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
            {#each STATISTICS as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
        </label>
        <label class="setting">
          <span>Height <small>{Math.round(shared.elevationScale * 100)}% of radius</small></span>
          <input
            type="range"
            min={ELEVATION_SCALE.min}
            max={ELEVATION_SCALE.max}
            step="0.01"
            disabled={!shared.elevation}
            bind:value={shared.elevationScale}
          />
        </label>
        <label class="setting">
          Stippling
          <select bind:value={shared.stipple}>
            <option value="">Off</option>
            {#each STATISTICS as s (s.id)}<option value={s.id}>{s.name} ≥ {fmt(s.threshold, s.units)}</option>{/each}
          </select>
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
      <div>{MOCK.units}</div>
      <canvas class="bar" width={LUT_SIZE} height="1" bind:this={bar}></canvas>
      <div class="ticks"><span>{MOCK.range[0]}</span><span>{MOCK.range[1]}</span></div>
      {#if elevation}
        <div class="extra">
          Elevation: {elevation.name.toLowerCase()}
          <span>flat = {fmt(elevation.range[0], elevation.units)}, highest = {fmt(elevation.range[1], elevation.units)}</span>
        </div>
      {/if}
      {#if stipple}
        <div class="extra">
          <i class="dots" aria-hidden="true"></i>Stippling: {stipple.name.toLowerCase()}
          <span>dots where ≥ {fmt(stipple.threshold, stipple.units)}</span>
        </div>
      {/if}
    </section>

    {#if notice}
      <div class="panel notice" class:error={notice.error} role="status">{notice.text}</div>
    {/if}

    <section class="panel time">
      <button aria-label="Previous year" disabled={shared.year <= YEARS[0]} onclick={() => step(-1)}>◀</button>
      <div class="track"><ViewportHost viewport={time} /></div>
      <button aria-label="Next year" disabled={shared.year >= YEARS[1]} onclick={() => step(1)}>▶</button>
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
    grid-template: 'title tools' auto 'notice notice' 1fr 'legend .' auto 'time time' auto / 1fr auto;
    pointer-events: none;
  }
  .panel {
    pointer-events: auto;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 14px;
  }
  .title {
    grid-area: title;
    justify-self: start;
  }
  h1 {
    margin: 0;
    font-size: 1.125rem;
  }
  .title p {
    margin: 0;
    color: var(--muted);
  }
  .tag {
    white-space: nowrap;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
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
    .hud {
      padding: 12px;
    }
    .track {
      height: 88px;
    }
  }
</style>
