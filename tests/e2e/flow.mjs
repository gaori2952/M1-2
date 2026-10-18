import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE_ROOT
    ? `${process.env.PLAYWRIGHT_PACKAGE_ROOT}/package.json`
    : import.meta.url,
);
const { chromium } = require("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/auth.js*", (route) =>
  route.fulfill({
    contentType: "text/javascript",
    body: `export async function connectAuth(callback){callback({displayName:'테스트 사용자',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>callback(null)};}`,
  }),
);
try {
  await page.goto("http://127.0.0.1:18101");
  await page.getByText("콘텐츠 작업실", { exact: true }).waitFor();
  await page.getByRole("button", { name: "계정 데이터", exact: true }).click();
  await page.locator("#data-list tr").first().waitFor();
  await page.getByRole("button", { name: "＋ 기록 추가", exact: true }).click();
  await page.locator("#data-date").fill("2026-10-17");
  await page.locator("#data-value").fill("5000");
  await page.locator("#data-memo").fill("브라우저 CRUD 검증");
  await page.getByRole("button", { name: "데이터 저장", exact: true }).click();
  await page.getByText("브라우저 CRUD 검증", { exact: true }).waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/data.png", fullPage: true });
  await page.getByRole("button", { name: "작업실", exact: true }).click();
  await page.locator(".planning-tools > summary").click();
  await page.locator("#message").fill("이번 기간은 어때?");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.getByText(/선택 기간 조회수의 유효 관측/).waitFor();
  await page.screenshot({ path: "test-results/chat.png", fullPage: true });
  await page.locator("#mode").selectOption("ideas");
  await page.locator("#message").fill("전자기학 후속 주제 추천");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page
    .getByRole("button", { name: "이 주제로 원고 만들기" })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "이 주제로 원고 만들기" }).count(),
    3,
  );
  await page
    .getByRole("button", { name: "이 주제로 원고 만들기" })
    .first()
    .click();
  await page.locator("#draft-editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-card-body]").count(), 6);
  await page
    .locator("[data-card-body]")
    .first()
    .fill('<img src=x onerror="window.pwned=1"> 수정 원고');
  await page.getByRole("button", { name: "원고 저장", exact: true }).click();
  await page.getByText("원고를 저장했어요.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.screenshot({ path: "test-results/draft.png", fullPage: true });
  await page.getByRole("button", { name: "대화 기록", exact: true }).click();
  await page
    .getByRole("button", { name: "불러오기", exact: true })
    .first()
    .click();
  await page.getByText("전자기학 후속 주제 추천", { exact: true }).waitFor();
  await page.screenshot({ path: "test-results/history.png", fullPage: true });
  await page.reload();
  await page.locator("#open-draft").waitFor({ state: "visible" });
  await page.locator("#open-draft").click();
  assert.match(
    await page.locator("[data-card-body]").first().inputValue(),
    /수정 원고/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "작업실", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "E2E PASS: data create, chat, 3 ideas, 6 cards, draft edit, reload, history, XSS, mobile layout.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
