import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:18101";
const summary = {
  formats: {
    carousel: { count: 1, conversion_count: 1, median_conversion: 2 },
  },
  time_comparisons: [],
  limitations: [],
};
const post = {
  id: "post-one",
  text: "전기장과 전위",
  format: "carousel",
  status: "sent",
  metrics: {},
  annotation: {},
  assets: [],
  external_link: "https://www.instagram.com/p/example/",
  sent_at: "2026-10-01T10:00:00Z",
};
const reading = {
  title: "전기장과 전위",
  summary: "같은 전위 위 이동을 설명한다.",
  topics: ["전기장"],
  pages: [
    { card_id: "1", text: "등전위면", description: "전위 그림", legible: true },
  ],
};
const envelope = {
  status: "ready",
  post_id: post.id,
  reading,
  covered_count: 1,
  total_count: 2,
  cached: false,
};
async function fixture(extra) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/auth.js*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function connectAuth(cb){window.testSession=cb;cb({uid:'alice',displayName:'test',getIdToken:async()=> 'alice'});return {login:async()=>{},logout:async()=>cb(null)}}`,
    }),
  );
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (extra && (await extra(r, path))) return;
    let data = [];
    if (path === "/api/buffer/status")
      data = {
        channel: {
          name: "합성 계정",
          timezone: "Asia/Seoul",
          postingSchedule: [],
        },
        count: 1,
        chat_configured: true,
      };
    else if (path === "/api/growth/summary") data = summary;
    else if (path === "/api/buffer/posts")
      data = { items: [post], total: 1, next_offset: null };
    else if (path === "/api/data/summary")
      data = { period: null, metrics: {}, daily: [] };
    else if (path === "/api/post-readings/select") data = { candidates: [] };
    await r.fulfill({ json: data });
  });
  await page.goto(base);
  await page.getByText("합성 계정", { exact: true }).waitFor();
  return { page, context, errors };
}
try {
  {
    const reads = [],
      chats = [];
    let conversation, releaseReading;
    const readingGate = new Promise((resolve) => {
      releaseReading = resolve;
    });
    const { page, context, errors } = await fixture(async (r, path) => {
      if (path === "/api/post-readings/select") {
        await r.fulfill({
          json: {
            candidates: [
              {
                post_id: post.id,
                title: post.text,
                cached: false,
                image_count: 2,
              },
              {
                post_id: "second",
                title: "second",
                cached: false,
                image_count: 1,
              },
            ],
          },
        });
        return true;
      }
      if (path === "/api/post-readings") {
        reads.push(r.request().postDataJSON());
        await readingGate;
        await r.fulfill({ json: envelope });
        return true;
      }
      if (path === "/api/chat") {
        const body = r.request().postDataJSON();
        chats.push(body);
        conversation = {
          id: "chat-one",
          messages: [
            {
              role: "user",
              content: body.message,
              images: body.images.map(({ base64, ...meta }) => meta),
            },
            {
              role: "assistant",
              content: "초안을 비교했어요.",
              result: {
                source_ids: [post.id],
                growth: {
                  format: "carousel",
                  topic: "",
                  observation_mode: "lifetime",
                  summary,
                  evidence: [
                    {
                      ...post,
                      reading: { ...reading, covered_count: 1, total_count: 2 },
                    },
                  ],
                  content_history: [
                    {
                      ...post,
                      reading: {
                        summary: "HISTORY_SHOULD_NOT_OVERRIDE",
                        covered_count: 1,
                        total_count: 2,
                      },
                    },
                    {
                      ...post,
                      id: "uncited",
                      text: "UNCITED_SHOULD_NOT_APPEAR",
                    },
                  ],
                  candidates: [],
                  missing: [],
                },
                work_text: "복사할 새 초안",
              },
            },
          ],
        };
        await r.fulfill({ json: { conversation_id: conversation.id } });
        return true;
      }
      if (path === "/api/conversations/chat-one") {
        await r.fulfill({ json: conversation });
        return true;
      }
    });
    await page
      .getByRole("heading", { name: "내 Instagram과 대화하기" })
      .waitFor();
    assert.equal(await page.locator("#growth-format").isVisible(), false);
    assert.equal(await page.locator("#growth-metrics").isVisible(), false);
    assert.equal(await page.locator(".growth-prompt-chip").count(), 5);
    assert.equal(await page.locator("#growth-welcome").isVisible(), true);
    await page
      .getByRole("button", {
        name: "다음엔 어떤 콘텐츠를 올릴까?",
        exact: true,
      })
      .click();
    assert.match(
      await page.locator("#growth-question").inputValue(),
      /다음에 올릴 콘텐츠/,
    );
    assert.equal(await page.locator("#growth-messages").textContent(), "");
    assert.equal(
      await page
        .locator("#growth-question")
        .evaluate((el) => el === document.activeElement),
      true,
    );

    await page.screenshot({ path: "/tmp/instagram-chat-welcome.png" });
    for (const [width, height] of [
      [360, 640],
      [390, 844],
      [721, 827],
      [768, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const send = await page.locator("#growth-chat-send").boundingBox();
      assert.ok(
        send.y + send.height <= height,
        `composer visible at ${width}x${height}`,
      );
      assert.ok(send.width >= 44 && send.height >= 44);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/instagram-chat-welcome-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 900 });
    const draft = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 200, 200);
      ctx.fillStyle = "black";
      ctx.fillText("Synthetic draft", 20, 40);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#growth-chat-files").setInputFiles(
      Array.from({ length: 10 }, (_, i) => ({
        name: i ? `draft-${i}.png` : "draft.png",
        mimeType: "image/png",
        buffer: Buffer.from(draft, "base64"),
      })),
    );
    await page.locator("#growth-attachments figure").last().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const attachmentSend = await page
      .locator("#growth-chat-send")
      .boundingBox();
    assert.ok(attachmentSend.y + attachmentSend.height <= 844);
    const thread = await page.locator(".growth-thread").boundingBox();
    assert.ok(thread.height >= 80, "ten attachments leave room for messages");
    for (let i = 0; i < 9; i++) {
      await page.locator("#growth-attachments button").last().click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .locator("#growth-question")
      .fill("이 초안과 기존 전기장 게시물을 비교해 줘");
    await page.locator("#growth-chat-send").click();
    try {
      await page
        .locator("#growth-messages .user")
        .getByText("이 초안과 기존 전기장 게시물을 비교해 줘", { exact: true })
        .waitFor();
      assert.equal(await page.locator("#growth-question").inputValue(), "");
      assert.equal(await page.locator("#growth-welcome").isVisible(), false);
      assert.equal(await page.locator("#growth-loading").isVisible(), true);
      await page.screenshot({ path: "/tmp/chat-sending.png" });
    } finally {
      releaseReading();
    }
    await page.getByText("초안을 비교했어요.", { exact: true }).waitFor();
    assert.equal(await page.locator("#growth-messages .user").count(), 1);
    assert.equal(reads.length, 1);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].images.length, 1);
    assert.ok(chats[0].images[0].base64);
    assert.equal("image_assets" in chats[0], false);
    assert.equal("reading_checked" in chats[0], false);
    assert.ok(chats[0].growth_options.post_ids.includes(post.id));
    await page.locator(".growth-message-sources > summary").click();
    await page.locator(".growth-source-card").first().waitFor();
    assert.equal(
      await page.locator(".growth-message-sources .growth-source-card").count(),
      1,
    );
    assert.doesNotMatch(
      await page.locator("#growth-messages").innerText(),
      /SHOULD_NOT/,
    );
    await page
      .locator("#view-growth")
      .getByText("본문 1/2장 확인", { exact: false })
      .first()
      .waitFor();
    await page
      .getByRole("button", { name: "GPT로 가져갈 내용 복사", exact: true })
      .click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /복사할 새 초안/);
    assert.match(copied, /https:\/\/www.instagram.com\/p\/example\//);
    assert.doesNotMatch(
      await page.evaluate(() =>
        localStorage.getItem("follower-growth:alice:session"),
      ),
      /base64/,
    );
    await page.reload();
    await page.getByText("초안을 비교했어요.", { exact: true }).waitFor();
    assert.equal(reads.length, 1);
    assert.equal(await page.locator("#growth-welcome").isVisible(), false);
    assert.equal(
      await page
        .locator("#growth-followup-prompts .growth-prompt-chip")
        .count(),
      5,
    );
    await page.screenshot({ path: "/tmp/instagram-chat-conversation.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const conversationArea = await page.locator(".growth-thread").boundingBox();
    assert.ok(
      conversationArea.height >= 380,
      "mobile conversation gets at least 380px",
    );
    const sendArea = await page.locator("#growth-chat-send").boundingBox();
    assert.ok(sendArea.y + sendArea.height <= 844, "send stays in view");
    await page.screenshot({
      path: "/tmp/instagram-chat-conversation-mobile.png",
    });
    await page.getByRole("button", { name: "새 대화", exact: true }).click();
    assert.equal(await page.locator("#growth-welcome").isVisible(), true);
    assert.equal(await page.locator("#growth-messages").textContent(), "");
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    assert.equal(await page.locator(".growth-source-card").count(), 0);
    assert.equal(await page.locator("#growth-attachments figure").count(), 0);
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem("follower-growth:alice:session"),
      ),
      null,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS chat body reading, images, sources, GPT copy, reload, mobile, logout",
    );
  }
  {
    let readId,
      readCalls = 0,
      chatCalls = 0,
      recoverCalls = 0;
    const { page, context } = await fixture(async (r, path) => {
      if (path === "/api/post-readings/select") {
        await r.fulfill({
          json: {
            candidates: [
              {
                post_id: post.id,
                title: post.text,
                cached: false,
                image_count: 2,
              },
            ],
          },
        });
        return true;
      }
      if (path === "/api/post-readings") {
        readCalls++;
        readId = r.request().postDataJSON().request_id;
        await r.fulfill({
          status: 503,
          json: { detail: "본문 저장 결과 확인 불가" },
        });
        return true;
      }
      if (path.startsWith("/api/post-readings/requests/")) {
        recoverCalls++;
        assert.ok(path.endsWith(readId));
        await r.fulfill({ json: { status: "pending" } });
        return true;
      }
      if (path === "/api/chat") {
        chatCalls++;
        await r.fulfill({ status: 503, json: { detail: "unexpected" } });
        return true;
      }
    });
    await page
      .locator("#growth-question")
      .fill("전기장 게시물에서 이어갈 주제");
    await page.locator("#growth-chat-send").click();
    await page.getByText("본문 저장 결과 확인 불가", { exact: true }).waitFor();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("follower-growth:alice:session")),
    );
    assert.equal(saved.readingPending.request_id, readId);
    assert.equal(chatCalls, 0);
    await page.reload();
    await page.getByText("합성 계정", { exact: true }).waitFor();
    await page.locator("#growth-chat-send").click();
    await page.getByText(/본문을 확인하는 중이에요/).waitFor();
    assert.equal(readCalls, 1);
    assert.equal(recoverCalls, 1);
    assert.equal(chatCalls, 0);
    assert.equal(await page.locator("#growth-question").inputValue(), "");
    assert.equal(await page.locator("#growth-messages .user").count(), 1);
    await context.close();
    console.log(
      "PASS ambiguous reading preserves UUID and recovers before any model retry",
    );
  }
  {
    let reads = 0;
    const { page, context } = await fixture(async (r, path) => {
      if (path === "/api/post-readings") {
        reads++;
        await r.fulfill({ json: envelope });
        return true;
      }
    });
    await page.getByRole("button", { name: "지난 게시", exact: true }).click();
    await page.getByRole("button", { name: "본문 읽기", exact: true }).click();
    await page.getByText("본문 1/2장 확인", { exact: false }).waitFor();
    assert.equal(reads, 1);
    await page
      .getByRole("button", { name: "이 게시물로 대화", exact: true })
      .click();
    await page
      .locator("#growth-selected-posts")
      .getByText(post.text, { exact: false })
      .waitFor();
    assert.equal(await page.locator("#growth-question").isVisible(), true);
    await context.close();
    console.log("PASS explicit body reading and selecting a post for chat");
  }
  {
    const chats = [];
    let statusChecks = 0;
    const { page, context } = await fixture(async (r, path) => {
      if (path === "/api/chat") {
        chats.push(r.request().postDataJSON());
        await r.fulfill({
          status: 503,
          json: { detail: "답변 저장 결과 확인 불가" },
        });
        return true;
      }
      if (path.startsWith("/api/chat/requests/")) {
        statusChecks++;
        assert.ok(path.endsWith(chats[0].request_id));
        await r.fulfill({ status: 404, json: { detail: "not found" } });
        return true;
      }
    });
    const draft = await page.evaluate(
      () =>
        document.createElement("canvas").toDataURL("image/png").split(",")[1],
    );
    await page.locator("#growth-chat-files").setInputFiles({
      name: "retry.png",
      mimeType: "image/png",
      buffer: Buffer.from(draft, "base64"),
    });
    await page.locator("#growth-attachments figure").waitFor();
    await page.locator("#growth-question").fill("이 초안을 다시 확인해줘");
    await page.locator("#growth-chat-send").click();
    await page.getByText("답변 저장 결과 확인 불가", { exact: true }).waitFor();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("follower-growth:alice:session")),
    );
    assert.equal(saved.pending.image_assets[0].name, "retry.png");
    assert.equal(JSON.stringify(saved).includes("base64"), false);
    await page.reload();
    await page.getByText("합성 계정", { exact: true }).waitFor();
    await page.locator("#growth-messages .user img").waitFor();
    assert.equal(await page.locator("#growth-question").inputValue(), "");
    assert.equal(await page.locator("#growth-messages .user").count(), 1);
    await page.locator("#growth-chat-send").click();
    await page.getByText("답변 저장 결과 확인 불가", { exact: true }).waitFor();
    assert.equal(statusChecks, 1);
    assert.equal(chats.length, 2);
    assert.deepEqual(chats[1], chats[0]);
    await context.close();
    console.log(
      "PASS ambiguous chat keeps exact UUID and transient image bytes across reload",
    );
  }
  {
    let chatCalls = 0;
    const { page, context } = await fixture(async (r, path) => {
      if (path === "/api/post-readings/select") {
        await r.fulfill({
          json: {
            candidates: [{ post_id: post.id, cached: false, image_count: 2 }],
          },
        });
        return true;
      }
      if (path === "/api/post-readings") {
        await r.fulfill({ status: 422, json: { detail: "image unavailable" } });
        return true;
      }
      if (path === "/api/chat") {
        chatCalls++;
        await r.fulfill({
          status: 422,
          json: { detail: "합성 입력 오류 · 초안 유지" },
        });
        return true;
      }
    });
    await page.locator("#growth-question").fill("이 게시물에서 재활용할 부분");
    await page.locator("#growth-chat-send").click();
    await page
      .getByText("합성 입력 오류 · 초안 유지", { exact: true })
      .waitFor();
    assert.equal(chatCalls, 1);
    assert.equal(
      await page.locator("#growth-question").inputValue(),
      "이 게시물에서 재활용할 부분",
    );
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("follower-growth:alice:session")),
    );
    assert.equal(saved.pending, null);
    assert.equal(saved.readingPending, null);
    await context.close();
    console.log(
      "PASS unreadable source falls back to captions and validation errors keep the question",
    );
  }
  {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { page, context, errors } = await fixture(async (r, path) => {
      if (path === "/api/post-readings/select") {
        await r.fulfill({
          json: {
            candidates: [{ post_id: post.id, cached: false, image_count: 2 }],
          },
        });
        return true;
      }
      if (path === "/api/post-readings") {
        await gate;
        await r.fulfill({ json: envelope });
        return true;
      }
    });
    await page
      .locator("#growth-question")
      .fill("로그아웃 후 이전 자료가 보이면 안 돼");
    const readingStarted = page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/post-readings",
    );
    await page.locator("#growth-chat-send").click();
    await readingStarted;
    await page.evaluate(() => window.testSession(null));
    release();
    await page
      .getByRole("button", { name: "Google 로그인", exact: true })
      .waitFor();
    assert.equal(await page.locator("#growth-selected-posts").innerText(), "");
    assert.equal(await page.locator("#growth-question").inputValue(), "");
    assert.equal(await page.locator("#growth-attachments").innerText(), "");
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem("follower-growth:alice:session"),
      ),
      null,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS late reading response cannot restore previous owner data after logout",
    );
  }
} finally {
  await browser.close();
}
