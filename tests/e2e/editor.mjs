import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.route("**/auth.js*", (r) =>
  r.fulfill({
    contentType: "text/javascript",
    body: `export async function connectAuth(cb){cb({uid:'alice',displayName:'테스트 사용자',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
  }),
);
try {
  await page.goto("http://127.0.0.1:18101");
  await page.locator(".legacy-tools").evaluate((n) => (n.open = true));
  await page.getByRole("button", { name: "작업실", exact: true }).click();
  await page.getByRole("button", { name: "새 카드 작업", exact: true }).click();
  await page.locator("#import-title").fill("합성 검증 · 전기장");
  await page
    .locator("#import-text")
    .fill(
      Array.from(
        { length: 10 },
        (_, i) => `카드 ${i + 1}\n단위 양전하에 작용하는 힘을 살펴봅니다.`,
      ).join("\n---\n"),
    );
  await page
    .getByRole("button", { name: "카드로 가져오기", exact: true })
    .click();
  await page.locator("#draft-editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-card-thumb]").count(), 10);
  await page.locator("[data-card-body]").first().fill("이 문장은 유지됩니다.");
  await page.locator("[data-card-formula]").first().fill("E = \\frac{F}{q}");
  await page.locator("#save-draft").click();
  await page.getByText("원고를 저장했어요.", { exact: true }).waitFor();
  await page.locator('[data-card-select="0"]').check();
  await page.locator('[data-scope="body"]').uncheck();
  await page.locator('[data-scope="diagram"]').check();
  await page
    .locator("#revision-instruction")
    .fill("오른쪽으로 향하는 전기장 화살표를 그려줘");
  await page.locator("#propose-cards").click();
  await page.locator("[data-proposal-diff]").first().waitFor();
  assert.equal(
    await page.locator("[data-card-body]").first().inputValue(),
    "이 문장은 유지됩니다.",
  );
  await page
    .getByRole("button", { name: "선택한 수정안 적용", exact: true })
    .click();
  await page
    .getByText("선택한 카드에 수정안을 적용했어요.", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("[data-card-body]").first().inputValue(),
    "이 문장은 유지됩니다.",
  );
  assert.equal(await page.locator("[data-drawing-row]").count(), 2);
  await mkdir("test-results", { recursive: true });
  await page
    .locator(".card-edit-layout")
    .screenshot({ path: "test-results/card-editor-diagram.png" });
  await page.locator("#card-history").click();
  await page
    .getByRole("button", { name: /이 수정 전으로 1번 카드 복원/ })
    .first()
    .click();
  await page
    .getByText("이 카드만 이전 상태로 복원했어요.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("[data-drawing-row]").count(), 0);
  // Export uses the same render path. Ten unique numbered PNGs must be 1080 square.
  const zipDownload = page.waitForEvent("download");
  await page.locator("#export-card-zip").click();
  const download = await zipDownload;
  const zip = unzipSync(new Uint8Array(await readFile(await download.path())));
  const pngs = Object.keys(zip).filter((n) => n.endsWith(".png"));
  assert.equal(pngs.length, 10);
  assert.equal(new Set(pngs).size, 10);
  assert.equal(
    new Set(pngs.map((n) => createHash("sha256").update(zip[n]).digest("hex")))
      .size,
    10,
  );
  await writeFile("test-results/exported-card-01.png", zip["card-01.png"]);
  for (const name of pngs) {
    const view = new DataView(zip[name].buffer, zip[name].byteOffset);
    assert.equal(view.getUint32(16), 1080);
    assert.equal(view.getUint32(20), 1080);
  }
  assert.equal(pngs[0], "card-01.png");
  assert.equal(pngs[9], "card-10.png");
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/card-studio.png",
    fullPage: true,
  });
  // Untrusted text remains inert and overflow prevents truncated publication.
  await page
    .locator("[data-card-body]")
    .first()
    .fill("<script>window.pwned=1</script>");
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.locator("[data-card-body]").first().fill("긴 설명 ".repeat(700));
  await page
    .getByText(/본문이 카드 영역을/)
    .first()
    .waitFor();
  await page.locator("#export-card-png").click();
  await page
    .locator("#notice")
    .filter({ hasText: /본문이 카드 영역을/ })
    .waitFor();
  await page
    .locator("[data-card-body]")
    .first()
    .fill("모바일에서도 읽을 수 있는 설명");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "test-results/card-studio-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS card studio: import 10, scoped diagram patch, compare/apply, restore, PNG ZIP 10x1080, XSS, overflow, mobile",
  );
} catch (e) {
  console.log("NOTICE", await page.locator("#notice").innerText());
  console.log(
    "PREVIEW",
    await page.locator(".preview-error").allTextContents(),
  );
  await page.screenshot({
    path: "test-results/editor-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
