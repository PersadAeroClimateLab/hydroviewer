<script lang="ts">
  // The developer's contact: name, the address (a mailto link with a subject, and a copy button for computers with
  // no mail app set up) and a link to report an issue on GitHub. Small and muted; it inherits its size and colour.
  import { copy, DEVELOPER, EMAIL, ISSUES, MAIL } from '../contact';

  let copied = $state(false);
  let timer = 0;
  const copyEmail = async () => {
    await copy(EMAIL);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  };
</script>

<span>{DEVELOPER}</span>
<span class="row">
  <a href={MAIL}>{EMAIL}</a>
  <button aria-label="Copy the email address" title="Copy the email address" onclick={copyEmail}>
    {#if copied}
      Copied
    {:else}
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h7" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    {/if}
  </button>
</span>
<a class="issue" href={ISSUES} target="_blank" rel="noopener">Report an issue</a>
<span class="status" aria-live="polite">{copied ? 'Email address copied' : ''}</span>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  .issue {
    margin-top: 1em; /* a blank line's space below the address */
  }
  a:hover,
  a:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }
  button {
    display: inline-flex;
    align-items: center;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 2px;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover,
  button:focus-visible {
    color: var(--accent);
  }
  .status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
