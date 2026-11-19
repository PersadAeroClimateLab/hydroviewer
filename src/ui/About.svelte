<script lang="ts">
  // About Hydroviewer, from the gear menu: what it is, its version, the developer's contact and the credits the data
  // and assets ask for. A native modal dialog (Escape closes it, focus stays inside); a click outside it closes it too.
  import { version } from '../../package.json';
  import Contact from './Contact.svelte';

  let { mock }: { mock: boolean } = $props(); // the bucket holds mock data, not model output
  let dialog: HTMLDialogElement;
  export const show = () => dialog.showModal();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions: Escape closes it natively -->
<dialog bind:this={dialog} aria-labelledby="about-title" onclick={(e) => e.target === dialog && dialog.close()}>
  <header>
    <h2 id="about-title">Hydroviewer <small>{version}</small></h2>
    <button aria-label="Close" onclick={() => dialog.close()}>✕</button>
  </header>
  <p>Climate model output on the globe, drawn in your browser: scenarios, models and ensemble members side by side.</p>

  <h3>Contact</h3>
  <div class="contact"><Contact /></div>

  <h3>Data</h3>
  {#if mock}
    <p>
      Mock data: analytic fields under real CMIP6 model and member names, for building the app. Not model output.
    </p>
  {:else}
    <p>
      CMIP6 model output, read from the <a href="https://registry.opendata.aws/cmip6/" target="_blank" rel="noopener">CMIP6
        public dataset</a> on AWS. We acknowledge the World Climate Research Programme, which, through its Working Group on
      Coupled Modelling, coordinated and promoted CMIP6. We thank the climate modeling groups for producing and making
      available their model output, the Earth System Grid Federation (ESGF) for archiving the data and providing access,
      and the multiple funding agencies who support CMIP6 and ESGF.
    </p>
  {/if}
  <p>
    Coastlines: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public
    domain). Colormaps viridis and magma: Nathaniel J. Smith and Stéfan van der Walt (CC0); imported maps in
    <a href="https://sciviscolor.org/" target="_blank" rel="noopener">SciVisColor</a> ColorMoves format.
  </p>
  <p class="built">Built with Svelte, three.js, Observable Plot and zarrita.</p>
</dialog>

<style>
  dialog {
    pointer-events: auto; /* it sits in the HUD, which passes the pointer through */
    width: min(460px, calc(100vw - 32px));
    box-sizing: border-box;
    padding: 16px 20px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
    font-size: 14px;
    line-height: 1.45;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.3);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.125rem;
  }
  h2 small {
    font-weight: normal;
    font-size: 12px;
    color: var(--muted);
  }
  h3 {
    margin: 16px 0 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  p {
    margin: 6px 0;
  }
  a {
    color: var(--accent);
  }
  .contact {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .built {
    color: var(--muted);
    font-size: 12px;
  }
  header button {
    font: inherit;
    color: var(--muted);
    background: none;
    border: 0;
    padding: 2px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  header button:hover {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
</style>
