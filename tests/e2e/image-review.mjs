import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("test-results/review-fixtures", { recursive: true });
execFileSync(".venv/bin/python", [
  "-c",
  `
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
font=ImageFont.load_default(size=42)
for i in range(1,8):
 im=Image.new('RGB',(1080,1080),'#f5f5ef'); d=ImageDraw.Draw(im)
 d.text((80,70),'N. ENGINEERING  /  SYNTHETIC TEST',font=font,fill='#173d35')
 d.text((80,200),f'CARD {i:02} - ELECTRIC FIELD',font=font,fill='#173d35')
 d.text((80,330),'E = F / q' if i != 7 else 'E = q / F',font=font,fill='#151c1a')
 d.line((160,650,850,650),fill='#173d35',width=10)
 d.polygon([(850,650),(800,620),(800,680)],fill='#173d35')
 d.text((80,850),'Please check units and arrow direction.',font=font,fill='#151c1a')
 im.save(f'test-results/review-fixtures/card-{i}.png')
`,
]);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.route("**/auth.js*", (r) =>
  r.fulfill({
    contentType: "text/javascript",
    body: `
export async function connectAuth(cb){window.testSession=cb;cb({uid:'alice',displayName:'합성 테스트',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
  }),
);
try {
  await page.goto("http://127.0.0.1:18101");
  await page.getByRole("button", { name: "이미지 검토", exact: true }).click();
  await page.locator("#review-upload").waitFor();
  await page.locator("#review-upload").setInputFiles({
    name: "spoof.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    ),
  });
  await page.getByText(/실제 이미지 형식/).waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-upload-card]").count(), 0);
  const files = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => ({
      name: i < 2 ? "same.png" : `card-${i + 1}.png`,
      mimeType: "image/png",
      buffer: await readFile(`test-results/review-fixtures/card-${i + 1}.png`),
    })),
  );
  await page.locator("#review-upload").setInputFiles(files);
  await page.locator("[data-upload-card]").nth(5).waitFor();
  assert.equal(await page.locator("[data-upload-card]").count(), 6);
  await page
    .locator("[data-upload-card]")
    .nth(1)
    .getByRole("button", { name: "앞으로" })
    .click();
  await page.locator("#review-title").fill("합성 검증 · 전기장 카드뉴스");
  await page.locator("#review-start").click();
  await page.locator("[data-review-card]").nth(5).waitFor();
  await page.getByText("단위를 명시하세요", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-review-card]").count(), 6);
  await page.screenshot({
    path: "test-results/image-review.png",
    fullPage: true,
  });
  await page.locator("[data-review-card]").nth(1).click();
  await page
    .locator("#review-replace")
    .setInputFiles("test-results/review-fixtures/card-7.png");
  await page.getByText("새 이미지 · 재검토 필요", { exact: true }).waitFor();
  await page.locator("[data-review-card]").first().click();
  await page
    .locator("#review-replace")
    .setInputFiles("test-results/review-fixtures/card-7.png");
  await page.getByText("새 이미지 · 재검토 필요", { exact: true }).waitFor();
  await page.locator("#review-one").click();
  await page.getByText("AI 판단: 해결됨", { exact: true }).waitFor();
  await page.locator("[data-review-card]").nth(1).click();
  await page.getByText("새 이미지 · 재검토 필요", { exact: true }).waitFor();
  await page.getByRole("button", { name: "이미지 교체 취소" }).click();
  await page.locator("[data-review-card]").first().click();
  await page.getByLabel("직접 확인했어요").first().check();
  await page.locator("#review-versions").click();
  await page.getByRole("button", { name: "버전 1 보기", exact: true }).click();
  await page.getByText("이전 버전 1 · 읽기 전용", { exact: true }).waitFor();
  await page.getByRole("button", { name: "현재 버전으로 돌아가기" }).click();
  await page.reload();
  await page.getByRole("button", { name: "이미지 검토", exact: true }).click();
  await page.locator("[data-review-card]").nth(5).waitFor();
  assert.equal(
    await page.locator("[data-finding-check]").first().isChecked(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/image-review-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: six images, duplicate names, ordering, batch review, single replacement, resolutions, checks, history, IndexedDB reload, mobile",
  );
  // Losing only local image bytes must retain server findings and require the exact image.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("content-image-reviews", 1);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction("assets", "readwrite");
          tx.objectStore("assets").clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = reject;
        };
      }),
  );
  await page.reload();
  await page.getByRole("button", { name: "이미지 검토", exact: true }).click();
  await page.getByText(/이 브라우저에 이미지가 없어요/).waitFor();
  await page
    .locator("#review-replace")
    .setInputFiles("test-results/review-fixtures/card-1.png");
  await page.getByText(/기존 이미지와 달라요/).waitFor();
  await page
    .locator("#review-replace")
    .setInputFiles("test-results/review-fixtures/card-7.png");
  await page.getByRole("button", { name: "카드 이미지 확대" }).waitFor();
  await page.getByRole("button", { name: "카드 이미지 확대" }).click();
  await page.locator("dialog[open]").waitFor();
  await page.evaluate(() => window.testSession(null));
  await page.locator("dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-review-card]").count(), 0);
  assert.equal(await page.locator(".review-image-button img").count(), 0);
  console.log(
    "PASS: missing local image, hash mismatch rejection, exact image restore, zoom cleanup on logout",
  );

  const authStub = `export async function connectAuth(cb){window.testSession=cb;cb({uid:'alice',displayName:'합성 테스트',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`;
  const recoveryPage = await browser.newPage();
  await recoveryPage.route("**/auth.js*", (r) =>
    r.fulfill({ contentType: "text/javascript", body: authStub }),
  );
  await recoveryPage.goto("http://127.0.0.1:18101");
  await recoveryPage
    .getByRole("button", { name: "이미지 검토", exact: true })
    .click();
  await recoveryPage.locator("#review-upload").setInputFiles(files.slice(0, 2));
  await recoveryPage.locator("[data-upload-card]").nth(1).waitFor();
  let modelPosts = 0;
  await recoveryPage.route(
    /\/api\/image-reviews\/[^/]+\/runs$/,
    async (route) => {
      modelPosts++;
      await route.fetch();
      await route.fulfill({ status: 503, json: { detail: "합성 응답 유실" } });
    },
  );
  await recoveryPage.locator("#review-start").click();
  await recoveryPage.getByText("합성 응답 유실", { exact: true }).waitFor();
  await recoveryPage
    .getByRole("button", { name: "검토 상태 확인", exact: true })
    .click();
  await recoveryPage
    .getByText("저장된 검토 결과를 복구했어요.", { exact: true })
    .waitFor();
  assert.equal(modelPosts, 1);
  await recoveryPage.unroute(/\/api\/image-reviews\/[^/]+\/runs$/);
  await recoveryPage.route(
    /\/api\/image-reviews\/[a-f0-9]{64}$/,
    async (route) => {
      const response = await route.fetch(),
        json = await response.json();
      json.cards[0].result.findings[0].suggestion =
        '<img src=x onerror="window.pwned=1">';
      await route.fulfill({ json });
    },
  );
  await recoveryPage.reload();
  await recoveryPage
    .getByRole("button", { name: "이미지 검토", exact: true })
    .click();
  await recoveryPage
    .getByText('<img src=x onerror="window.pwned=1">', { exact: true })
    .waitFor();
  assert.equal(await recoveryPage.evaluate(() => window.pwned), undefined);
  console.log(
    "PASS: response loss recovery without second model request, escaped model output",
  );
  await recoveryPage.unroute(/\/api\/image-reviews\/[a-f0-9]{64}$/);
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  await recoveryPage.route(
    /\/api\/image-reviews\/[^/]+\/runs$/,
    async (route) => {
      const response = await route.fetch();
      entered();
      await hold;
      await route.fulfill({ response });
    },
  );
  await recoveryPage.locator("#review-all").click();
  await started;
  await recoveryPage.evaluate(() =>
    window.testSession({
      uid: "bob",
      displayName: "다른 계정",
      getIdToken: async () => "bob",
    }),
  );
  release();
  await recoveryPage
    .getByText("카드뉴스를 한 번에 올려주세요", { exact: true })
    .waitFor();
  assert.equal(await recoveryPage.locator("[data-review-card]").count(), 0);
  assert.equal(
    await recoveryPage.locator(".review-image-button img").count(),
    0,
  );
  console.log("PASS: late response discarded after account change");
  await recoveryPage.close();

  const storagePage = await browser.newPage();
  await storagePage.route("**/auth.js*", (r) =>
    r.fulfill({ contentType: "text/javascript", body: authStub }),
  );
  await storagePage.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "assets")
        throw new DOMException("합성 저장소 실패", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  let posts = 0;
  storagePage.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/image-reviews")) posts++;
  });
  await storagePage.goto("http://127.0.0.1:18101");
  await storagePage
    .getByRole("button", { name: "이미지 검토", exact: true })
    .click();
  await storagePage.locator("#review-upload").setInputFiles(files.slice(0, 1));
  await storagePage.getByText("합성 저장소 실패", { exact: true }).waitFor();
  assert.equal(posts, 0);
  assert.equal(await storagePage.locator("[data-upload-card]").count(), 0);
  await storagePage.close();
  console.log("PASS: IndexedDB write failure prevents review submission");
} finally {
  await browser.close();
}
