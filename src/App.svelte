<script lang="ts">
  import { MOCK, MONTHS, mockField, mockSeries } from './data/mock';
  import { colormaps, shared } from './state/shared.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { seriesChart } from './viewports/chart';
  import { gradient } from './viewports/overlay';
  import { stageGlobe } from './viewports/stageGlobe';

  // Layout mockup: one full-screen globe with floating panels. Data is mock (src/data/mock.ts) and the
  // chart is not linked to the globe yet.
  const globe = stageGlobe(mockField);
  const chart = seriesChart('Global mean', 'fit', async () => mockSeries());
  let chartOpen = $state(!matchMedia('(max-width: 720px)').matches);
</script>

<main>
  <div class="stage"><ViewportHost viewport={globe} /></div>

  <div class="hud">
    <section class="panel title">
      <h1>Hydroviewer</h1>
      <p>Precipitation · {MONTHS[shared.month]} <span class="tag">mock data</span></p>
    </section>

    <section class="panel tools">
      <label>
        Colormap
        <select bind:value={shared.colormap}>
          {#each colormaps as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
    </section>

    <section class="panel legend" aria-label="Colour scale">
      <div>{MOCK.units}</div>
      <div class="bar" style:background={gradient(shared.colormap)}></div>
      <div class="ticks"><span>{MOCK.range[0]}</span><span>{MOCK.range[1]}</span></div>
    </section>

    <section class="panel time">
      <label>
        <span>{MONTHS[shared.month]}</span>
        <input type="range" min="0" max="11" step="1" bind:value={shared.month} aria-label="Month" />
      </label>
    </section>

    <section class="panel chart" class:open={chartOpen}>
      <button class="head" aria-expanded={chartOpen} onclick={() => (chartOpen = !chartOpen)}>
        Global mean <span aria-hidden="true">{chartOpen ? '▾' : '▸'}</span>
      </button>
      {#if chartOpen}
        <div class="plot"><ViewportHost viewport={chart} /></div>
      {/if}
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
    grid-template: 'title . tools' auto '. . .' 1fr 'legend time chart' auto / 1fr auto 1fr;
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
    align-self: end;
  }
  .time label {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .time span {
    width: 2.5em;
  }
  .time input {
    width: min(360px, 60vw);
  }
  .chart {
    grid-area: chart;
    justify-self: end;
    align-self: end;
    padding: 0;
  }
  .head {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 8px 12px;
    cursor: pointer;
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .plot {
    position: relative;
    width: 340px;
    height: 200px;
  }

  @media (max-width: 720px) {
    .hud {
      padding: 12px;
      grid-template: 'title tools' auto '. .' 1fr 'legend legend' auto 'chart chart' auto 'time time' auto / 1fr auto;
    }
    .time input {
      flex: 1;
      width: auto;
    }
    .plot {
      width: calc(100vw - 24px);
      height: 180px;
    }
    .chart.open {
      justify-self: stretch;
    }
  }
</style>
