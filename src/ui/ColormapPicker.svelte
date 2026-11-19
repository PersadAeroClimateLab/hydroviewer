<script lang="ts">
  // Picks a colormap, with a preview swatch on every entry: the built-in maps, then the imported ones, and an
  // optional first entry for none (e.g. "Same as map"). A native select cannot show images in every browser, so
  // this is a button and a listbox: arrow keys, Home/End, Enter or Space to pick, Escape or a click elsewhere to
  // close. Focus stays on the list; the active entry is announced through aria-activedescendant.
  import { tick } from 'svelte';
  import { colormaps } from '../state/colormaps.svelte';
  import type { Colormap } from '../viewports/colormaps';
  import { swatch } from './swatch';

  let {
    value,
    onchange,
    label,
    none,
    disabled = false,
  }: {
    value: Colormap | null;
    onchange: (c: Colormap | null) => void;
    label: string; // for screen readers, e.g. "Colormap"
    none?: string; // the entry for null, if there is one
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const entries = $derived([
    ...(none ? [{ name: none, map: null }] : []),
    ...colormaps.builtIn.map((map) => ({ name: map.name, map })),
    ...colormaps.imported.map((map) => ({ name: map.name, map })),
  ]);
  const firstImported = $derived(entries.length - colormaps.imported.length);
  const selected = $derived(Math.max(0, entries.findIndex((e) => (e.map?.id ?? '') === (value?.id ?? ''))));

  let open = $state(false);
  let active = $state(0);
  let root: HTMLDivElement;
  let button: HTMLButtonElement;
  let list = $state<HTMLDivElement>();

  const show = async () => {
    open = true;
    active = selected;
    await tick();
    list?.focus();
    list?.querySelector(`#${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
  };
  const close = (refocus: boolean) => {
    open = false;
    if (refocus) button.focus();
  };
  const choose = (i: number) => {
    onchange(entries[i].map);
    close(true);
  };
  const move = (i: number) => {
    active = Math.min(entries.length - 1, Math.max(0, i));
    list?.querySelector(`#${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
  };
  const key = (e: KeyboardEvent) => {
    const to = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: entries.length - 1 }[e.key];
    if (to !== undefined) move(to);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') {
      e.stopPropagation(); // closes this list, not a menu around it
      close(true);
    } else if (e.key === 'Tab') return close(false);
    else return;
    e.preventDefault();
  };
</script>

<svelte:window onpointerdown={(e) => open && !root.contains(e.target as Node) && close(false)} />

<div class="picker" bind:this={root}>
  <button
    bind:this={button}
    class="current"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="{label}: {entries[selected]?.name}"
    onclick={() => (open ? close(false) : show())}
  >
    {#if entries[selected]?.map}
      <span class="swatch" style:background-image="url({swatch(entries[selected].map!)})"></span>
    {:else}
      <span class="swatch none"></span>
    {/if}
    <span class="name">{entries[selected]?.name}</span>
    <span aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div
      class="list"
      role="listbox"
      tabindex="-1"
      aria-label={label}
      aria-activedescendant="{uid}-{active}"
      bind:this={list}
      onkeydown={key}
    >
      {#each entries as entry, i (entry.map?.id ?? '')}
        {#if i === firstImported && colormaps.imported.length}<div class="group" aria-hidden="true">Imported</div>{/if}
        <!-- svelte-ignore a11y_click_events_have_key_events: the list handles the keys (aria-activedescendant) -->
        <div
          id="{uid}-{i}"
          role="option"
          tabindex="-1"
          aria-selected={i === selected}
          class:active={i === active}
          onpointermove={() => (active = i)}
          onclick={() => choose(i)}
        >
          {#if entry.map}
            <span class="swatch" style:background-image="url({swatch(entry.map)})"></span>
          {:else}
            <span class="swatch none"></span>
          {/if}
          <span class="name">{entry.name}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: inline-block;
    margin-left: 6px;
  }
  .current {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 14em;
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 6px;
    cursor: pointer;
  }
  .current:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .swatch {
    flex: none;
    width: 48px;
    height: 10px;
    border-radius: 2px;
    background-size: 100% 100%;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 15%, transparent);
  }
  .swatch.none {
    background: repeating-linear-gradient(135deg, var(--border) 0 3px, transparent 3px 6px);
  }
  .list {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 10;
    min-width: 100%;
    width: max-content;
    max-width: min(280px, calc(100vw - 32px));
    max-height: min(60vh, 320px);
    overflow-y: auto;
    padding: 4px;
    background: color-mix(in srgb, var(--bg) 96%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.15);
  }
  .list:focus {
    outline: none;
  }
  .list:focus-visible {
    outline: 2px solid var(--accent);
  }
  [role='option'] {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  [role='option'].active {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  [role='option'][aria-selected='true'] .name {
    font-weight: 600;
  }
  /* Phones: no room for the name in the top bar (the list and screen readers still have it). */
  @media (max-width: 720px) {
    .current .name {
      display: none;
    }
    .current .swatch {
      width: 28px;
    }
  }
  .group {
    padding: 6px 8px 2px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
</style>
