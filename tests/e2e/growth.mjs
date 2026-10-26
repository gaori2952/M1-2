import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/auth.js*", (r) =>
  r.fulfill({
    contentType: "text/javascript",
    body: `export async function connectAuth(cb){cb({uid:'alice',displayName:'합성 테스트',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
  }),
);
try {
  await page.goto("http://127.0.0.1:18101");
  await page
    .getByRole("heading", { name: "다음 게시, 팔로워로 이어지게." })
    .waitFor();
  await page
    .getByRole("button", { name: "Buffer 새로 불러오기", exact: true })
    .click();
  await page.getByText("합성 자료 · 테스트 계정", { exact: true }).waitFor();
  assert.equal(await page.locator("#growth-slot").isVisible(), false);
  await page.locator("#growth-question").fill("다음 콘텐츠 추천해줘");
  await page
    .getByRole("button", { name: "AI에게 물어보기", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "1. 전기장은 있는데 전위차는 왜 0일까?",
      exact: true,
    })
    .waitFor();
  await page.locator(".growth-idea-source a").first().waitFor();
  await page.getByText(/캡션 일부 참고 · 성과 수치 미포함/).waitFor();
  assert.doesNotMatch(
    await page.locator("#growth-metrics").innerText(),
    /0건도 포함/,
  );
  await page.reload();
  await page
    .getByRole("heading", {
      name: "1. 전기장은 있는데 전위차는 왜 0일까?",
      exact: true,
    })
    .waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/growth-content.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "새 성장 대화", exact: true }).click();
  await page.locator("#growth-topic").fill("전기장");
  await page.locator("#growth-timing > summary").click();
  const future = new Date(Date.now() + 86400000);
  future.setHours(20, 0, 0, 0);
  const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await page.locator("#growth-slot").fill(local);
  await page
    .getByRole("button", { name: "가능한 시간 추가", exact: true })
    .click();
  await page
    .getByRole("button", { name: "시간 후보 확인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "이 시간으로 실험 저장", exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "이 시간으로 실험 저장", exact: true })
    .first()
    .click();
  await page
    .locator("#growth-question")
    .fill("이 시간에 전기장 카드뉴스를 올려도 될까?");
  await page
    .getByRole("button", { name: "AI에게 물어보기", exact: true })
    .click();
  await page.getByText(/합성 테스트 응답입니다/).waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/growth-chat.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "지난 게시", exact: true }).click();
  await page.locator(".growth-experiments-panel > summary").click();
  await page
    .locator("#growth-experiments select")
    .first()
    .selectOption("synthetic0");
  await page
    .getByRole("button", { name: "게시물 연결", exact: true })
    .first()
    .click();
  await page
    .getByText(/계획과 다른 시간/)
    .first()
    .waitFor();
  await page.locator(".growth-experiments-panel > summary").click();
  await page.screenshot({
    path: "test-results/growth-posts.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "내 데이터", exact: true }).click();
  await page
    .getByRole("heading", { name: "최근 게시물", exact: true })
    .waitFor();
  assert.equal(await page.locator("#growth-csv-form").isVisible(), false);
  await page
    .getByRole("button", { name: "Buffer 자료 갱신", exact: true })
    .click();
  await page
    .getByText("Buffer에서 최신 자료를 다시 가져왔어요.", { exact: true })
    .waitFor();
  await page.locator("#data-archive-label").click();
  await page.getByRole("button", { name: "＋ 직접 기록", exact: true }).click();
  await page.locator("#data-date").fill("2026-10-22");
  await page.locator("#data-value").fill("42");
  await page.locator("#data-memo").fill("성장 비서 CRUD 합성 검증");
  await page.getByRole("button", { name: "데이터 저장", exact: true }).click();
  await page.getByText("성장 비서 CRUD 합성 검증", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/growth-data.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "대화 기록", exact: true }).click();
  await page
    .getByRole("button", { name: "불러오기", exact: true })
    .first()
    .click();
  await page.getByText(/합성 테스트 응답입니다/).waitFor();
  await page.screenshot({
    path: "test-results/growth-history.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByText(/합성 테스트 응답입니다/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "test-results/growth-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  assert.equal(await page.getByText(/합성 테스트 응답입니다/).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Growth E2E PASS: sync, content ideas with sources, optional timing, experiment, CRUD, history/reload, mobile, logout.",
  );
} catch (e) {
  await page.screenshot({
    path: "test-results/growth-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
