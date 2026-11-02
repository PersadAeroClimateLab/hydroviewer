// Smoke test for browse.mjs. Run inside the image (it needs Chromium):
//   docker compose run --rm --entrypoint node browser --test test/smoke.mjs
// Each test says what a failure means.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';

const PAGE = `<canvas id=c width=64 height=64></canvas><button id=b onclick="n.textContent=+n.textContent+1">b</button><span id=n>0</span>
<script>
  const gl = c.getContext('webgl2');
  window.gl2 = Boolean(gl) && Boolean(gl.getExtension('EXT_color_buffer_float'));
  if (gl) { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  if (location.search.includes('bad')) { console.error('boom'); fetch('/missing.json'); }
  window.ready = true;
</script>`;

let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const ok = req.url.startsWith('/?') || req.url === '/';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/html' }).end(ok ? PAGE : 'nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

// Resolves with {code, out} instead of rejecting, since a non-zero exit is an expected result.
const browse = (...args) =>
  new Promise((resolve) =>
    execFile('node', ['src/browse.mjs', ...args], (err, stdout) =>
      resolve({ code: err?.code ?? 0, out: JSON.parse(stdout) }),
    ),
  );

test('clean page: exit 0, WebGL2 float rendering available, screenshot written, eval result returned', async () => {
  // Failing here means the happy path is broken, or software GL cannot do the float
  // textures the data path needs (check the flags in lib.mjs before blaming the app).
  const { code, out } = await browse(base, '--wait', 'window.ready', '--eval', 'window.gl2', '--shot', 'smoke.png');
  assert.equal(code, 0, JSON.stringify(out));
  assert.deepEqual(out.evals, [true]);
  assert.ok(statSync(out.shot).size > 0);
});

test('console error and 404 subrequest: exit 1 and both reported', async () => {
  // Failing here means a broken page would pass verification.
  const { code, out } = await browse(`${base}?bad`);
  assert.equal(code, 1);
  assert.deepEqual(out.errors, [{ text: 'boom', count: 1 }]);
  assert.equal(out.failed_requests[0].status, 404);
});

test('unreachable server: exit 1 with nav_error (not a screenshot of the browser error page)', async () => {
  // Failing here means a dead dev server would pass verification.
  const { code, out } = await browse('http://127.0.0.1:59999/', '--timeout', '5000');
  assert.equal(code, 1);
  assert.match(out.nav_error, /ERR_CONNECTION_REFUSED/);
});

test('--eval can interact with the page', async () => {
  // Failing here means evals run before load, or their results are lost.
  const { out } = await browse(base, '--eval', '(() => { b.click(); return n.textContent; })()');
  assert.deepEqual(out.evals, ['1']);
});
