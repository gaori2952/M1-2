import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const failures = [];
async function pageForTest() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.route("**/auth.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function connectAuth(cb){cb({uid:'alice',displayName:'테스트 사용자',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)};}`,
    }),
  );
  await page.goto("http://127.0.0.1:18101");
  await page.locator("#source-picker input").first().waitFor();
  return page;
}
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (e) {
    failures.push(name + ": " + e.message);
  }
}
try {
  await check("Reopen same draft preserves unsaved text", async () => {
    const page = await pageForTest();
    let confirmations = 0;
    page.on("dialog", async (d) => {
      confirmations++;
      await d.accept();
    });
    await page.getByRole("button", { name: "대화 기록", exact: true }).click();
    const drafts = await (
      await page.request.get("http://127.0.0.1:18100/api/drafts", {
        headers: { Authorization: "Bearer alice" },
      })
    ).json();
    const history = await (
      await page.request.get("http://127.0.0.1:18100/api/conversations", {
        headers: { Authorization: "Bearer alice" },
      })
    ).json();
    const index = history.findIndex((c) => c.id === drafts[0].conversation_id);
    await page
      .getByRole("button", { name: "불러오기", exact: true })
      .nth(index)
      .click();
    await page.locator("#open-draft").click();
    await page
      .locator("[data-card-body]")
      .first()
      .fill("저장하지 않은 수정 유지");
    await page.getByRole("button", { name: "작업실", exact: true }).click();
    await page.locator("#open-draft").click();
    await page.locator("#draft-editor").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("[data-card-body]").first().inputValue(),
      "저장하지 않은 수정 유지",
    );
    await page.close();
  });
  await check(
    "Draft save prevents concurrent editing and navigation",
    async () => {
      const page = await pageForTest();
      await page
        .getByRole("button", { name: "대화 기록", exact: true })
        .click();
      await page
        .getByRole("button", { name: "원고 열기", exact: true })
        .first()
        .click();
      await page.locator("[data-card-body]").first().fill("저장할 내용");
      let release;
      const gate = new Promise((r) => (release = r));
      await page.route("**/api/drafts/*", async (route) => {
        if (route.request().method() === "PUT") {
          await gate;
        }
        await route.continue();
      });
      const pending = page.waitForRequest(
        (r) => r.url().includes("/api/drafts/") && r.method() === "PUT",
      );
      await page
        .getByRole("button", { name: "원고 저장", exact: true })
        .click();
      await pending;
      try {
        assert.equal(
          await page.locator("[data-card-body]").first().isDisabled(),
          true,
        );
        await page
          .getByRole("button", { name: "대화 기록", exact: true })
          .click();
        assert.equal(await page.locator("#draft-editor").isVisible(), true);
      } finally {
        release();
      }
      await page.getByText("원고를 저장했어요.", { exact: true }).waitFor();
      await page.close();
    },
  );
  await check(
    "Uncertain 503 retry preserves request UUID and input",
    async () => {
      const page = await pageForTest();
      const ids = [];
      await page.route("**/api/chat", async (route) => {
        ids.push(route.request().postDataJSON().request_id);
        if (ids.length === 1)
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ detail: "저장 결과 확인 불가" }),
          });
        else await route.continue();
      });
      await page.locator("#message").fill("재시도 검증");
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page.getByText("저장 결과 확인 불가", { exact: true }).waitFor();
      assert.equal(await page.locator("#message").inputValue(), "재시도 검증");
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page
        .getByText("대화가 자동 저장됐어요.", { exact: true })
        .waitFor();
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
      await page.close();
    },
  );
} finally {
  await browser.close();
}
assert.deepEqual(failures, []);
