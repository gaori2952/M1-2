import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage();
page.setDefaultTimeout(8000);
await page.route("**/auth.js*", (r) =>
  r.fulfill({
    contentType: "text/javascript",
    body: `export async function connectAuth(cb){cb({uid:'alice',displayName:'테스트 사용자',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
  }),
);
const failures = [];
try {
  await page.goto("http://127.0.0.1:18101");
  try {
    const widths = await page.evaluate(async () => {
      const { renderCard } = await import("/card-renderer.js");
      const out = [];
      for (const title of [
        "Electric field intensity and direction in a uniform electric field",
        "Optical fibers and the principle of total internal reflection",
      ]) {
        const svg = await renderCard(
          { title, body: "Test", formula: "", conditions: "", artwork: [] },
          0,
          4,
        );
        document.body.append(svg);
        out.push(
          ...[...svg.querySelectorAll("tspan")].map((t) => {
            const b = t.getBBox();
            return b.x + b.width;
          }),
        );
        svg.remove();
      }
      return out;
    });
    assert.ok(
      Math.max(...widths) <= 1017,
      `Text extends to ${Math.max(...widths)}; right margin1016`,
    );
    console.log("PASS bold title fits PNG width");
  } catch (e) {
    failures.push(e.message);
  }
  try {
    const headers = { Authorization: "Bearer alice" };
    const existing = (
      await (
        await page.request.get("http://127.0.0.1:18100/api/drafts", { headers })
      ).json()
    )[0];
    const draft = structuredClone(existing.draft);
    draft.title = "복원 대상 회귀 테스트";
    draft.cards[0].body = "카드1 원본";
    draft.cards[1].body = "카드2 원본";
    const created = await (
      await page.request.post("http://127.0.0.1:18100/api/drafts", {
        headers,
        data: { request_id: crypto.randomUUID(), draft },
      })
    ).json();
    draft.cards[0].body = "카드1 수정";
    await page.request.put(`http://127.0.0.1:18100/api/drafts/${created.id}`, {
      headers,
      data: { version: 1, draft },
    });
    draft.cards[1].body = "카드2 보존할 수정";
    await page.request.put(`http://127.0.0.1:18100/api/drafts/${created.id}`, {
      headers,
      data: { version: 2, draft },
    });
    await page.getByRole("button", { name: "원고함", exact: true }).click();
    await page
      .getByRole("button", { name: "원고 열기", exact: true })
      .first()
      .click();
    await page.locator("#card-history").click();
    await page
      .getByRole("button", {
        name: "이 수정 전으로 1번 카드 복원",
        exact: true,
      })
      .waitFor();
    await page.locator('[data-card-thumb="1"] .thumb-open').click();
    assert.equal(
      await page
        .getByRole("button", {
          name: "이 수정 전으로 1번 카드 복원",
          exact: true,
        })
        .count(),
      0,
      "Switching pages must remove stale restore actions",
    );
    const current = await (
      await page.request.get(
        `http://127.0.0.1:18100/api/drafts/${created.id}`,
        { headers },
      )
    ).json();
    assert.equal(current.draft.cards[1].body, "카드2 보존할 수정");
    console.log("PASS changing cards clears stale restore action");
  } catch (e) {
    failures.push(e.message);
  }
} finally {
  await browser.close();
}
assert.deepEqual(failures, []);
