import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const formats = Object.fromEntries(
  ["carousel", "reel", "post", "story"].map((k) => [
    k,
    {
      count: 0,
      follows_count: 0,
      conversion_count: 0,
      median_conversion: null,
    },
  ]),
);
const summary = { formats, time_comparisons: [], limitations: [] };
const growth = {
  format: "carousel",
  topic: "전기장",
  observation_mode: "lifetime",
  summary,
  candidates: [],
  evidence: [],
  missing: [],
  request_id: "saved",
};
const conversation = {
  id: "existing",
  messages: [
    {
      role: "assistant",
      content: "restored earlier answer",
      result: { growth },
    },
  ],
};
const pending = {
  request_id: "00000000-0000-4000-8000-000000000001",
  mode: "growth",
  message: "pending follow-up",
  conversation_id: "existing",
  growth_options: { format: "carousel", slots: [] },
};
const status = {
  channel: {
    name: "PRIVATE-ACCOUNT",
    timezone: "Asia/Seoul",
    postingSchedule: [],
  },
  count: 0,
  follows_count: 0,
  gpt_configured: false,
  chat_configured: true,
  assistant_provider: "anthropic",
  assistant_model: "synthetic-model",
};
const item = (id) => ({
  id,
  text: id,
  format: "carousel",
  status: "sent",
  metrics: {},
  assets: [],
  annotation: {},
  sent_at: "2026-10-01T10:00:00Z",
});
async function fixture(extra) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/auth.js*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function connectAuth(cb){window.testSession=cb;cb({uid:'alice',displayName:'test',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
    }),
  );
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    if (extra && (await extra(r, p))) return;
    let data = [];
    if (p === "/api/buffer/status") data = status;
    else if (p === "/api/growth/summary") data = summary;
    else if (p === "/api/buffer/posts")
      data = { items: [], total: 0, next_offset: null };
    else if (p === "/api/data/summary")
      data = { period: null, metrics: {}, daily: [] };
    else if (p === "/api/profile") data = { instructions: "" };
    else if (p === "/api/conversations/existing") data = conversation;
    await r.fulfill({ json: data });
  });
  return page;
}
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (e) {
    failures.push(name + ": " + e.message);
    console.log("FAIL", name, e.message);
  }
}
try {
  await check(
    "manual refresh fetches source and separates archive freshness",
    async () => {
      let syncBody;
      const page = await fixture(async (r, p) => {
        if (p === "/api/buffer/status") {
          await r.fulfill({
            json: {
              ...status,
              last_success_at: "2026-10-26T01:59:00Z",
              period: {
                start: "2026-10-01T10:00:00Z",
                end: "2026-10-25T10:00:00Z",
              },
              latest_metrics_at: "2026-10-26T00:00:00Z",
              oldest_metrics_at: "2026-10-25T00:00:00Z",
              metrics_missing_count: 2,
            },
          });
          return true;
        }
        if (p === "/api/data") {
          await r.fulfill({
            json: [{ date: "2026-10-13", metric: "follows", value: 10 }],
          });
          return true;
        }
        if (p === "/api/buffer/sync") {
          syncBody = r.request().postDataJSON();
          await r.fulfill({ json: { status: "done", count: 0 } });
          return true;
        }
      });
      await page.goto("http://127.0.0.1:18101");
      await page.getByText("PRIVATE-ACCOUNT", { exact: true }).waitFor();
      await page.locator("#growth-sync").click();
      await page
        .getByText("Buffer에서 최신 자료를 다시 가져왔어요.", { exact: true })
        .waitFor();
      assert.equal(syncBody.force, true);
      assert.match(
        await page.locator("#growth-source-state").innerText(),
        /10월 25일/,
      );
      assert.match(
        await page.locator("#growth-metric-state").innerText(),
        /10월 26일/,
      );
      assert.match(
        await page.locator("#growth-daily-label").innerText(),
        /과거.*2026-10-13/,
      );
      assert.equal(await page.locator("#growth-chart").isVisible(), false);
      const [input, select] = await Promise.all([
        page.locator("#growth-topic").boundingBox(),
        page.locator("#growth-format").boundingBox(),
      ]);
      assert.ok(Math.abs(input.y - select.y) <= 1);
      await page.close();
    },
  );
  await check("ambiguous sync 503 preserves recovery UUID", async () => {
    const page = await fixture(async (r, p) => {
      if (p === "/api/buffer/sync") {
        await r.fulfill({
          status: 503,
          json: { detail: "동기화 저장 결과 확인 불가" },
        });
        return true;
      }
    });
    await page.goto("http://127.0.0.1:18101");
    await page.getByText("PRIVATE-ACCOUNT", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Buffer 새로 불러오기", exact: true })
      .click();
    await page
      .getByText("동기화 저장 결과 확인 불가", { exact: true })
      .waitFor();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("follower-growth:alice:session")),
    );
    assert.ok(saved.syncPending);
    await page.close();
  });
  await check("ambiguous 503 preserves exact pending UUID", async () => {
    const page = await fixture(async (r, p) => {
      if (p === "/api/chat") {
        await r.fulfill({
          status: 503,
          json: {
            detail:
              "저장 결과를 확인할 수 없습니다. 입력을 유지하고 같은 요청으로 재시도하세요.",
          },
        });
        return true;
      }
    });
    await page.goto("http://127.0.0.1:18101");
    await page.getByText("PRIVATE-ACCOUNT", { exact: true }).waitFor();
    await page.locator("#growth-question").fill("test unknown outcome");
    await page
      .getByRole("button", { name: "AI에게 물어보기", exact: true })
      .click();
    await page.getByText(/저장 결과를 확인할 수 없습니다/).waitFor();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("follower-growth:alice:session")),
    );
    assert.ok(saved.pending?.request_id);
    await page.close();
  });
  await check(
    "reload keeps pending follow-up while restoring earlier conversation",
    async () => {
      const page = await fixture();
      await page.addInitScript(
        ({ pending }) =>
          localStorage.setItem(
            "follower-growth:alice:session",
            JSON.stringify({ cid: "existing", pending }),
          ),
        { pending },
      );
      await page.goto("http://127.0.0.1:18101");
      await page
        .getByText("restored earlier answer", { exact: true })
        .waitFor();
      const saved = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("follower-growth:alice:session")),
      );
      assert.equal(saved.pending?.request_id, pending.request_id);
      assert.equal(
        await page.locator("#growth-question").inputValue(),
        "pending follow-up",
      );
      await page.close();
    },
  );
  await check("settled old status cannot reappear after logout", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const page = await fixture(async (r, p) => {
      if (p === "/api/growth/summary") {
        await gate;
        await r.fulfill({ json: summary });
        return true;
      }
    });
    await page.goto("http://127.0.0.1:18101");
    await page.waitForFunction(() => !!window.testSession);
    await page.waitForTimeout(100);
    await page.evaluate(() => window.testSession(null));
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/growth/summary"),
    );
    release();
    await response;
    await page.waitForTimeout(100);
    assert.equal(
      await page.getByText("PRIVATE-ACCOUNT", { exact: true }).count(),
      0,
    );
    await page.close();
  });
  await check("saving B and loading more preserve A unsaved memo", async () => {
    const page = await fixture(async (r, p) => {
      if (p === "/api/buffer/posts") {
        const offset = new URL(r.request().url()).searchParams.get("offset");
        await r.fulfill({
          json:
            offset === "0"
              ? {
                  items: [item("post-a"), item("post-b")],
                  total: 3,
                  next_offset: 2,
                }
              : { items: [item("post-c")], total: 3, next_offset: null },
        });
        return true;
      }
      if (p.endsWith("/annotation")) {
        await r.fulfill({ json: {} });
        return true;
      }
    });
    await page.goto("http://127.0.0.1:18101");
    await page.getByText("PRIVATE-ACCOUNT", { exact: true }).waitFor();
    await page.getByRole("button", { name: "지난 게시", exact: true }).click();
    await page
      .locator(".growth-post details")
      .nth(0)
      .evaluate((n) => (n.open = true));
    await page
      .locator(".growth-post details")
      .nth(1)
      .evaluate((n) => (n.open = true));
    await page
      .locator(".growth-post textarea")
      .nth(0)
      .fill("keep my unsaved A");
    await page.locator(".growth-post textarea").nth(1).fill("save B");
    await page
      .getByRole("button", { name: "메모 저장", exact: true })
      .nth(1)
      .click();
    await page.getByText(/메모와 수동 값을 저장했어요/).waitFor();
    assert.equal(
      await page.locator(".growth-post textarea").nth(0).inputValue(),
      "keep my unsaved A",
    );
    await page
      .getByRole("button", { name: "게시물 더 보기", exact: true })
      .click();
    await page.locator(".growth-post").nth(2).waitFor();
    assert.equal(
      await page.locator(".growth-post textarea").nth(0).inputValue(),
      "keep my unsaved A",
    );
    await page.close();
  });
} finally {
  await browser.close();
}
assert.deepEqual(failures, []);
