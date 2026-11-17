<script lang="ts">
  import { MOCK, YEARS, mockField, mockSeries } from './data/mock';
  import { colormaps, shared } from './state/shared.svelte';
  import SettingsMenu from './ui/SettingsMenu.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { download, fieldPng } from './viewports/exportPng';
  import { gradient } from './viewports/colormaps';
  import { stageGlobe } from './viewports/stageGlobe';
  import { timeline } from './viewports/timeline';

  // Layout mockup: one full-screen globe with floating panels, and a timeline of the global mean whose
  // needle sets the year. Data is mock (src/data/mock.ts).
  const globe = stageGlobe(mockField);
  const time = timeline(mockSeries, YEARS, (year) => (shared.year = year));
  const downloadPng = async () =>
    download(await fieldPng(await mockField(shared.year), shared.colormap), `hydroviewer-pr-${shared.year}-${shared.colormap}.png`);
  const step = (by: number) => (shared.year = Math.min(YEARS[1], Math.max(YEARS[0], shared.year + by)));
</script>

<main>
  <div class="stage"><ViewportHost viewport={globe} /></div>

  <div class="hud">
    <section class="panel title">
      <h1>Hydroviewer</h1>
      <p>Precipitation · {shared.year} <span class="tag">mock data</span></p>
    </section>

    <section class="panel tools">
      <label>
        Colormap
        <select bind:value={shared.colormap}>
          {#each colormaps as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
      <SettingsMenu onDownloadPng={downloadPng} />
    </section>

    <section class="panel legend" aria-label="Colour scale">
      <div>{MOCK.units}</div>
      <div class="bar" style:background={gradient(shared.colormap)}></div>
      <div class="ticks"><span>{MOCK.range[0]}</span><span>{MOCK.range[1]}</span></div>
    </section>

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
    grid-template: 'title tools' auto '. .' 1fr 'legend .' auto 'time time' auto / 1fr auto;
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
  }
  .legend {
    grid-area: legend;
    justify-self: start;
    align-self: end;
    font-size: 12px;
  }
  .bar {
    width: 160px;
    height: 10px;
    margin: 2px 0;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
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
