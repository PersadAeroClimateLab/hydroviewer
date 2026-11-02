<script lang="ts">
  import { layouts, ui } from '../state/layout.svelte';
  import { colormaps, shared } from '../state/shared.svelte';
</script>

<aside>
  <section>
    <h2>Layout</h2>
    <div class="segments">
      {#each layouts as layout}
        <button
          data-layout={layout.id}
          aria-pressed={ui.layoutId === layout.id}
          onclick={() => (ui.layoutId = layout.id)}
        >
          {layout.label}
        </button>
      {/each}
    </div>
  </section>

  <section>
    <h2><label for="colormap">Colormap</label></h2>
    <select id="colormap" bind:value={shared.colormap}>
      {#each colormaps as name}
        <option value={name}>{name}</option>
      {/each}
    </select>
  </section>
</aside>

<style>
  aside {
    flex: none;
    width: 15rem;
    padding: 1rem;
    box-sizing: border-box;
    background: var(--panel);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  section + section {
    margin-top: 1.25rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .segments {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
  }
  button,
  select {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.375rem 0.5rem;
  }
  button {
    cursor: pointer;
  }
  button[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  select {
    width: 100%;
  }
  @media (max-width: 720px) {
    aside {
      width: auto;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
