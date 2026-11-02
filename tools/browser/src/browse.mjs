// Load a page in headless Chromium, report console/network problems as compact JSON,
// and optionally screenshot it. Exit status is 0 only if the page loaded and is clean.
//
//   browse.mjs URL [--shot FILE] [--clip SELECTOR] [--size WxH] [--scale N]
//                  [--wait JS] [--eval JS]... [--settle MS] [--ignore REGEX]... [--logs]
//
// --wait   poll this JS expression until truthy (e.g. 'window.ready === true')
// --eval   run a JS expression in the page, in order; each result lands in `evals`
//          (statements need an IIFE; a thrown error is reported and fails the run)
// --settle ms to let the render loop run before the screenshot (default 500)
// Screenshots use the compositor, so WebGL canvases are captured. Relative --shot paths
// resolve under /out, which compose mounts to ./.shots on the host.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { open } from './lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shot: { type: 'string' },
    clip: { type: 'string' },
    size: { type: 'string', default: '1280x800' },
    scale: { type: 'string', default: '1' },
    wait: { type: 'string' },
    eval: { type: 'string', multiple: true, default: [] },
    settle: { type: 'string', default: '500' },
    ignore: { type: 'string', multiple: true, default: [] },
    logs: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '30000' },
  },
});
const [url] = positionals;
if (!url) {
  console.error('usage: browse.mjs URL [--shot FILE] [--wait JS] [--eval JS]... (see header of browse.mjs)');
  process.exit(2);
}

const size = values.size.split('x').map(Number);
const timeout = Number(values.timeout);
const s = await open(url, { size, scale: Number(values.scale), ignore: values.ignore, timeout });
const extra = {};

if (values.wait) {
  await s.page.waitForFunction(values.wait, null, { timeout }).catch(() => (extra.wait_timed_out = true));
}
for (const expression of values.eval) {
  try {
    (extra.evals ??= []).push(await s.page.evaluate(expression));
  } catch (e) {
    (extra.evals ??= []).push({ error: e.message.split('\n')[0] });
    extra.eval_failed = true;
  }
}
await s.page.waitForTimeout(Number(values.settle));

if (values.shot) {
  const file = path.resolve('/out', values.shot);
  await (values.clip ? s.page.locator(values.clip) : s.page).screenshot({ path: file });
  extra.shot = file;
}

const report = s.report({ logs: values.logs });
report.ok &&= !extra.wait_timed_out && !extra.eval_failed;
console.log(JSON.stringify({ ...report, ...extra }));
await s.close();
process.exit(report.ok ? 0 : 1);
