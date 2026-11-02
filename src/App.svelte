<script lang="ts">
  import { shared, type Colormap } from './state/shared.svelte';
  import ViewportHost from './ui/ViewportHost.svelte';
  import { placeholder } from './viewports/placeholder';

  const colormaps: Colormap[] = ['viridis', 'magma'];
</script>

<header>
  <h1>Hydroviewer</h1>
  <label>
    Colormap
    <select bind:value={shared.colormap}>
      {#each colormaps as name}
        <option value={name}>{name}</option>
      {/each}
    </select>
  </label>
</header>

<main>
  <ViewportHost viewport={placeholder} />
</main>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    margin: 0;
    font-size: 1.125rem;
  }
  main {
    flex: 1;
    min-height: 0;
  }
</style>
