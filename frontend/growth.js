import { prepareFile, putImages, getImage } from "./review-images.js";

const names = {
  carousel: "카드뉴스",
  reel: "릴스",
  post: "단일 게시물",
  story: "스토리",
};
const num = (v) =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const time = (value, zone = "Asia/Seoul") =>
  value
    ? new Date(value).toLocaleString("ko-KR", {
        timeZone: zone,
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "아직 없음";
const link = (label, url) => {
  const a = node("a", label, "growth-link");
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && !u.username && !u.password) {
      a.href = u.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  } catch {}
  return a;
};

export function mountGrowth(root, { api, getUser, notice, show, loadData }) {
  const past = document.querySelector("#growth-posts-root");
  root.innerHTML = `<header class="growth-heading growth-chat-heading"><div><span class="eyebrow">INSTAGRAM MEMORY</span><h1>내 Instagram과 대화하기</h1></div><div class="growth-header-actions"><button id="growth-sync" class="secondary">Buffer 새로 불러오기</button><button id="growth-new-chat" class="secondary">새 대화</button></div></header>
 <div class="growth-connection"><details class="growth-account-details"><summary><strong id="growth-account">내 계정 연결</strong><span>연결 자료와 성과 요약</span></summary><dl class="growth-freshness"><div><dt>마지막으로 가져온 시각</dt><dd id="growth-sync-state">로그인 후 확인할 수 있어요.</dd></div><div><dt>최신 게시일</dt><dd id="growth-source-state">—</dd></div><div><dt>성과가 갱신된 시각</dt><dd id="growth-metric-state">—</dd></div></dl><p id="growth-freshness-note" class="growth-source-note"></p><section class="growth-metrics" id="growth-metrics"></section></details><button id="growth-sync-recover" class="text-button" hidden>동기화 상태 확인</button></div>
 <section class="growth-chat" aria-label="Instagram 채팅">
   <div class="growth-thread">
     <div id="growth-welcome" class="growth-welcome"><span class="growth-welcome-icon" aria-hidden="true">✳</span><h2>어떤 콘텐츠를 함께 만들어볼까요?</h2><p>내 게시물을 바탕으로 찾고, 비교하고, 다음 아이디어로 이어가세요.</p><div id="growth-welcome-prompts"></div></div>
     <div id="growth-messages" aria-live="polite"></div>
     <p id="growth-loading" role="status" hidden>관련 게시물을 확인하고 있어요…</p>
   </div>
   <div class="growth-composer-area"><div id="growth-followup-prompts"></div><form id="growth-chat-form"><div id="growth-selected-posts" class="growth-selected-posts"></div><div id="growth-attachments" class="growth-attachments"></div><label class="growth-question-label"><span class="growth-visually-hidden">질문</span><textarea id="growth-question" maxlength="4000" rows="2" placeholder="내 Instagram에 대해 물어보세요" required></textarea></label><div class="growth-chat-actions"><label class="growth-attach-button secondary">초안 이미지 첨부<input id="growth-chat-files" type="file" accept="image/png,image/jpeg,image/webp" multiple /></label><button id="growth-browse-posts" type="button" class="secondary">게시물 선택</button><button id="growth-chat-send" class="primary" aria-label="AI에게 물어보기" title="보내기"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button><button id="growth-chat-recover" type="button" class="secondary" hidden>답변 저장 상태 확인</button><button id="growth-reading-recover" type="button" class="secondary" hidden>본문 읽기 상태 확인</button></div></form><small id="growth-gpt-state" class="growth-chat-help">내 게시물과 초안 이미지로 대화해 보세요.</small></div>
 </section>
 <details id="growth-timing" class="growth-timing"><summary>게시 시간 비교 (선택)</summary><p class="muted">콘텐츠를 정한 뒤, 내가 올릴 수 있는 시간끼리 비교해요. 콘텐츠 주제 추천과는 별도예요.</p><div class="growth-content-options"><label>형식<select id="growth-format"><option value="carousel">카드뉴스</option><option value="reel">릴스</option><option value="post">단일 게시물</option><option value="story">스토리</option></select></label><label>관심 주제<input id="growth-topic" maxlength="300" /></label></div><div class="growth-workspace"><section class="card growth-planner"><span class="eyebrow">시간 비교</span><h2>언제 올릴지 비교하기</h2><label>비교 기준<select id="growth-observation"><option value="lifetime">현재 누적 성과 · 탐색용</option><option value="seven_day">실제 7일차 부근 관측</option></select></label><label>내가 올릴 수 있는 시간<input id="growth-slot" type="datetime-local" /></label><small id="growth-timezone">계정 시간대: Asia/Seoul · 입력은 내 기기 시간 기준</small><button id="growth-add-slot" class="secondary">가능한 시간 추가</button><div id="growth-slots" class="growth-slots"></div><details><summary>Buffer에 설정된 일정 확인</summary><div id="growth-schedule" class="growth-slots"></div><small>눌러 추가한 시간만 추천 후보에 포함해요.</small></details><button id="growth-preview" class="primary">시간 후보 확인</button><p class="muted">통계와 후보 확인에는 AI를 호출하지 않아요.</p></section>
 <section class="card growth-advice"><span class="eyebrow">후보와 이유</span><h2>왜 이 시간인가요?</h2><div id="growth-recommendation"><p class="growth-empty">가능한 시간을 고르면 내 기록과 비교한 후보가 여기에 표시돼요.</p></div><div id="growth-evidence"></div><details class="growth-limitations"><summary>이 추천이 알 수 있는 범위</summary><p>팔로우 지표가 없는 게시물은 성장 효과를 판단하지 않아요. 누적 성과는 게시 후 경과 시간이 달라요. 시간별 차이가 원인을 증명하거나 팔로워 증가를 보장하지는 않아요.</p></details></section></div>
</details>
  <details class="card growth-daily"><summary id="growth-daily-label">과거 계정 일별 기록</summary><div class="section-top"><div><h2>보관된 일별 팔로우</h2><p id="growth-daily-summary" class="muted">저장된 일별 데이터의 기간·개수·추세를 표시해요.</p></div><button id="growth-data-open" class="text-button">데이터 관리 →</button></div><div id="growth-chart"></div><p id="growth-daily-freshness" hidden></p><small>M1-1에서 가져온 일별 기록이에요.</small></details>
`;
  past.innerHTML = `<header class="growth-heading"><div><span class="eyebrow">LEARN FROM YOUR POSTS</span><h1>지난 게시</h1></div></header><details class="growth-experiments-panel"><summary>게시 실험</summary><div id="growth-experiments"></div></details><section class="growth-post-section"><div class="section-top"><h2>불러온 게시물</h2><label>형식 필터<select id="growth-post-filter"><option value="">전체 형식</option><option value="carousel">카드뉴스</option><option value="reel">릴스</option><option value="post">단일 게시물</option><option value="story">스토리</option></select></label></div><p id="growth-post-count" class="muted"></p><div id="growth-post-list" class="growth-post-grid"></div><button id="growth-more-posts" class="secondary" hidden>게시물 더 보기</button></section>`;
  const $ = (s) => document.querySelector(s);
  let epoch = 0,
    user = null,
    busy = false,
    status = null,
    posts = [],
    experiments = [],
    slots = [],
    recommendation = null,
    cid = null,
    pending = null,
    syncPending = null,
    nextOffset = null,
    readingPending = null,
    selectedPosts = [],
    imageAssets = [],
    readings = new Map();
  const previewURLs = new Set();
  const key = () => `follower-growth:${user?.uid}:session`;
  function persist() {
    if (user)
      localStorage.setItem(
        key(),
        JSON.stringify({
          cid,
          pending,
          syncPending,
          readingPending,
          selectedPosts,
          imageAssets,
          draft: $("#growth-question").value,
        }),
      );
  }
  function same(e) {
    return epoch === e && user === getUser();
  }
  async function request(path, opts) {
    const e = epoch;
    try {
      const value = await api(path, opts);
      if (!same(e))
        throw new Error("로그인 상태가 바뀌었어요. 다시 시작하세요.");
      return value;
    } catch (error) {
      if (!same(e))
        throw new Error("로그인 상태가 바뀌었어요. 다시 시작하세요.");
      throw error;
    }
  }
  function action(label, fn, cls = "secondary") {
    const b = node("button", label, cls);
    b.type = "button";
    b.onclick = () => run(fn);
    return b;
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    const e = epoch;
    const controls = [
      ...root.querySelectorAll("button,input,select,textarea"),
      ...past.querySelectorAll("button,input,select,textarea"),
      $("#growth-data-sync"),
    ].map((n) => [n, n.disabled]);
    controls.forEach(([n]) => (n.disabled = true));
    try {
      await fn();
    } catch (error) {
      if (same(e)) notice(error.message, true);
    } finally {
      if (same(e)) {
        busy = false;
        controls.forEach(([n, d]) => (n.disabled = d));
        $("#growth-chat-send").disabled = !user || !status?.chat_configured;
        $("#growth-chat-recover").hidden = !pending;
        $("#growth-sync-recover").hidden = !syncPending;
        $("#growth-reading-recover").hidden = !readingPending;
        $("#growth-loading").hidden = true;
        $("#growth-question").disabled = !user || !!pending;
        $("#growth-chat-files").disabled = !user || !!pending;
      }
    }
  }
  function revokePreviews() {
    for (const url of previewURLs) URL.revokeObjectURL(url);
    previewURLs.clear();
  }
  async function imagePreview(meta, parent, e = epoch) {
    const asset = await getImage(user?.uid, meta.sha256);
    if (!same(e) || !parent.isConnected || !asset?.blob) return;
    const url = URL.createObjectURL(asset.blob);
    previewURLs.add(url);
    const img = node("img");
    img.src = url;
    img.alt = meta.name;
    parent.prepend(img);
  }
  function renderAttachments() {
    const box = $("#growth-attachments");
    for (const image of box.querySelectorAll("img")) {
      URL.revokeObjectURL(image.src);
      previewURLs.delete(image.src);
    }
    box.replaceChildren();
    for (const meta of imageAssets) {
      const figure = node("figure");
      figure.append(
        node("figcaption", meta.name),
        action(
          "첨부 제거",
          () => {
            if (pending) throw new Error("먼저 답변 저장 상태를 확인하세요.");
            imageAssets = imageAssets.filter((a) => a.card_id !== meta.card_id);
            persist();
            renderAttachments();
          },
          "text-button",
        ),
      );
      box.append(figure);
      const e = epoch;
      imagePreview(meta, figure, e).catch((error) => {
        if (same(e)) notice(error.message, true);
      });
    }
  }
  function renderSelection() {
    $("#growth-selected-posts").replaceChildren(
      ...selectedPosts.map((p) =>
        action(
          `${p.title} ×`,
          () => {
            if (pending) throw new Error("먼저 답변 저장 상태를 확인하세요.");
            selectedPosts = selectedPosts.filter(
              (selected) => selected.post_id !== p.post_id,
            );
            persist();
            renderSelection();
          },
          "growth-selected-post secondary",
        ),
      ),
    );
  }
  function sourcePosts(result) {
    const evidence = result?.growth?.evidence || [];
    const byId = new Map(
      [...(result?.growth?.content_history || []), ...evidence].map((p) => [
        p.id || p.post_id,
        p,
      ]),
    );
    const cited = [
      ...new Set([
        ...(result?.source_ids || []),
        ...(result?.ideas || []).flatMap((idea) => idea.source_ids || []),
      ]),
    ];
    return cited.length
      ? cited.map((id) => byId.get(id)).filter(Boolean)
      : evidence;
  }
  function sourceCard(source) {
    const card = node("article", undefined, "growth-source-card");
    const envelope = source.reading;
    const body = envelope?.reading || envelope;
    const preview = source.preview_url;
    if (preview) {
      try {
        const url = new URL(preview);
        if (url.protocol === "https:" && !url.username && !url.password) {
          const image = node("img");
          image.src = url.href;
          image.alt = "참고 게시물 미리보기";
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
          image.onerror = () => image.remove();
          card.append(image);
        }
      } catch {}
    }
    const detail = node("div");
    detail.append(
      link(
        body?.title ||
          (source.text || source.caption_excerpt || "참고 게시물").slice(
            0,
            100,
          ),
        source.external_link,
      ),
    );
    detail.append(
      node(
        "small",
        body?.summary && envelope?.covered_count !== undefined
          ? `본문 ${envelope.covered_count ?? body.pages?.length}/${envelope.total_count ?? body.pages?.length}장 확인 · 확인한 장면만 참고`
          : `캡션 일부 참고 · 이미지 본문 미확인${source.metrics ? "" : " · 성과 수치 미포함"}`,
      ),
    );
    if (body?.summary) detail.append(node("p", body.summary));
    card.append(detail);
    return card;
  }
  function appendMessage(role, text, result, images = []) {
    const item = node("article", undefined, `growth-message ${role}`);
    item.append(
      node("small", role === "user" ? "나" : "Instagram 비서"),
      node("p", text),
    );
    if (images.length) {
      const attachments = node(
        "div",
        undefined,
        "growth-attachments growth-message-images",
      );
      for (const meta of images) {
        const figure = node("figure");
        figure.append(node("figcaption", meta.name || "첨부 이미지"));
        attachments.append(figure);
        imagePreview(meta, figure).catch(() => {});
      }
      item.append(attachments);
    }
    for (const [i, idea] of (result?.ideas || []).entries()) {
      const card = node("section", undefined, "growth-content-idea");
      card.append(node("h3", `${i + 1}. ${idea.title}`));
      for (const [label, value] of [
        ["왜 추천하냐면", idea.reason],
        ["기존 게시물에서 바꿀 점", idea.relationship],
        ["이렇게 만들어요", idea.objective],
      ])
        card.append(node("h4", label), node("p", value));
      for (const id of idea.source_ids || []) {
        const source = sourcePosts(result).find((p) => p.id === id);
        if (!source) continue;
        const ref = node("div", undefined, "growth-idea-source");
        ref.append(
          link(
            `참고: ${source.reading?.title || source.reading?.reading?.title || source.text || source.caption_excerpt || "게시물"}`.slice(
              0,
              100,
            ),
            source.external_link,
          ),
        );
        card.append(ref);
      }
      if (!idea.source_ids?.length)
        card.append(node("small", "새 기획 제안 · 연결된 참고 게시물 없음"));
      item.append(card);
    }
    const sources = sourcePosts(result);
    if (sources.length) {
      const details = node("details", undefined, "growth-message-sources");
      details.append(node("summary", `참고한 게시물 ${sources.length}개`));
      details.append(...sources.map(sourceCard));
      item.append(details);
    }
    if (result?.work_text) {
      const work = node("details", undefined, "growth-work-text");
      work.open = true;
      work.append(node("summary", "작업 결과"), node("p", result.work_text));
      item.append(work);
    }
    if (role === "assistant") {
      const copy = node(
        "button",
        "GPT로 가져갈 내용 복사",
        "secondary growth-copy",
      );
      copy.type = "button";
      copy.onclick = async () => {
        const e = epoch;
        const refs = sources.map((p) => {
          const body = p.reading?.reading || p.reading;
          return `${body?.title || p.text || p.caption_excerpt || p.id}\n${p.external_link || ""}${body?.summary ? `\n확인한 본문: ${body.summary}` : "\n캡션 참고 · 본문 미확인"}`;
        });
        try {
          await navigator.clipboard.writeText(
            [
              result?.work_text || text,
              refs.length ? `참고 게시물\n${refs.join("\n\n")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
          if (same(e))
            notice("초안과 참고 게시물 링크를 복사했어요. GPT에 붙여넣으세요.");
        } catch {
          if (same(e))
            notice(
              "복사를 허용하거나 위 초안을 직접 선택해 복사해 주세요.",
              true,
            );
        }
      };
      item.append(copy);
    }
    $("#growth-messages").append(item);
    updateChatMode();
    requestAnimationFrame(() => {
      const thread = root.querySelector(".growth-thread");
      thread.scrollTop = thread.scrollHeight;
    });
  }
  function renderSlots() {
    const box = $("#growth-slots");
    box.replaceChildren();
    for (const slot of slots)
      box.append(
        action(`${time(slot, status?.channel?.timezone)} ×`, () => {
          slots = slots.filter((s) => s !== slot);
          renderSlots();
        }),
      );
  }
  function addSlot(value) {
    if (
      !value ||
      new Date(value) <= new Date() ||
      new Date(value) > new Date(Date.now() + 7 * 86400000)
    )
      throw new Error("지금부터 7일 이내의 가능한 시간을 선택하세요.");
    if (slots.length >= 14) throw new Error("가능한 시간은 최대 14개예요.");
    slots = [...new Set([...slots, new Date(value).toISOString()])];
    renderSlots();
  }
  function options() {
    return {
      format: $("#growth-format").value,
      topic: $("#growth-topic").value.trim(),
      slots,
      observation_mode: $("#growth-observation").value,
      post_ids: selectedPosts.map((p) => p.post_id),
    };
  }
  function renderStatus(summary) {
    const s = status;
    $("#growth-account").textContent =
      s?.channel?.name || "Buffer 계정을 연결해 주세요";
    $("#growth-sync-state").textContent = s?.last_success_at
      ? `가져옴 ${time(s.last_success_at)}${s.last_error ? ` · 최근 시도 실패 (${s.last_error}) · 이전 자료 표시 중` : ""}`
      : "Buffer 자료를 불러와 주세요.";
    $("#growth-source-state").textContent = time(s?.period?.end);
    $("#growth-metric-state").textContent = s?.latest_metrics_at
      ? `${time(s.latest_metrics_at)} (가장 최근)`
      : "Buffer에서 갱신 시각을 제공하지 않았어요";
    $("#growth-freshness-note").textContent = s?.oldest_metrics_at
      ? `게시물별 성과 갱신: ${time(s.oldest_metrics_at)} ~ ${time(s.latest_metrics_at)}`
      : "";
    $("#growth-gpt-state").textContent = s?.chat_configured
      ? "내 게시물을 바탕으로 답해요 · 초안 이미지 최대 10장"
      : "AI 연결을 확인해 주세요. 불러온 게시물과 데이터는 계속 확인할 수 있어요.";
    $("#growth-chat-send").disabled = !user || !s?.chat_configured;
    $("#growth-timezone").textContent =
      `계정 시간대: ${s?.channel?.timezone || "Asia/Seoul"} · 입력은 내 기기 시간 기준`;
    const data = [
      ["수집 게시물", s?.count ?? 0, "Buffer에서 불러온 게시 완료 자료"],
      [
        "팔로우 지표 제공 게시물",
        s?.follows_count ?? 0,
        "팔로우 수치 수집된 게시물",
      ],
      [
        "카드뉴스 팔로우 전환 중앙값",
        summary?.formats?.carousel?.median_conversion === null
          ? "—"
          : `${num(summary?.formats?.carousel?.median_conversion)}%`,
        "팔로우 ÷ 도달",
      ],
    ];
    $("#growth-metrics").replaceChildren(
      ...data.map(([label, v, help]) => {
        const a = node("article");
        a.append(
          node("span", label),
          node("strong", String(v)),
          node("small", help),
        );
        return a;
      }),
    );
    const source = $("#growth-data-status");
    source.replaceChildren();
    for (const [label, value] of [
      ["게시물", `${num(s?.count)}개`],
      ["최근 조회", time(s?.last_success_at)],
      ["최신 게시", time(s?.period?.end)],
    ]) {
      const item = node("div");
      item.append(node("span", label), node("strong", value));
      source.append(item);
    }
    const schedule = $("#growth-schedule");
    schedule.replaceChildren();
    const days = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
    for (const d of s?.channel?.postingSchedule || []) {
      if (d.paused) continue;
      for (const t of d.times) {
        const zone = s.channel.timezone; // Explicitly supported schedule conversion; arbitrary zones use manual input.
        if (zone !== "Asia/Seoul") {
          schedule.append(
            node(
              "small",
              `${d.day} ${t} (${zone}) · 가능한 시간에 직접 입력하세요.`,
            ),
          );
          continue;
        }
        const today = new Date(
          new Date().toLocaleString("en-US", { timeZone: zone }),
        );
        const date = new Date(
          Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
        );
        let offset = (days[d.day] - date.getUTCDay() + 7) % 7;
        date.setUTCDate(date.getUTCDate() + offset);
        let value = `${date.toISOString().slice(0, 10)}T${t}:00+09:00`;
        if (new Date(value) <= new Date()) {
          date.setUTCDate(date.getUTCDate() + 7);
          value = `${date.toISOString().slice(0, 10)}T${t}:00+09:00`;
        }
        if (new Date(value) <= new Date(Date.now() + 7 * 86400000))
          schedule.append(
            action(`${time(value, zone)} 추가`, () => addSlot(value)),
          );
      }
    }
    if (!schedule.children.length)
      schedule.append(
        node(
          "p",
          "설정된 다음 7일 일정이 없어요. 가능한 시간을 직접 추가하세요.",
          "muted",
        ),
      );
  }
  function renderLiveData(items) {
    const rows = items.map((p) => {
      const row = node("tr");
      const caption = node("td");
      caption.append(
        link(p.text.slice(0, 100) || "게시물 보기", p.external_link),
      );
      row.append(node("td", time(p.sent_at)), caption);
      for (const key of ["follows", "reach", "views"])
        row.append(node("td", num(p.metrics[key])));
      return row;
    });
    if (!rows.length) {
      const row = node("tr"),
        cell = node("td", "불러온 게시물이 없어요.");
      cell.colSpan = 5;
      row.append(cell);
      rows.push(row);
    }
    $("#growth-live-data").replaceChildren(...rows);
  }
  function renderDaily(records, summary) {
    const values = records
      .filter((r) => r.value !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const m = summary?.metrics?.follows;
    $("#growth-daily-label").textContent = values.length
      ? `과거 계정 일별 기록 · ${values.at(-1).date}까지`
      : "과거 계정 일별 기록 · 보관된 자료 없음";
    $("#growth-daily-freshness").textContent = values.length
      ? `마지막 유효 기록은 ${values.at(-1).date}예요. 위 Buffer 게시물 자료의 최신 날짜와는 달라요.`
      : "보관한 기록이 생기면 이곳에서 확인할 수 있어요.";
    $("#growth-daily-summary").textContent = values.length
      ? `${values[0].date} ~ ${values.at(-1).date} · ${values.length}개 유효 관측 · 마지막 요약 기간 평균 ${num(m?.average)} · ${{ up: "증가", down: "감소", stable: "유지", insufficient_data: "이전 기간 비교 자료 부족" }[m?.trend] || "비교 자료 부족"}`
      : "별도로 보관한 계정 일별 기록이 없어요. Buffer 게시물별 성과는 새로 불러오기로 확인할 수 있어요.";
    const chart = $("#growth-chart");
    chart.replaceChildren();
    if (values.length < 2) return;
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 900 115");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      `일별 팔로우 추이, ${values.length}개 관측. 최소 ${Math.min(...values.map((r) => r.value))}, 최대 ${Math.max(...values.map((r) => r.value))}`,
    );
    const max = Math.max(1, ...values.map((r) => r.value));
    const start = new Date(values[0].date).getTime(),
      span = Math.max(1, new Date(values.at(-1).date) - start);
    const points = values
      .map(
        (r) =>
          `${10 + ((new Date(r.date) - start) / span) * 880},${100 - (r.value / max) * 85}`,
      )
      .join(" ");
    const poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", points);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "currentColor");
    poly.setAttribute("stroke-width", "2.5");
    svg.append(poly);
    chart.append(svg);
  }
  function renderRecommendation(r) {
    recommendation = r;
    const box = $("#growth-recommendation");
    box.replaceChildren();
    const stat = r.summary.formats[r.format];
    box.append(
      node(
        "p",
        `${names[r.format]} ${stat.count}개 · 전환율 유효 ${stat.conversion_count}개 · ${r.observation_mode === "seven_day" ? "실제 7일차 부근 관측" : "현재 누적 성과·탐색용"}`,
        "muted",
      ),
    );
    for (const reason of r.missing)
      box.append(node("p", reason, "growth-warning"));
    for (const c of r.candidates) {
      const item = node("article", undefined, "growth-candidate");
      item.append(
        node(
          "span",
          c.kind === "experiment" ? "새 실험" : "관측 패턴 참고",
          "tag",
        ),
        node("h3", time(c.at, r.timezone)),
        node("p", c.reason),
      );
      if (c.sample_count)
        item.append(
          node(
            "small",
            `비교 ${c.sample_count}개 · 전환 중앙값 ${num(c.median_conversion)}%`,
          ),
        );
      item.append(
        action("이 시간으로 실험 저장", async () => {
          await request("/api/growth/experiments", {
            method: "POST",
            body: { request_id: r.request_id, candidate_id: c.id },
          });
          await loadExperiments();
          notice(
            "게시 실험을 저장했어요. 게시 후 지난 게시에서 실제 글을 연결하세요.",
          );
        }),
      );
      box.append(item);
    }
    const evidence = $("#growth-evidence");
    evidence.replaceChildren();
    const compared = r.time_evidence || r.evidence;
    if (r.candidates.length && compared.length)
      evidence.append(
        node("h3", "후보 시간대의 비교 게시물 · 시간대당 최대 5개"),
      );
    for (const p of r.candidates.length ? compared : []) {
      const item = node("article", undefined, "growth-evidence-item");
      item.append(
        link(p.text.slice(0, 95) || "캡션 없는 게시물", p.external_link),
        node(
          "small",
          `${time(p.sent_at, r.timezone)} · 팔로우 ${num(p.metrics?.follows)} · 도달 ${num(p.metrics?.reach)}`,
        ),
        node("small", `지표 갱신 ${time(p.metrics_updated_at, r.timezone)}`),
      );
      evidence.append(item);
    }
  }
  let annotationDrafts = new Map();
  function postCard(original) {
    const p = {
      ...original,
      annotation: annotationDrafts.get(original.id) || original.annotation,
    };
    const card = node("article", undefined, "growth-post card");
    const media = node("div", names[p.format] || "게시물", "growth-post-media");
    const asset = p.assets?.find(
      (a) => a.thumbnail || a.mime_type?.startsWith("image/"),
    );
    const imageUrl = asset?.thumbnail || asset?.source;
    if (imageUrl) {
      const image = node("img");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => image.remove();
      media.append(image);
    }
    const content = node("div", undefined, "growth-post-content");
    const header = node("header", undefined, "growth-post-header");
    header.append(
      node("span", names[p.format] || "게시물", "tag"),
      node("time", time(p.sent_at)),
    );
    content.append(header, node("h3", p.text || "캡션 없는 게시물"));
    const metrics = node("div", undefined, "growth-post-metrics");
    for (const [key, label] of [
      ["follows", "팔로우"],
      ["reach", "도달"],
      ["views", "조회"],
      ["saves", "저장"],
      ["shares", "공유"],
    ]) {
      const metric = node("div");
      metric.append(node("span", label), node("strong", num(p.metrics[key])));
      metrics.append(metric);
    }
    const footer = node("div", undefined, "growth-post-footer");
    footer.append(
      link("Instagram에서 보기 ↗", p.external_link),
      node("small", `성과 갱신 ${time(p.metrics_updated_at)}`),
    );
    const details = node("details", undefined, "growth-post-note");
    details.append(node("summary", "메모"));
    details.open = annotationDrafts.has(p.id);
    const tags = node("input");
    tags.placeholder = "쉼표로 구분";
    tags.value = (p.annotation?.tags || []).join(", ");
    const memo = node("textarea");
    memo.maxLength = 2000;
    memo.rows = 2;
    memo.value = p.annotation?.memo || "";
    const captureDraft = () =>
      annotationDrafts.set(p.id, {
        ...p.annotation,
        tags: tags.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        memo: memo.value,
      });
    for (const input of [tags, memo])
      input.addEventListener("input", captureDraft);
    for (const [label, input] of [
      ["분류 태그", tags],
      ["메모", memo],
    ]) {
      const field = node("label", label);
      field.append(input);
      details.append(field);
    }
    details.append(
      action("메모 저장", async () => {
        await request(
          `/api/buffer/posts/${encodeURIComponent(p.id)}/annotation`,
          {
            method: "PUT",
            body: {
              tags: tags.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              memo: memo.value,
              manual_follows: p.annotation?.manual_follows ?? null,
            },
          },
        );
        notice("메모를 저장했어요.");
        annotationDrafts.delete(p.id);
        await loadPosts(true);
      }),
    );
    const actions = node("div", undefined, "growth-post-actions");
    const read = action("본문 읽기", () => readPost(p.id));
    const use = node("button", "이 게시물로 대화", "secondary");
    use.type = "button";
    use.onclick = () => {
      if (busy) return;
      if (pending) return notice("먼저 답변 저장 상태를 확인하세요.", true);
      if (!selectedPosts.some((selected) => selected.post_id === p.id)) {
        if (selectedPosts.length >= 5)
          return notice("게시물은 최대 5개까지 골라 주세요.", true);
        selectedPosts.push({
          post_id: p.id,
          title: (p.text || "캡션 없는 게시물").slice(0, 80),
        });
      }
      persist();
      renderSelection();
      show("growth");
      $("#growth-question").focus();
    };
    actions.append(read, use);
    const cached = readings.get(p.id) || p.reading;
    const cachedBody = cached?.reading || cached;
    if (cachedBody?.summary) {
      actions.append(
        node(
          "small",
          `본문 ${cached.covered_count}/${cached.total_count}장 확인 · ${cachedBody.summary}`,
        ),
      );
      read.textContent = "읽은 본문 확인";
    }
    const stats = node("details", undefined, "growth-post-stats");
    stats.append(node("summary", "게시물 성과"), metrics);
    content.append(actions, stats, footer, details);
    card.append(media, content);
    return card;
  }
  async function loadPosts(reset = true) {
    const data = await request(
      `/api/buffer/posts?status=sent&limit=30&offset=${reset ? 0 : nextOffset || 0}${$("#growth-post-filter").value ? `&format=${$("#growth-post-filter").value}` : ""}`,
    );
    posts = reset ? data.items : [...posts, ...data.items];
    nextOffset = data.next_offset;
    $("#growth-post-count").textContent =
      `${data.total}개 게시물 · ${posts.length}개 표시`;
    $("#growth-post-list").replaceChildren(...posts.map(postCard));
    $("#growth-more-posts").hidden = nextOffset === null;
  }
  function renderExperiments() {
    const box = $("#growth-experiments");
    box.replaceChildren();
    if (!experiments.length)
      box.append(
        node(
          "p",
          "아직 실험이 없어요. 다음 게시에서 시간 후보를 저장하세요.",
          "muted",
        ),
      );
    const labels = {
      planned: "게시 대기",
      linked: "게시물 연결됨",
      awaiting_observation: "비교 관측 기다리는 중",
      observed: "7일차 부근 관측 확보",
      cancelled: "취소됨",
    };
    for (const e of experiments) {
      const card = node("article", undefined, "growth-experiment");
      card.append(
        node("span", labels[e.status], "tag"),
        node("h3", `${e.topic || "주제 미지정"} · ${names[e.format]}`),
        node("p", `선택한 시간 ${time(e.candidate.at, e.baseline.timezone)}`),
      );
      if (e.post_id)
        card.append(
          node(
            "p",
            `${e.deviated ? "계획과 다른 시간" : "계획한 시간 부근"} · 실제 게시 ${time(e.actual_sent_at)} · 차이 ${num(e.time_difference_minutes)}분`,
          ),
        );
      if (e.observation_message) card.append(node("p", e.observation_message));
      if (e.observed_metrics)
        card.append(
          node(
            "p",
            `관측 팔로우 ${num(e.observed_metrics.follows)} · 전환율 ${num(e.observed_conversion)}%`,
          ),
        );
      if (e.status !== "cancelled") {
        const select = node("select");
        select.setAttribute("aria-label", "연결할 실제 게시물");
        select.append(new Option("실제 게시 완료 글을 선택하세요", ""));
        for (const p of posts.filter(
          (p) => p.format === e.format && p.status === "sent",
        ))
          select.append(
            new Option(`${time(p.sent_at)} · ${p.text.slice(0, 35)}`, p.id),
          );
        select.value = e.post_id || "";
        card.append(
          select,
          action("게시물 연결", async () => {
            if (!select.value) throw new Error("실제 게시물을 선택하세요.");
            await request(`/api/growth/experiments/${e.id}`, {
              method: "PUT",
              body: { post_id: select.value, memo: e.memo || "" },
            });
            await loadExperiments();
          }),
          action(
            "실험 취소",
            async () => {
              await request(`/api/growth/experiments/${e.id}`, {
                method: "PUT",
                body: { cancelled: true, memo: e.memo || "" },
              });
              await loadExperiments();
            },
            "text-button",
          ),
        );
      }
      box.append(card);
    }
  }
  async function loadExperiments() {
    experiments = await request("/api/growth/experiments");
    renderExperiments();
  }
  async function refresh() {
    if (!user) return;
    const refreshEpoch = epoch;
    const results = await Promise.allSettled([
      request("/api/buffer/status"),
      request("/api/growth/summary"),
      request("/api/buffer/posts?status=sent&limit=10"),
    ]);
    if (!same(refreshEpoch)) return;
    if (results[0].status === "fulfilled") {
      status = results[0].value;
      renderStatus(results[1].status === "fulfilled" ? results[1].value : null);
      await loadPosts();
      if (!same(refreshEpoch)) return;
      await loadExperiments();
      if (!same(refreshEpoch)) return;
    } else {
      $("#growth-sync-state").textContent = results[0].reason.message;
      $("#growth-gpt-state").textContent = results[0].reason.message;
    }
    if (results[2].status === "fulfilled")
      renderLiveData(results[2].value.items);
    else
      $("#growth-live-data").replaceChildren(
        node("tr", "게시물 조회에 실패했어요. 다시 갱신해 주세요."),
      );
  }
  async function recoverSync() {
    if (!syncPending) return;
    try {
      const result = await request(`/api/buffer/sync/${syncPending}`);
      if (result.status === "done" || result.status === "failed") {
        syncPending = null;
        persist();
        await refresh();
        notice(
          result.status === "done"
            ? "동기화 완료를 확인했어요."
            : "동기화가 실패했어요. 이전 자료를 유지하며 새로 불러오기를 다시 사용할 수 있어요.",
        );
      } else notice("동기화가 진행 중이에요. 잠시 후 상태를 확인하세요.");
    } catch (e) {
      if (e.status === 404) {
        await request("/api/buffer/sync", {
          method: "POST",
          body: { request_id: syncPending, force: true },
        });
        syncPending = null;
        persist();
        await refresh();
      } else throw e;
    }
  }
  function finishReading(result) {
    if (result.status !== "ready") return false;
    readings.set(result.post_id || readingPending.post_id, result);
    readingPending = null;
    if (pending) pending.reading_checked = true;
    persist();
    $("#growth-post-list").replaceChildren(...posts.map(postCard));
    return true;
  }
  async function executeReading() {
    const body = {
      request_id: readingPending.request_id,
      post_id: readingPending.post_id,
    };
    try {
      const result = await request("/api/post-readings", {
        method: "POST",
        body,
      });
      if (finishReading(result)) return true;
      notice("본문을 확인하는 중이에요. 잠시 후 읽기 상태를 확인하세요.");
      return false;
    } catch (error) {
      if (error.status === 422) {
        readingPending = null;
        if (pending) pending.reading_checked = true;
        persist();
        notice(
          "이 게시물의 이미지 본문을 읽지 못해 확인 가능한 캡션만 참고해요.",
        );
        return true;
      }
      if ([401, 403, 404, 410, 429].includes(error.status)) {
        readingPending = null;
        pending = null;
        persist();
      }
      throw error;
    }
  }
  async function recoverReading() {
    if (!readingPending) return true;
    try {
      const result = await request(
        `/api/post-readings/requests/${readingPending.request_id}`,
      );
      if (finishReading(result)) return true;
      if (result.status === "failed") {
        readingPending = null;
        pending = null;
        persist();
        notice(
          "본문 읽기를 완료하지 못했어요. 입력과 이미지는 유지했어요. 게시물을 확인한 뒤 다시 질문하세요.",
          true,
        );
      } else
        notice("본문을 확인하는 중이에요. 잠시 후 읽기 상태를 확인하세요.");
      return false;
    } catch (error) {
      if (error.status === 404) return executeReading();
      throw error;
    }
  }
  async function readPost(postId) {
    if (readingPending) {
      await recoverReading();
      return;
    }
    if (pending)
      throw new Error("먼저 진행 중인 답변의 저장 상태를 확인하세요.");
    readingPending = { request_id: crypto.randomUUID(), post_id: postId };
    persist();
    $("#growth-loading").hidden = false;
    if ((await executeReading()) && readings.has(postId))
      notice("게시물 본문 확인을 마쳤어요. 확인한 장면만 대화에서 활용해요.");
  }
  async function prepareReading() {
    if (readingPending) return recoverReading();
    if (pending.reading_checked) return true;
    const query = new URLSearchParams({ query: pending.message });
    for (const id of pending.growth_options.post_ids || [])
      query.append("post_id", id);
    const selection = await request(`/api/post-readings/select?${query}`);
    const candidates = (selection.candidates || []).slice(0, 3);
    pending.growth_options.post_ids = [
      ...new Set([
        ...(pending.growth_options.post_ids || []),
        ...candidates.map((p) => p.post_id),
      ]),
    ].slice(0, 5);
    const candidate = candidates.find((p) => !p.cached && p.image_count > 0);
    if (!candidate) {
      pending.reading_checked = true;
      persist();
      return true;
    }
    readingPending = {
      request_id: crypto.randomUUID(),
      post_id: candidate.post_id,
    };
    persist();
    $("#growth-loading").textContent =
      `관련 게시물 «${candidate.title || "본문"}»을 읽고 있어요…`;
    return executeReading();
  }
  async function recoverChat() {
    if (!pending) {
      if (readingPending) await recoverReading();
      return;
    }
    if (readingPending) {
      if (await recoverReading()) await sendChat(true);
      return;
    }
    try {
      const r = await request(`/api/chat/requests/${pending.request_id}`);
      if (r.status === "done") {
        cid = r.response.conversation_id;
        pending = null;
        imageAssets = [];
        $("#growth-question").value = "";
        persist();
        renderAttachments();
        await openById(cid);
        notice("저장된 답변을 복구했어요.");
      } else if (r.status === "failed" || r.status === "deleted") {
        pending = null;
        persist();
        notice(
          "요청이 완료되지 않았어요. 입력과 이미지를 확인하고 새로 질문하세요.",
        );
      } else notice("답변 처리 중이에요. 잠시 후 다시 확인하세요.");
    } catch (error) {
      if (error.status === 404) await sendChat(true);
      else throw error;
    }
  }
  async function sendChat(retry = false) {
    if (pending && !retry) return recoverChat();
    if (!pending) {
      const message = $("#growth-question").value.trim();
      if (!message) return;
      pending = {
        request_id: crypto.randomUUID(),
        mode: "growth",
        message,
        conversation_id: cid,
        growth_options: options(),
        image_assets: imageAssets.map((asset) => ({ ...asset })),
      };
      persist();
    }
    $("#growth-loading").hidden = false;
    $("#growth-loading").textContent = "관련 게시물을 확인하고 있어요…";
    if (!(await prepareReading())) return;
    const e = epoch;
    const images = [];
    for (const meta of pending.image_assets || []) {
      const asset = await getImage(user.uid, meta.sha256);
      if (!same(e)) return;
      if (!asset?.base64) {
        pending = null;
        imageAssets = imageAssets.filter(
          (image) => image.sha256 !== meta.sha256,
        );
        persist();
        renderAttachments();
        throw new Error(
          `${meta.name}: 브라우저 보관함에서 찾지 못했어요. 이 이미지를 다시 첨부해 주세요. 질문과 다른 이미지는 유지했어요.`,
        );
      }
      images.push({ ...meta, base64: asset.base64 });
    }
    const { image_assets, reading_checked, ...body } = pending;
    $("#growth-loading").textContent = "확인한 자료로 답변을 준비하고 있어요…";
    try {
      const r = await request("/api/chat", {
        method: "POST",
        body: { ...body, images },
      });
      cid = r.conversation_id;
      pending = null;
      imageAssets = [];
      $("#growth-question").value = "";
      persist();
      renderAttachments();
      await openById(cid);
      notice("답변과 참고 게시물을 대화에 저장했어요.");
    } catch (error) {
      if (
        [401, 403, 404, 410, 422, 429, 502].includes(error.status) ||
        (error.status === 503 &&
          /(OPENAI|ANTHROPIC)_API_KEY/.test(error.message))
      ) {
        pending = null;
        persist();
      }
      throw error;
    }
  }
  async function openById(id) {
    const data = await request(`/api/conversations/${id}`);
    openConversation(data);
  }
  function openConversation(data) {
    const last = [...data.messages].reverse().find((m) => m.result?.growth);
    if (!last) return false;
    cid = data.id;
    persist();
    revokePreviews();
    $("#growth-messages").replaceChildren();
    for (const m of data.messages)
      appendMessage(m.role, m.content, m.result, m.images || []);
    const g = last.result.growth;
    $("#growth-format").value = g.format;
    $("#growth-topic").value = g.topic;
    $("#growth-observation").value = g.observation_mode;
    renderRecommendation(g);
    renderAttachments();
    show("growth");
    return true;
  }
  $("#growth-add-slot").onclick = () =>
    run(() => addSlot($("#growth-slot").value));
  $("#growth-preview").onclick = () =>
    run(async () => {
      const r = await request("/api/growth/recommendations", {
        method: "POST",
        body: { request_id: crypto.randomUUID(), options: options() },
      });
      renderRecommendation(r);
    });
  $("#growth-sync").onclick = () =>
    run(async () => {
      if (syncPending) {
        await recoverSync();
        return;
      }
      syncPending = crypto.randomUUID();
      persist();
      $("#growth-sync").textContent = "Buffer에서 가져오는 중…";
      $("#growth-data-sync").textContent = "Buffer에서 가져오는 중…";
      notice("Buffer에서 최신 게시물과 성과를 가져오고 있어요…");
      try {
        await request("/api/buffer/sync", {
          method: "POST",
          body: { request_id: syncPending, force: true },
        });
        syncPending = null;
        persist();
        await refresh();
        notice("Buffer에서 최신 자료를 다시 가져왔어요.");
      } catch (e) {
        if ([401, 403, 422, 429].includes(e.status)) {
          syncPending = null;
          persist();
          await refresh();
        }
        throw e;
      } finally {
        $("#growth-sync").textContent = "Buffer 새로 불러오기";
        $("#growth-data-sync").textContent = "Buffer 자료 갱신";
      }
    });
  $("#growth-data-sync").onclick = $("#growth-sync").onclick;
  $("#growth-sync-recover").onclick = () => run(recoverSync);
  $("#growth-chat-recover").onclick = () => run(recoverChat);
  $("#growth-reading-recover").onclick = () =>
    run(async () => {
      if (await recoverReading()) {
        if (pending) await sendChat(true);
        else notice("본문 읽기 결과를 확인했어요.");
      }
    });
  $("#growth-browse-posts").onclick = () => show("posts");
  $("#growth-question").addEventListener("input", persist);
  $("#growth-chat-files").onchange = () =>
    run(async () => {
      const e = epoch;
      const owner = user.uid;
      const files = [...$("#growth-chat-files").files];
      if (pending)
        throw new Error("먼저 진행 중인 답변의 저장 상태를 확인하세요.");
      if (imageAssets.length + files.length > 10)
        throw new Error("초안 이미지는 최대 10장까지 첨부할 수 있어요.");
      const prepared = [];
      for (const file of files) {
        const asset = await prepareFile(file);
        if (!same(e)) return;
        prepared.push(asset);
      }
      await putImages(owner, prepared);
      if (!same(e)) return;
      imageAssets.push(
        ...prepared.map(({ name, sha256, mime }) => ({
          card_id: crypto.randomUUID(),
          name,
          sha256,
          mime,
        })),
      );
      $("#growth-chat-files").value = "";
      persist();
      renderAttachments();
    });
  const promptChips = node("div", "", "growth-prompt-chips");
  promptChips.id = "growth-prompt-chips";
  function updateChatMode() {
    const hasMessages = $("#growth-messages").childElementCount > 0;
    root.classList.toggle("has-messages", hasMessages);
    $("#growth-welcome").hidden = hasMessages;
    const target = $(
      hasMessages ? "#growth-followup-prompts" : "#growth-welcome-prompts",
    );
    if (promptChips.parentElement !== target) target.append(promptChips);
  }
  updateChatMode();
  const prompts = [
    [
      "다음엔 어떤 콘텐츠를 올릴까?",
      "내 기존 게시물의 주제와 내용을 바탕으로 다음에 올릴 콘텐츠를 추천하고 이유도 알려줘.",
    ],
    [
      "이 초안, 기존 글과 겹칠까?",
      "첨부한 초안과 기존 게시물을 비교하고, 겹치는 내용과 새로 보완할 점을 알려줘.",
    ],
    [
      "잘된 게시물을 다시 활용하려면?",
      "선택한 게시물을 다른 관점의 새 카드뉴스 초안으로 다시 활용해줘.",
    ],
    [
      "최근 게시물에서 뭘 개선할까?",
      "선택한 게시물의 확인한 본문과 성과를 보고 다음 제작에 반영할 피드백을 줘.",
    ],
    [
      "내가 다룬 주제로 시리즈를 만든다면?",
      "내 게시물에서 이미 다룬 내용과 빈 부분을 나눠 다음 시리즈를 기획해줘.",
    ],
  ];
  for (const [label, prompt] of prompts) {
    const chip = node("button", label, "growth-prompt-chip secondary");
    chip.type = "button";
    chip.onclick = () => {
      if (busy || pending) return;
      $("#growth-question").value = prompt;
      persist();
      $("#growth-question").focus();
    };
    $("#growth-prompt-chips").append(chip);
  }
  $("#growth-chat-form").onsubmit = (e) => {
    e.preventDefault();
    run(() => sendChat());
  };
  $("#growth-new-chat").onclick = () =>
    run(() => {
      if (pending || readingPending)
        throw new Error("먼저 진행 중인 요청의 저장 상태를 확인하세요.");
      cid = null;
      selectedPosts = [];
      imageAssets = [];
      $("#growth-question").value = "";
      revokePreviews();
      persist();
      renderSelection();
      renderAttachments();
      $("#growth-messages").replaceChildren();
      updateChatMode();
      notice("새 대화를 시작했어요.");
    });
  $("#growth-data-open").onclick = () => show("data");
  $("#growth-post-filter").onchange = () =>
    run(async () => {
      await loadPosts();
      renderExperiments();
    });
  $("#growth-more-posts").onclick = () =>
    run(async () => {
      await loadPosts(false);
      renderExperiments();
    });
  const importForm = document.querySelector("#growth-csv-form");
  if (importForm)
    importForm.onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const file = $("#growth-csv-file").files[0];
        if (!file) throw new Error("CSV 파일을 선택하세요.");
        if (file.size > 2 * 1024 * 1024)
          throw new Error("CSV는 2MB 이하로 선택하세요.");
        const result = await request("/api/data/import", {
          method: "POST",
          body: { csv_text: await file.text() },
        });
        $("#growth-csv-result").textContent =
          `${result.date_count}일 · 추가 ${result.imported}개 · 기존 자료 유지 ${result.skipped}개 · 유효 ${result.valid_count}개 · 결측 ${result.missing_count}개`;
        await loadData();
        await refresh();
      });
    };
  async function sessionChanged() {
    const previousUser = user;
    if (previousUser && previousUser !== getUser())
      localStorage.removeItem(key());
    epoch++;
    revokePreviews();
    const sessionEpoch = epoch;
    user = getUser();
    busy = false;
    status = null;
    posts = [];
    experiments = [];
    slots = [];
    cid = null;
    pending = null;
    syncPending = null;
    readingPending = null;
    selectedPosts = [];
    imageAssets = [];
    readings = new Map();
    recommendation = null;
    annotationDrafts = new Map();
    for (const id of [
      "growth-messages",
      "growth-attachments",
      "growth-selected-posts",
      "growth-evidence",
      "growth-post-list",
      "growth-experiments",
      "growth-chart",
      "growth-slots",
      "growth-schedule",
      "growth-live-data",
      "growth-data-status",
    ])
      $("#" + id).replaceChildren();
    updateChatMode();
    $("#growth-chat-files").value = "";
    $("#growth-format").value = "carousel";
    $("#growth-observation").value = "lifetime";
    $("#growth-topic").value = "";
    $("#growth-question").value = "";
    $("#growth-slot").value = "";
    $("#growth-account").textContent = "내 계정 연결";
    $("#growth-recommendation").replaceChildren(
      node(
        "p",
        "가능한 시간을 고르면 내 기록과 비교한 후보가 표시돼요.",
        "growth-empty",
      ),
    );
    $("#growth-daily-summary").textContent =
      "로그인 후 저장된 일별 팔로우가 표시돼요.";
    $("#growth-sync-state").textContent =
      "로그인 후 Buffer 자료를 불러올 수 있어요.";
    $("#growth-source-state").textContent = "—";
    $("#growth-metric-state").textContent = "—";
    $("#growth-freshness-note").textContent =
      "로그인 후 데이터의 출처와 갱신 시각을 확인할 수 있어요.";
    $("#growth-daily-label").textContent = "과거 계정 일별 기록";
    $("#growth-daily-freshness").textContent = "";
    $("#growth-sync").textContent = "Buffer 새로 불러오기";
    $("#growth-data-sync").textContent = "Buffer 자료 갱신";
    $("#growth-metrics").replaceChildren();
    $("#growth-loading").hidden = true;
    $("#growth-sync-recover").hidden = true;
    $("#growth-chat-recover").hidden = true;
    $("#growth-reading-recover").hidden = true;
    $("#growth-data-sync").disabled = !user;
    for (const control of [
      ...root.querySelectorAll("button,input,textarea,select"),
      ...past.querySelectorAll("button,input,textarea,select"),
    ])
      control.disabled = !user;
    if (!user) return;
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || "{}");
      cid = saved.cid || null;
      pending = saved.pending || null;
      syncPending = saved.syncPending || null;
      readingPending = saved.readingPending || null;
      selectedPosts = (saved.selectedPosts || []).slice(0, 5);
      imageAssets = (pending?.image_assets || saved.imageAssets || []).slice(
        0,
        10,
      );
      $("#growth-question").value = pending?.message || saved.draft || "";
      renderSelection();
      renderAttachments();
    } catch {
      notice(
        "저장된 진행 상태를 읽지 못했어요. 대화 기록에서 확인하세요.",
        true,
      );
    }
    await refresh();
    if (!same(sessionEpoch)) return;
    $("#growth-sync-recover").hidden = !syncPending;
    $("#growth-chat-recover").hidden = !pending;
    $("#growth-reading-recover").hidden = !readingPending;
    $("#growth-question").disabled = !!pending;
    $("#growth-chat-files").disabled = !!pending;
    if (pending) $("#growth-question").value = pending.message;
    if (cid) {
      try {
        await openById(cid);
      } catch (e) {
        if (e.status === 404) {
          cid = null;
          persist();
        } else notice(e.message, true);
      }
    }
  }
  return {
    sessionChanged,
    refresh,
    openConversation,
    isBusy: () => busy,
    updateDaily(records, summary) {
      if (user && user === getUser()) renderDaily(records, summary);
    },
  };
}
