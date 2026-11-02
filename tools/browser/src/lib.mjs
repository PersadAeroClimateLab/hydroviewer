// Playwright setup shared by browse.mjs and ad-hoc scripts. For anything the CLI cannot
// express (real pointer drags, multi-step flows), write a script next to this file:
//
//   import { open } from './lib.mjs';
//   const s = await open('http://web:5173/');
//   await s.page.mouse.move(400, 300); await s.page.mouse.down(); /* ... */
//   console.log(JSON.stringify(s.report())); await s.close();
//
// Run it with: docker compose run --rm --entrypoint node browser src/myscript.mjs
import { chromium } from 'playwright-core';

// Software-GL chatter and the favicon, which the dev server does not serve.
const NOISE = [/GL Driver Message/, /favicon\.ico/];

// Chromium does not read HTTP(S)_PROXY, so pass it explicitly. The target host and dotless
// names (<local>: compose service names like web and data, which the proxy cannot route to)
// go direct.
function proxyFor(url) {
  const server = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!server) return undefined;
  const bypass = [...(process.env.NO_PROXY ?? '').split(',').filter(Boolean), new URL(url).hostname, '<local>'];
  return { server, bypass: bypass.join(',') };
}

export async function open(url, { size = [1280, 800], scale = 1, ignore = [], timeout = 30000 } = {}) {
  const start = Date.now();
  const skip = [...NOISE, ...ignore.map((p) => new RegExp(p))];
  const proxy = proxyFor(url);
  const browser = await chromium.launch({
    proxy,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  // The proxy re-signs TLS with its own CA, which Chromium does not trust.
  const context = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: scale,
    ignoreHTTPSErrors: Boolean(proxy),
  });
  const page = await context.newPage();

  const messages = [];
  const failed = [];
  page.on('console', (m) => messages.push({ level: m.type(), text: m.text() }));
  page.on('pageerror', (e) => messages.push({ level: 'error', text: e.stack?.split('\n')[0] ?? String(e) }));
  page.on('response', (r) => r.status() >= 400 && failed.push({ status: r.status(), url: r.url() }));
  page.on('requestfailed', (r) => {
    const error = r.failure()?.errorText;
    if (error !== 'net::ERR_ABORTED') failed.push({ error, url: r.url() });
  });

  let status = null;
  let navError = null;
  try {
    status = (await page.goto(url, { timeout }))?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  } catch (e) {
    navError = e.message.split('\n')[0];
  }

  const grouped = (level) => {
    const counts = new Map();
    for (const m of messages) {
      // Failed loads are reported with their URL in failed_requests; drop Chromium's duplicate.
      if (m.level !== level || skip.some((re) => re.test(m.text))) continue;
      if (m.text.startsWith('Failed to load resource')) continue;
      counts.set(m.text, (counts.get(m.text) ?? 0) + 1);
    }
    return [...counts].map(([text, count]) => ({ text, count }));
  };

  return {
    page,
    close: () => browser.close(),
    // Snapshot of what the page has done so far; call after the interaction under test.
    report({ logs = false } = {}) {
      const errors = grouped('error');
      const failedRequests = failed.filter((f) => !skip.some((re) => re.test(f.url)));
      const out = {
        url,
        status,
        elapsed_s: Math.round((Date.now() - start) / 100) / 10,
        errors,
        warnings: grouped('warning'),
        failed_requests: failedRequests,
      };
      if (navError) out.nav_error = navError;
      if (logs) {
        out.logs = messages
          .filter((m) => !['error', 'warning'].includes(m.level) && !skip.some((re) => re.test(m.text)))
          .map((m) => ({ level: m.level, text: m.text }));
      }
      out.ok = !navError && status < 400 && !errors.length && !failedRequests.length;
      return out;
    },
  };
}
