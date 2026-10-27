import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:18101";
async function fixture(health) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.route("**/auth.js*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function connectAuth(cb){cb({uid:'alice',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
    }),
  );
  await page.route("**/health", health);
  await page.route("**/api/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    let data = [];
    if (path === "/api/buffer/status")
      data = {
        channel: {
          name: "합성 계정",
          timezone: "Asia/Seoul",
          postingSchedule: [],
        },
        count: 0,
        chat_configured: true,
      };
    if (path === "/api/growth/summary")
      data = {
        formats: Object.fromEntries(
          ["carousel", "reel", "post", "story"].map((k) => [
            k,
            { count: 0, follows_count: 0, conversion_count: 0 },
          ]),
        ),
        time_comparisons: [],
        limitations: [],
      };
    if (path === "/api/buffer/posts")
      data = { items: [], total: 0, next_offset: null };
    if (path === "/api/data/summary")
      data = { period: null, metrics: {}, daily: [] };
    return r.fulfill({ json: data });
  });
  await page.goto(base);
  await page.getByText("합성 계정", { exact: true }).waitFor();
  return page;
}
try {
  let release;
  const cold = await fixture(async (r) => {
    await new Promise((resolve) => (release = resolve));
    await r.fulfill({ json: { status: "ok" } });
  });
  assert.equal(await cold.locator("#server-status").isVisible(), true);
  await cold.clock.runFor(10000);
  assert.match(await cold.locator("#server-elapsed").innerText(), /10초/);
  assert.match(
    await cold.locator("#server-estimate").innerText(),
    /예상.*20.*80/,
  );
  assert.match(await cold.locator("#server-status").innerText(), /절전/);
  assert.equal(
    await cold.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mkdir("test-results", { recursive: true });
  await cold.screenshot({
    path: "test-results/server-waking-mobile.png",
    fullPage: false,
  });
  release();
  await cold.locator("#server-status").waitFor({ state: "hidden" });
  console.log(
    "PASS immediate mobile banner, elapsed/estimated time, ready hides banner",
  );
  await cold.close();

  let calls = 0;
  const retry = await fixture((r) => {
    calls++;
    return r.fulfill(
      calls === 1
        ? { status: 503, json: { detail: "starting" } }
        : { json: { status: "ok" } },
    );
  });
  await retry.clock.runFor(5000);
  await retry.locator("#server-status").waitFor({ state: "hidden" });
  assert.equal(calls, 2);
  console.log("PASS temporary unavailable retries only the health endpoint");
  await retry.close();

  let ready = false,
    attempts = 0;
  const delayed = await fixture((r) => {
    attempts++;
    return r.fulfill(
      ready
        ? { json: { status: "ok" } }
        : { status: 503, json: { detail: "starting" } },
    );
  });
  await delayed.locator("#growth-question").fill("입력을 유지해 주세요");
  await delayed.clock.runFor(90000);
  await delayed.locator("#server-retry").waitFor({ state: "visible" });
  assert.match(
    await delayed.locator("#server-estimate").innerText(),
    /예상.*초과/,
  );
  assert.ok(attempts <= 7);
  const stopped = attempts;
  await delayed.clock.runFor(30000);
  assert.equal(attempts, stopped);
  ready = true;
  await delayed.locator("#server-retry").click();
  await delayed.locator("#server-status").waitFor({ state: "hidden" });
  assert.equal(
    await delayed.locator("#growth-question").inputValue(),
    "입력을 유지해 주세요",
  );
  console.log("PASS bounded probes, long-wait recovery, input preserved");
  await delayed.close();

  let htmlCalls = 0;
  const html = await fixture((r) => {
    htmlCalls++;
    return r.fulfill(
      htmlCalls === 1
        ? { contentType: "text/html", body: "<h1>Starting</h1>" }
        : { json: { status: "ok" } },
    );
  });
  assert.equal(await html.locator("#server-status").isVisible(), true);
  await html.clock.runFor(5000);
  await html.locator("#server-status").waitFor({ state: "hidden" });
  console.log("PASS provider loading HTML is not mistaken for a ready API");
  await html.close();
} finally {
  await browser.close();
}
