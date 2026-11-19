<script lang="ts">
  // Two thumbs on one track: a [low, high] pair within [min, max], kept at least a step apart. Two overlaid native
  // range inputs, so each thumb keeps its keyboard and touch handling; only the thumbs take the pointer.
  let {
    min,
    max,
    value,
    label,
    onchange,
  }: { min: number; max: number; value: [number, number]; label: string; onchange: (v: [number, number]) => void } =
    $props();
  const step = $derived((max - min) / 200);
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  // Whichever thumb is pushed against the other stays on top, so the pair can always be pulled apart.
  const lowOnTop = $derived(value[0] > (min + max) / 2);

  const set = (e: Event & { currentTarget: HTMLInputElement }, high: boolean) => {
    const v = Number(e.currentTarget.value);
    const next: [number, number] = high ? [value[0], Math.max(v, value[0] + step)] : [Math.min(v, value[1] - step), value[1]];
    e.currentTarget.value = String(next[high ? 1 : 0]); // a clamped thumb stays put
    onchange(next);
  };
</script>

<!-- Left out of screenshots: html-to-image cannot copy the thumbs' styles, and the ticks below give the range. -->
<div class="range" data-no-shot style:--lo={at(value[0])} style:--hi={at(value[1])}>
  <input type="range" {min} {max} {step} value={value[0]} aria-label="{label} minimum" class:top={lowOnTop} oninput={(e) => set(e, false)} />
  <input type="range" {min} {max} {step} value={value[1]} aria-label="{label} maximum" oninput={(e) => set(e, true)} />
</div>

<style>
  .range {
    position: relative;
    width: 160px;
    height: 16px;
  }
  /* The track, with the picked span in the accent colour. */
  .range::before {
    content: '';
    position: absolute;
    inset: 7px 0;
    border-radius: 1px;
    background: linear-gradient(
      to right,
      var(--border) var(--lo),
      var(--accent) var(--lo),
      var(--accent) var(--hi),
      var(--border) var(--hi)
    );
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    background: none;
    pointer-events: none;
    appearance: none;
    -webkit-appearance: none;
  }
  input.top {
    z-index: 1;
  }
  input:focus {
    outline: none; /* the focused thumb is ringed instead */
  }
  input::-webkit-slider-runnable-track {
    background: none;
  }
  input::-webkit-slider-thumb {
    -webkit-appearance: none;
    pointer-events: auto;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--accent);
    cursor: ew-resize;
  }
  input::-moz-range-track {
    background: none;
  }
  input::-moz-range-thumb {
    pointer-events: auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--accent);
    cursor: ew-resize;
  }
  input:focus-visible::-webkit-slider-thumb {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  input:focus-visible::-moz-range-thumb {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
