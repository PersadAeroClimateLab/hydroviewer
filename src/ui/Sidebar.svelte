<script lang="ts">
  import { analyses } from '../state/analyses';
  import { layouts, ui } from '../state/layout.svelte';
  import { colormaps, shared } from '../state/shared.svelte';
  import { connect, trame } from '../state/trame.svelte';

  const messages = {
    off: 'Off: views drawn by trame show a notice.',
    checking: 'Checking…',
    ready: 'Connected: trame views are live.',
    unreachable: 'Not reachable (or blocked by the browser). Start the server, then Connect.',
  } as const;
</script>

<aside>
  <section>
    <h2>Analysis</h2>
    <div class="segments stacked">
      {#each analyses as analysis}
        <button
          data-analysis={analysis.id}
          aria-pressed={ui.analysisId === analysis.id}
          onclick={() => (ui.analysisId = analysis.id)}
        >
          {analysis.label}
        </button>
      {/each}
    </div>
  </section>

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

  <section>
    <h2><label for="trame-url">Trame server</label></h2>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        connect(trame.input);
      }}
    >
      <input id="trame-url" type="text" placeholder="http://localhost:8080" bind:value={trame.input} />
      <button type="submit">Connect</button>
    </form>
    <p class="status" data-status={trame.status} role="status">{messages[trame.status]}</p>
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
  .stacked {
    grid-template-columns: 1fr; /* analysis labels are longer than layout labels */
  }
  button,
  select,
  input {
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
  select,
  input {
    width: 100%;
    box-sizing: border-box;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .status {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .status[data-status='ready'] {
    color: var(--fg);
  }
  @media (max-width: 720px) {
    aside {
      width: auto;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
