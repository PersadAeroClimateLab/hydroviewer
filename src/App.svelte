<script lang="ts">
  import { ui } from './state/layout.svelte';
  import Sidebar from './ui/Sidebar.svelte';
  import ViewportGrid from './ui/ViewportGrid.svelte';
</script>

<header>
  <button
    class="toggle"
    aria-label="Toggle controls"
    aria-expanded={ui.sidebarOpen}
    onclick={() => (ui.sidebarOpen = !ui.sidebarOpen)}
  >
    ☰
  </button>
  <h1>Hydroviewer</h1>
</header>

<div class="body">
  {#if ui.sidebarOpen}
    <Sidebar />
  {/if}
  <ViewportGrid />
</div>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    margin: 0;
    font-size: 1.125rem;
  }
  .toggle {
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.125rem 0.5rem;
    cursor: pointer;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  @media (max-width: 720px) {
    .body {
      flex-direction: column;
      overflow-y: auto;
    }
  }
</style>
