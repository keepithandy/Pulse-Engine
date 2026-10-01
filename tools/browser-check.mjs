import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium, webkit } from "playwright";
const root = resolve(".");
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(root + sep)) throw new Error("Path outside root.");
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  const name = process.env.PULSE_BROWSER ?? 'chromium';
  const type = { chromium, webkit }[name];
  if (!type) throw new Error(`Unsupported browser: ${name}`);
  browser = await type.launch({ headless: true, ...(process.env.PULSE_BROWSER_PATH ? { executablePath: process.env.PULSE_BROWSER_PATH } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/test/browser-fixture.html`);
  await page.waitForFunction(() => window.pulseResult !== undefined);
  const result = await page.evaluate(() => window.pulseResult);
  if (!result.ok || errors.length) throw new Error(JSON.stringify({ result, errors }));
  console.log(`${name}: native ES module import, dispatch, rules, scheduling, restore, and diagnostics passed.`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
