<script lang="ts">
  import { onMount } from 'svelte';
  import { shared } from '../state/shared.svelte';
  import type { Viewport, ViewportHandle } from '../viewports/types';

  let { viewport }: { viewport: Viewport } = $props();

  let el: HTMLDivElement;
  let handle: ViewportHandle | undefined;
  const snapshot = () => $state.snapshot(shared);

  onMount(() => {
    handle = viewport.mount(el, snapshot());
    return () => handle?.destroy();
  });

  $effect(() => handle?.update(snapshot()));
</script>

<div class="viewport" bind:this={el}></div>

<style>
  .viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .viewport :global(canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
