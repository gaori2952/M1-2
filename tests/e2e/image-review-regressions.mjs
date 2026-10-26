import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const source = await readFile("test-results/review-fixtures/card-1.png");
const failures = [];
async function fixture(fn) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  page.setDefaultTimeout(5000);
  const api = { posts: 0, hash: null };
  let doc;
  await page.route("**/auth.js*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function connectAuth(cb){cb({uid:'alice',displayName:'합성 검증',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
    }),
  );
  await page.route("**/api/image-reviews**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/runs") && r.request().method() === "POST") {
      api.posts++;
      return r.fulfill({ json: { status: "ready" } });
    }
    if (url.pathname.endsWith("/versions"))
      return r.fulfill({
        json: [
          { version: 2, sha256: api.hash, result: doc.cards[0].result },
          {
            version: 1,
            sha256: api.hash,
            result: { summary: "이전 결과", findings: [], resolutions: [] },
          },
        ],
      });
    if (url.pathname.endsWith("/image-reviews")) return r.fulfill({ json: [] });
    return r.fulfill({ json: doc });
  });
  await page.goto("http://127.0.0.1:18101");
  await page.getByRole("button", { name: "이미지 검토", exact: true }).click();
  await page.locator("#review-upload").waitFor();
  api.hash = await page.evaluate(async (data) => {
    const { prepareFile, putImages, saveReviewSession } =
      await import("/review-images.js");
    const file = new File(
      [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
      "card.png",
      { type: "image/png" },
    );
    const a = await prepareFile(file);
    await putImages("alice", [a]);
    await saveReviewSession("alice", {
      review_id: "reviewdoc",
      selected: [],
      staged: [],
      pending: null,
    });
    return a.sha256;
  }, source.toString("base64"));
  doc = {
    id: "reviewdoc",
    title: "합성 회귀 검증",
    version: 2,
    connections: [],
    connections_stale: false,
    cards: Array.from({ length: 6 }, (_, i) => ({
      card_id: `card-${i}`,
      name: `card-${i}.png`,
      sha256: api.hash,
      version: 2,
      result: {
        summary: "합성 결과",
        findings: [],
        resolutions:
          i === 0
            ? [
                {
                  finding_id: "arrow",
                  status: "remaining",
                  previous_finding: {
                    location: "화살표 방향",
                    evidence: "오른쪽 화살표",
                  },
                },
                {
                  finding_id: "formula",
                  status: "resolved",
                  previous_finding: {
                    location: "수식 부호",
                    evidence: "E = +grad V",
                  },
                },
              ]
            : [],
      },
    })),
  };
  await page.reload();
  await page.getByRole("button", { name: "이미지 검토", exact: true }).click();
  await page.locator("[data-review-card]").nth(5).waitFor();
  try {
    await fn(page, api);
  } finally {
    await page.close();
  }
}
async function check(name, fn) {
  try {
    await fixture(fn);
    console.log("PASS", name);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log("FAIL", name, e.message.split("\n")[0]);
  }
}
try {
  await check(
    "no model POST on retry while session persistence fails",
    async (page, api) => {
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...a) {
          if (this.name === "sessions")
            throw new DOMException("합성 세션 저장 실패", "QuotaExceededError");
          return original.apply(this, a);
        };
      });
      await page.locator("#review-all").click();
      await page.getByText("합성 세션 저장 실패", { exact: true }).waitFor();
      assert.equal(api.posts, 0);
      await page.locator("[data-review-card]").nth(1).click();
      await page
        .getByRole("button", { name: "같은 요청 재시도", exact: true })
        .click();
      await page
        .locator("#image-review-root[aria-busy]")
        .waitFor({ state: "detached" });
      assert.equal(api.posts, 0);
    },
  );
  await check(
    "resolution statuses identify the prior findings by ID",
    async (page) => {
      const states = await page.locator(".review-resolution").allTextContents();
      assert.ok(
        states.find(
          (s) =>
            s.includes("남아 있음") &&
            s.includes("화살표 방향") &&
            s.includes("오른쪽 화살표"),
        ),
      );
      assert.ok(
        states.find(
          (s) =>
            s.includes("해결됨") &&
            s.includes("수식 부호") &&
            s.includes("E = +grad V"),
        ),
      );
    },
  );
  await check(
    "historical missing image can be restored without changing current version",
    async (page) => {
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open("content-image-reviews", 1);
            r.onsuccess = () => {
              const db = r.result;
              const t = db.transaction("assets", "readwrite");
              t.objectStore("assets").clear();
              t.oncomplete = () => {
                db.close();
                resolve();
              };
            };
          }),
      );
      await page.reload();
      await page
        .getByRole("button", { name: "이미지 검토", exact: true })
        .click();
      await page.locator("#review-versions").click();
      await page
        .getByRole("button", { name: "버전 1 보기", exact: true })
        .click();
      await page
        .getByText("이전 버전 1 · 읽기 전용", { exact: true })
        .waitFor();
      assert.equal(await page.locator("#review-restore-history").count(), 1);
      await page.locator("#review-restore-history").setInputFiles({
        name: "card.png",
        mimeType: "image/png",
        buffer: source,
      });
      await page.getByRole("button", { name: "카드 이미지 확대" }).waitFor();
      await page
        .getByText("이전 버전 1 · 읽기 전용", { exact: true })
        .waitFor();
    },
  );
  await check(
    "card numbers and finding counts fit inside scrollable thumbnails",
    async (page) => {
      const geometry = await page
        .locator("[data-review-card]")
        .first()
        .evaluate((el) => ({
          bottom: el.getBoundingClientRect().bottom,
          labelBottom: el.querySelector("small").getBoundingClientRect().bottom,
        }));
      assert.ok(
        geometry.labelBottom <= geometry.bottom,
        JSON.stringify(geometry),
      );
    },
  );
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
