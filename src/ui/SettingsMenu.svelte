<script lang="ts">
  // Gear button with a drop-down of actions. Closes on choosing, Escape or a click elsewhere.
  import type { Snippet } from 'svelte';

  let {
    children,
    onDownloadPng,
    onImport,
    imported,
    onRemove,
    onAbout,
  }: {
    children?: Snippet; // extra settings shown at the top of the menu
    onDownloadPng: () => void;
    onImport: (file: File) => void;
    imported: { id: string; name: string }[];
    onRemove: (id: string) => void;
    onAbout: () => void;
  } = $props();
  let open = $state(false);
  let root: HTMLDivElement;
  let picker: HTMLInputElement;

  const choose = (action: () => void) => {
    open = false;
    action();
  };
</script>

<svelte:window
  onpointerdown={(e) => open && !root.contains(e.target as Node) && (open = false)}
  onkeydown={(e) => open && e.key === 'Escape' && (open = false)}
/>

<div class="settings" bind:this={root}>
  <button class="gear" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
      />
    </svg>
  </button>
  {#if open}
    <div class="menu" role="menu">
      {#if children}<div class="settings-group">{@render children()}</div>{/if}
      <button role="menuitem" onclick={() => choose(onDownloadPng)}>
        Download PNG
        <small>Unfolded globe, equirectangular, one pixel per grid cell</small>
      </button>
      <button role="menuitem" onclick={() => choose(() => picker.click())}>
        Import colormap…
        <small>SciVisColor ColorMoves JSON export (or drop the file on the page)</small>
      </button>
      <button role="menuitem" onclick={() => choose(onAbout)}>
        About Hydroviewer
        <small>Contact, version, data credits</small>
      </button>
      {#if imported.length}
        <div class="group" role="group" aria-label="Imported colormaps">
          <small>Imported colormaps (this browser only)</small>
          {#each imported as c (c.id)}
            <div class="row">
              <span>{c.name}</span>
              <button class="remove" aria-label="Remove {c.name}" onclick={() => onRemove(c.id)}>✕</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <input
    type="file"
    accept=".json,application/json"
    hidden
    bind:this={picker}
    onchange={() => {
      const file = picker.files?.[0];
      if (file) onImport(file);
      picker.value = ''; // so the same file can be picked again
    }}
  />
</div>

<style>
  .settings {
    position: relative;
    display: flex;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .gear {
    display: flex;
    padding: 4px;
    border-radius: 6px;
  }
  .gear:hover,
  .gear[aria-expanded='true'] {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  .menu {
    position: absolute;
    top: calc(100% + 10px);
    right: -8px;
    width: 280px;
    padding: 4px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.15);
  }
  .menu button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 6px;
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  small {
    display: block;
    color: var(--muted);
    font-size: 12px;
  }
  .settings-group {
    padding: 4px 8px 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .group {
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding: 6px 8px 2px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu .remove {
    width: auto;
    padding: 2px 6px;
    color: var(--muted);
  }
</style>
