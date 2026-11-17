<script lang="ts">
  import type { Dataset } from '../data/cmip6';

  // Left pane: the app title, the dataset, and its metrics grouped by variable; picking one shows it on the
  // globe and timeline. Collapses to a title chip.
  let {
    dataset,
    selected,
    year,
    open = $bindable(),
    width = $bindable(0),
    onSelect,
  }: {
    dataset: Dataset;
    selected: string;
    year: number;
    open: boolean;
    width?: number; // rendered width while open, so the globe can centre right of it
    onSelect: (id: string) => void;
  } = $props();

  const groups = $derived([...new Set(dataset.metrics.map((m) => m.group))].map((g) => [g, dataset.metrics.filter((m) => m.group === g)] as const));
  const current = $derived(dataset.metrics.find((m) => m.id === selected));
</script>

{#if open}
  <nav class="panel pane" aria-label="Metrics" bind:clientWidth={width}>
    <header>
      <h1>Hydroviewer</h1>
      <button class="fold" aria-label="Hide metrics" aria-expanded="true" onclick={() => (open = false)}>«</button>
    </header>
    <p class="dataset">
      <strong>{dataset.name}</strong>
      <span>{dataset.detail}</span>
    </p>
    {#each groups as [group, metrics] (group)}
      <h2>{group}</h2>
      <ul>
        {#each metrics as m (m.id)}
          <li>
            <button aria-current={m.id === selected} onclick={() => onSelect(m.id)}>
              {m.name}
              <small>{m.units}</small>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </nav>
{:else}
  <div class="panel chip">
    <button class="fold" aria-label="Show metrics" aria-expanded="false" onclick={() => (open = true)}>☰</button>
    <div>
      <h1>Hydroviewer</h1>
      <p>{current?.name} · {year}</p>
    </div>
  </div>
{/if}

<style>
  .pane {
    grid-area: pane;
    align-self: stretch;
    width: 240px;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 12px;
  }
  .chip {
    grid-area: pane;
    align-self: start;
    justify-self: start;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px 6px 6px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    margin: 0;
    font-size: 1.125rem;
  }
  .chip p {
    margin: 0;
    color: var(--muted);
  }
  .dataset {
    margin: 6px 0 12px;
  }
  .dataset span {
    display: block;
    color: var(--muted);
    font-size: 12px;
  }
  h2 {
    margin: 12px 0 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    border-radius: 6px;
  }
  li button {
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  li button small {
    color: var(--muted);
  }
  li button:hover {
    background: color-mix(in srgb, var(--fg) 8%, transparent);
  }
  li button[aria-current='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }
  li button[aria-current='true'] small {
    color: inherit;
    opacity: 0.8;
  }
  .fold {
    padding: 2px 8px;
    font-size: 16px;
  }
  .fold:hover {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }

  /* Phones: the open pane covers the page instead of squeezing the globe. */
  @media (max-width: 720px) {
    .pane {
      position: fixed;
      inset: 12px;
      width: auto;
      z-index: 3;
    }
  }
</style>
