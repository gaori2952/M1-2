import { connectAuth } from "./auth.js";
import { createApi } from "./api.js";
import { mountCardEditor, resetCardEditor } from "./card-editor.js";
import { mountImageReview } from "./image-review.js";

const $ = (selector) => document.querySelector(selector);
const labels = {
  views: "조회수",
  viewers: "시청자",
  interactions: "상호작용",
  visits: "프로필 방문",
  follows: "팔로우",
  link_clicks: "링크 클릭",
};
const trends = {
  up: "증가",
  down: "감소",
  stable: "유지",
  insufficient_data: "비교 자료 부족",
};
const perfLabels = {
  views: "조회",
  reach: "도달",
  likes: "좋아요",
  comments: "댓글",
  saves: "저장",
  shares: "공유",
};
function readPerformance() {
  const perf = {};
  document.querySelectorAll("[data-perf]").forEach((i) => {
    perf[i.dataset.perf] = i.value === "" ? null : Number(i.value);
  });
  return Object.values(perf).some((v) => v !== null) ? perf : null;
}
function perfSummary(perf) {
  if (!perf) return "";
  return Object.entries(perfLabels)
    .filter(([k]) => perf[k] !== null && perf[k] !== undefined)
    .map(([k, label]) => `${label} ${Number(perf[k]).toLocaleString("ko-KR")}`)
    .join(" · ");
}
// Reactions per view when views are known; otherwise total reactions.
function perfScore(perf) {
  if (!perf) return null;
  const reactions =
    (perf.likes || 0) +
    2 * (perf.comments || 0) +
    3 * (perf.saves || 0) +
    3 * (perf.shares || 0);
  if (!reactions && !perf.views) return null;
  return perf.views ? reactions / perf.views : reactions;
}
const state = {
  user: null,
  contents: [],
  data: [],
  series: [],
  conversationId: null,
  draft: null,
  lastDraftId: null,
  dirty: false,
  busy: false,
  pending: null,
  limit: 100,
  editingLocks: 0,
};
const welcome = $("#messages").innerHTML;
let auth;
function notice(text, error = false) {
  $("#notice").textContent = text;
  $("#notice").hidden = !text;
  $("#notice").classList.toggle("error", error);
}
const api = createApi(
  () => state.user,
  (text) => notice(text),
);
const imageReview = mountImageReview($("#image-review-root"), {
  api,
  getUser: () => state.user,
  notice,
});
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, handler, cls = "secondary") => {
  const b = el("button", text, cls);
  b.type = "button";
  b.addEventListener("click", () => run(handler, b));
  return b;
};
async function run(handler, b) {
  if (b) b.disabled = true;
  try {
    await handler();
  } catch (e) {
    notice(e.message, true);
  } finally {
    if (b) b.disabled = false;
  }
}
let lockedControls = [];
function lockEditing() {
  if (state.editingLocks++ === 0) {
    lockedControls = [
      ...document.querySelectorAll(
        "main input, main textarea, main select, main button",
      ),
    ].map((node) => [node, node.disabled]);
    lockedControls.forEach(([node]) => {
      node.disabled = true;
    });
    $("main").setAttribute("aria-busy", "true");
  }
  return () => {
    if (--state.editingLocks === 0) {
      lockedControls.forEach(([node, disabled]) => {
        node.disabled = disabled;
      });
      lockedControls = [];
      $("main").removeAttribute("aria-busy");
    }
  };
}
async function editingOperation(handler) {
  const unlock = lockEditing();
  try {
    return await handler();
  } finally {
    unlock();
  }
}
function bindForm(id, handler) {
  $(id).addEventListener("submit", (event) => {
    event.preventDefault();
    run(() => editingOperation(handler), event.submitter);
  });
}
function storageKey() {
  return `content-studio:${state.user?.uid || state.user?.displayName}:conversation`;
}
function saveActive() {
  if (state.conversationId)
    localStorage.setItem(storageKey(), state.conversationId);
  else localStorage.removeItem(storageKey());
}
function show(view) {
  if (imageReview.isBusy())
    return notice("이미지 처리가 끝난 뒤 화면을 이동해 주세요.");
  if (state.editingLocks) return notice("처리가 끝난 뒤 화면을 이동해 주세요.");
  if (
    state.dirty &&
    !confirm(
      "저장하지 않은 원고 수정이 있어요. 화면을 이동할까요? 편집 내용은 이 페이지에 유지됩니다.",
    )
  )
    return;
  document
    .querySelectorAll(".view")
    .forEach((s) => (s.hidden = s.id !== `view-${view}`));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "history") run(loadHistory);
  if (view === "drafts" || view === "studio") run(loadDrafts);
}
function highlightNav(view) {
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}
document
  .querySelectorAll("[data-view]")
  .forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#theme").addEventListener("click", () => {
  document.documentElement.classList.toggle("dark");
  localStorage.setItem(
    "content-studio:theme",
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
});
document.documentElement.classList.toggle(
  "dark",
  localStorage.getItem("content-studio:theme") === "dark",
);
window.addEventListener("beforeunload", (e) => {
  if (state.dirty || imageReview.isBusy()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
$("#new-chat").addEventListener("click", () => {
  if (state.busy) return notice("현재 답변이 끝난 뒤 새 대화를 시작해 주세요.");
  state.conversationId = null;
  state.pending = null;
  state.lastDraftId = null;
  saveActive();
  $("#messages").innerHTML = welcome;
  wireSuggestions();
  $("#ideas").replaceChildren();
  $("#open-draft").hidden = true;
  notice("새 대화를 시작했어요.");
});
function wireSuggestions() {
  document.querySelectorAll("[data-prompt]").forEach((b) =>
    b.addEventListener("click", () => {
      $("#message").value = b.dataset.prompt;
      $("#mode").value = b.dataset.mode;
      $("#message").focus();
    }),
  );
}
wireSuggestions();
function message(role, text, meta = "") {
  const row = el("div", undefined, `message ${role}`);
  row.append(el("span", role === "user" ? "나" : "✦", "avatar"));
  const body = el("div", text, "message-content");
  if (meta) body.append(el("small", meta));
  row.append(body);
  $("#messages").append(row);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}
function selectedSources() {
  return [...document.querySelectorAll("[data-source]:checked")].map(
    (c) => c.dataset.source,
  );
}
function renderSources() {
  const selected = new Set(selectedSources());
  $("#source-picker").replaceChildren();
  for (const c of state.contents) {
    const label = el("label", undefined, "source-option");
    const check = el("input");
    check.type = "checkbox";
    check.dataset.source = c.id;
    check.checked = selected.has(c.id);
    check.addEventListener("change", () => {
      if (selectedSources().length > 5) {
        check.checked = false;
        notice("참고 원고는 최대 5개 선택할 수 있어요.", true);
      }
    });
    const text = el("span", c.title);
    text.append(
      el(
        "small",
        `${c.kind === "review" ? "검토 메모" : "원고"} · ${c.publication_status === "published" ? "게시함" : "게시 미확인"} · 검토 미확인`,
      ),
    );
    label.append(check, text);
    $("#source-picker").append(label);
  }
  if (!state.contents.length)
    $("#source-picker").append(
      el(
        "p",
        "아직 원고가 없어요. 라이브러리에 첫 원고를 추가해 주세요.",
        "empty-small",
      ),
    );
}
function query() {
  const start = $("#filter-start").value,
    end = $("#filter-end").value;
  return start || end
    ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
    : "";
}
function number(value) {
  return value === null || value === undefined
    ? "—"
    : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}
async function loadSummary() {
  const s = await api("/api/data/summary" + query());
  const metric = $("#filter-metric").value || "views";
  const m = s.metrics.views || {};
  $("#summary-period").textContent = s.period
    ? `${s.period.start} – ${s.period.end}`
    : "기록을 추가하면 여기에 요약이 표시돼요.";
  $("#summary-average").textContent = number(m.average);
  $("#summary-count").textContent = `${m.count || 0}개`;
  $("#summary-trend").textContent = trends[m.trend] || "데이터 없음";
  $(".context-card .tag").textContent = query() ? "선택 기간" : "최근 7일";
  $("#trend-chart").replaceChildren();
  const daily = (s.daily || []).filter((d) => d.metric === "views");
  const valid = daily.map((d) => d.value).filter((v) => v !== null);
  const max = Math.max(...valid, 1);
  const segment = [];
  const draw = () => {
    if (!segment.length) return;
    const poly = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    poly.setAttribute("points", segment.join(" "));
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "#2563eb");
    poly.setAttribute("stroke-width", "2.5");
    $("#trend-chart").append(poly);
    segment.length = 0;
  };
  daily.forEach((d, i) => {
    if (d.value === null) {
      draw();
      return;
    }
    segment.push(
      `${8 + (i * 284) / Math.max(daily.length - 1, 1)},${78 - (d.value / max) * 65}`,
    );
  });
  draw();
  const v = s.metrics[metric] || {};
  $("#data-summary").replaceChildren();
  for (const [name, value] of [
    [`${labels[metric]} 평균`, number(v.average)],
    ["최고", number(v.max)],
    ["유효 관측 / 결측", `${v.count || 0} / ${v.missing_count || 0}`],
    [
      "전기 대비 평균 변화",
      v.change_percent === null || v.change_percent === undefined
        ? "계산 불가"
        : number(v.change_percent) + "%",
    ],
  ]) {
    const node = el("div", undefined, "stat");
    node.append(el("small", name), el("strong", value));
    $("#data-summary").append(node);
  }
}
function openContentForm(title) {
  $("#content-form-title").textContent = title;
  $("#content-form").hidden = false;
  $("#content-text").focus();
}
function closeContentForm() {
  $("#content-form").reset();
  document
    .querySelectorAll("#content-form details")
    .forEach((d) => (d.open = false));
  $("#content-id").value = "";
  $("#content-form").hidden = true;
}
$("#content-new").onclick = () => {
  closeContentForm();
  openContentForm("새 원고");
};
$("#content-close").onclick = closeContentForm;
$("#content-search").addEventListener("input", () => renderContents());
async function loadContents() {
  state.contents = await api("/api/contents");
  renderSources();
  renderContents();
  renderTop();
}
function rankedContents() {
  return state.contents
    .map((c) => ({ c, score: perfScore(c.performance) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.c);
}
function recommendFrom(items) {
  if (state.busy) return notice("현재 답변이 끝난 뒤 다시 눌러 주세요.");
  const ids = new Set(items.map((c) => c.id));
  document
    .querySelectorAll("[data-source]")
    .forEach((box) => (box.checked = ids.has(box.dataset.source)));
  $("#mode").value = "ideas";
  const names = items.map((c) => `「${c.title}」`).join(", ");
  $("#message").value =
    `${names}의 게시물 성과(${items.map((c) => perfSummary(c.performance)).join(" / ")})를 근거로, ` +
    "반응이 좋았던 점을 살려 업데이트하거나 이어서 만들 주제 3개를 추천해줘. 어떤 수치를 근거로 했는지도 알려줘.";
  run(() => send());
}
function renderTop() {
  const ranked = rankedContents();
  $("#top-list").replaceChildren();
  $("#recommend-top").disabled = !ranked.length;
  ranked.slice(0, 3).forEach((c, i) => {
    const card = el("article", undefined, "top-card");
    card.append(
      el("span", `TOP ${i + 1}`, "eyebrow"),
      el("h3", c.title),
      el("small", perfSummary(c.performance), "perf-line"),
      button("이 콘텐츠로 추천", () => recommendFrom([c])),
    );
    $("#top-list").append(card);
  });
  if (!ranked.length) {
    const empty = el("div", undefined, "empty-small");
    empty.append(
      el(
        "span",
        "아직 성과가 입력된 콘텐츠가 없어요. 라이브러리에서 원고마다 인사이트 수치(조회·저장·공유 등)를 입력하면 여기에 순위가 나타나요. ",
      ),
    );
    const go = el("button", "라이브러리로 가기 →", "text-button");
    go.type = "button";
    go.addEventListener("click", () => show("library"));
    empty.append(go);
    $("#top-list").append(empty);
  }
}
$("#recommend-top").onclick = () => recommendFrom(rankedContents().slice(0, 3));
function renderContents() {
  const q = $("#content-search").value.trim().toLowerCase();
  const items = state.contents.filter(
    (c) =>
      !q ||
      [c.title, c.text, c.tags.join(" ")].join(" ").toLowerCase().includes(q),
  );
  $("#content-total").textContent = q
    ? `${items.length} / ${state.contents.length}개`
    : `${state.contents.length}개 원고`;
  $("#content-list").replaceChildren();
  for (const c of items) {
    const card = el("article", undefined, "card");
    card.append(
      el("h3", c.title),
      el(
        "small",
        `${c.tags.join(" · ")} · ${{ published: "게시함", unpublished: "미게시" }[c.publication_status] || "게시 미확인"} · ${c.review_status === "verified" ? "검토 완료" : "검토 미확인"}`,
        "muted",
      ),
      el("p", c.text.slice(0, 220) + (c.text.length > 220 ? "…" : "")),
      el(
        "small",
        c.performance ? `성과 · ${perfSummary(c.performance)}` : "성과 미입력",
        c.performance ? "perf-line" : "muted",
      ),
      el("small", `출처: ${c.source || "직접 입력 / 미확인"}`, "muted"),
    );
    const actions = el("div", undefined, "actions");
    actions.append(
      button("수정", () => {
        for (const [field, value] of Object.entries({
          id: c.id,
          title: c.title,
          text: c.text,
          tags: c.tags.join(", "),
          source: c.source || "",
          kind: c.kind,
          publication: c.publication_status,
          date: c.published_at || "",
        }))
          $(`#content-${field}`).value = value;
        document.querySelectorAll("[data-perf]").forEach((i) => {
          i.value = c.performance?.[i.dataset.perf] ?? "";
        });
        $("#content-more-perf").open = !!c.performance;
        $("#content-more-info").open = !!(
          c.tags.length ||
          c.published_at ||
          c.publication_status !== "unknown"
        );
        openContentForm("원고 수정");
      }),
      button("삭제", async () => {
        if (!confirm("이 원고 자료를 삭제할까요? 기존 생성 원고는 유지됩니다."))
          return;
        await api("/api/contents/" + c.id, { method: "DELETE" });
        await loadContents();
        notice("원고 자료를 삭제했어요.");
      }),
    );
    card.append(actions);
    $("#content-list").append(card);
  }
  if (q && !items.length)
    $("#content-list").append(el("p", "검색 결과가 없어요.", "empty-small"));
  if (!state.contents.length) $("#content-list").append(libraryGuide());
}
function libraryGuide() {
  const guide = el("section", undefined, "guide");
  guide.append(
    el("h2", "라이브러리는 이렇게 시작하세요"),
    el(
      "p",
      "여기에 모은 원고가 AI 추천과 원고 작성의 근거가 돼요. 완벽하게 정리하지 않아도 괜찮아요.",
      "muted",
    ),
  );
  const steps = [
    [
      "1",
      "게시했던 원고를 붙여넣기",
      "카드뉴스 문구를 통째로 붙여넣으면 첫 줄이 제목이 돼요. 나머지 칸은 비워도 돼요.",
      "＋ 원고 붙여넣기",
      () => $("#content-new").click(),
    ],
    [
      "2",
      "반응 좋았던 게시물에 성과 적기",
      "인사이트의 조회·저장·공유만 적어도 작업실에 성과 순위가 생겨요.",
    ],
    [
      "3",
      "작업실에서 다음 주제 추천받기",
      "성과 상위 콘텐츠를 근거로 업데이트·후속 주제를 받아요.",
      "작업실로 가기 →",
      () => show("studio"),
    ],
  ];
  const list = el("ol", undefined, "guide-steps");
  for (const [n, title, body, label, action] of steps) {
    const li = el("li");
    li.append(el("span", n, "step-num"));
    const text = el("div");
    text.append(el("strong", title), el("p", body, "muted"));
    if (label) {
      const b = el("button", label, n === "1" ? "primary" : "text-button");
      b.type = "button";
      b.addEventListener("click", action);
      text.append(b);
    }
    li.append(text);
    list.append(li);
  }
  guide.append(list);
  return guide;
}
bindForm("#content-form", async () => {
  const id = $("#content-id").value;
  await api("/api/contents" + (id ? "/" + id : ""), {
    method: id ? "PUT" : "POST",
    body: {
      title:
        $("#content-title").value.trim() ||
        $("#content-text")
          .value.split("\n")
          .map((s) => s.replace(/^[#\s*-]+/, "").trim())
          .find(Boolean)
          .slice(0, 80),
      text: $("#content-text").value,
      tags: $("#content-tags")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      source: $("#content-source").value,
      kind: $("#content-kind").value,
      publication_status: $("#content-publication").value,
      published_at: $("#content-date").value || null,
      performance: readPerformance(),
    },
  });
  closeContentForm();
  await loadContents();
  notice("원고 자료를 저장했어요. 수정된 내용은 검토 미확인 상태입니다.");
});
$("#content-reset").onclick = () => {
  $("#content-form").reset();
  $("#content-id").value = "";
};
for (const select of ["#data-metric", "#filter-metric"]) {
  for (const [value, label] of Object.entries(labels)) {
    const option = el("option", label);
    option.value = value;
    $(select).append(option);
  }
}
function resetData() {
  $("#data-form").reset();
  $("#data-id").value = "";
  $("#data-date").disabled = false;
  $("#data-metric").disabled = false;
}
function openDataForm(title) {
  $("#data-form-title").textContent = title;
  $("#data-form").hidden = false;
}
$("#data-new").onclick = () => {
  resetData();
  $("#data-date").value = new Date().toISOString().slice(0, 10);
  $("#data-metric").value = $("#filter-metric").value;
  openDataForm("기록 추가");
  $("#data-value").focus();
};
$("#data-close").onclick = () => {
  resetData();
  $("#data-form").hidden = true;
};
function markRange(range) {
  document
    .querySelectorAll("[data-range]")
    .forEach((b) => b.classList.toggle("active", b.dataset.range === range));
}
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () =>
    run(async () => {
      const range = b.dataset.range;
      if (range === "all") {
        $("#filter-start").value = "";
        $("#filter-end").value = "";
      } else {
        const end = new Date(
          (state.latestDate || new Date().toISOString().slice(0, 10)) +
            "T00:00:00Z",
        );
        const start = new Date(end);
        start.setUTCDate(end.getUTCDate() - Number(range) + 1);
        $("#filter-start").value = start.toISOString().slice(0, 10);
        $("#filter-end").value = end.toISOString().slice(0, 10);
      }
      state.limit = 100;
      await loadData();
      markRange(range);
    }, b),
  ),
);
function renderData() {
  $("#data-list").replaceChildren();
  const filtered = state.data.filter(
    (d) => d.metric === $("#filter-metric").value,
  );
  $("#data-total").textContent = `${filtered.length}개 기록`;
  $("#more-data").hidden = filtered.length <= state.limit;
  for (const d of filtered.slice(0, state.limit)) {
    const tr = el("tr");
    for (const value of [
      d.date,
      labels[d.metric],
      d.value === null ? "결측" : number(d.value),
      d.memo,
    ])
      tr.append(el("td", value));
    const actions = el("td");
    actions.append(
      button("수정", () => {
        $("#data-id").value = d.id;
        $("#data-date").value = d.date;
        $("#data-date").disabled = true;
        $("#data-metric").value = d.metric;
        $("#data-metric").disabled = true;
        $("#data-value").value = d.value ?? "";
        $("#data-memo").value = d.memo;
        openDataForm(`기록 수정 · ${d.date}`);
      }),
      button("삭제", async () => {
        if (!confirm("이 데이터 기록을 삭제할까요?")) return;
        await api("/api/data/" + d.id, { method: "DELETE" });
        await loadData();
        notice("데이터를 삭제했어요.");
      }),
    );
    tr.append(actions);
    $("#data-list").append(tr);
  }
  if (!filtered.length) {
    const td = el("td", "조건에 맞는 데이터가 없어요.");
    td.colSpan = 5;
    const tr = el("tr");
    tr.append(td);
    $("#data-list").append(tr);
  }
}
async function loadData() {
  state.data = (await api("/api/data" + query())).reverse();
  if (!query() && state.data.length)
    state.latestDate = state.data.reduce(
      (a, d) => (d.date > a ? d.date : a),
      "",
    );
  renderData();
  await loadSummary();
}
$("#more-data").onclick = () => {
  state.limit += 100;
  renderData();
};
bindForm("#data-form", async () => {
  const id = $("#data-id").value;
  const body = {
    value:
      $("#data-value").value === "" ? null : Number($("#data-value").value),
    memo: $("#data-memo").value,
  };
  if (!id)
    Object.assign(body, {
      date: $("#data-date").value,
      metric: $("#data-metric").value,
    });
  await api("/api/data" + (id ? "/" + id : ""), {
    method: id ? "PUT" : "POST",
    body,
  });
  resetData();
  $("#data-form").hidden = true;
  await loadData();
  notice("데이터를 저장하고 요약을 갱신했어요.");
});
$("#data-reset").onclick = resetData;
bindForm("#filter-form", async () => {
  state.limit = 100;
  await loadData();
  markRange(null);
  notice("선택 기간을 작업실 요약과 채팅에도 적용했어요.");
});
$("#clear-filter").onclick = () =>
  run(async () => {
    $("#filter-start").value = "";
    $("#filter-end").value = "";
    await loadData();
    markRange(null);
  });
function download(name, data, type = "application/json") {
  const url = URL.createObjectURL(
    new Blob(
      [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
      { type },
    ),
  );
  const a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#export-data").onclick = () => download("account-data.json", state.data);
const prefGroups = {
  독자: ["중학생", "고등학생", "공학 입문 대학생", "일반 성인", "전공자"],
  "설명 순서": [
    "직관 → 정의 → 예시",
    "질문으로 시작",
    "일상 비유 먼저",
    "정의 → 유도 → 예시",
  ],
  문체: [
    "친근한 존댓말",
    "간결한 개조식",
    "과장 표현 금지",
    "전문 용어는 풀어서",
  ],
  수식: ["수식은 최소한으로", "수식마다 적용 조건 명시", "단위 항상 표기"],
  "카드 구성": [
    "카드 한 장에 개념 하나",
    "첫 카드는 궁금증을 여는 질문",
    "마지막 카드는 요약",
    "그림 지시는 구체적으로",
  ],
  퀴즈: ["개념 이해형", "간단한 계산형", "오답마다 이유 설명", "실생활 적용형"],
};
const prefSelected = {};
function composePreferences() {
  const box = $("#profile-instructions");
  const generated = Object.entries(prefSelected)
    .filter(([, values]) => values.size)
    .map(([group, values]) => `- ${group}: ${[...values].join(", ")}`);
  const custom = box.value
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        !Object.keys(prefGroups).some((g) => line.startsWith(`- ${g}:`)),
    );
  box.value = [...generated, ...custom].join("\n");
}
function renderPrefBuilder() {
  $("#pref-builder").replaceChildren();
  for (const [group, options] of Object.entries(prefGroups)) {
    prefSelected[group] ||= new Set();
    const row = el("div", undefined, "pref-row");
    row.append(el("span", group, "pref-label"));
    const chips = el("div", undefined, "chips");
    for (const option of options) {
      const chip = el("button", option, "chip");
      chip.type = "button";
      chip.setAttribute("aria-pressed", prefSelected[group].has(option));
      chip.addEventListener("click", () => {
        const set = prefSelected[group];
        set.has(option) ? set.delete(option) : set.add(option);
        chip.setAttribute("aria-pressed", set.has(option));
        composePreferences();
      });
      chips.append(chip);
    }
    row.append(chips);
    $("#pref-builder").append(row);
  }
}
function syncPrefBuilder(text) {
  for (const group of Object.keys(prefGroups)) {
    const line = text.split("\n").find((l) => l.startsWith(`- ${group}:`));
    prefSelected[group] = new Set(
      line
        ? line
            .slice(group.length + 3)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    );
  }
  renderPrefBuilder();
}
const seriesTemplates = [
  "이전 편 내용을 한 줄로 상기시키며 시작",
  "편마다 같은 카드 구성 유지",
  "다음 편 예고로 마무리",
  "수식보다 비유를 먼저",
];
for (const text of seriesTemplates) {
  const chip = el("button", "+ " + text, "chip");
  chip.type = "button";
  chip.addEventListener("click", () => {
    const box = $("#series-instructions");
    if (!box.value.includes(text))
      box.value =
        (box.value.trim() ? box.value.trim() + "\n" : "") + "- " + text;
  });
  $("#series-templates").append(chip);
}
renderPrefBuilder();
async function loadPreferences() {
  const [profile, series] = await Promise.all([
    api("/api/profile"),
    api("/api/series"),
  ]);
  $("#profile-instructions").value = profile.instructions;
  syncPrefBuilder(profile.instructions || "");
  $("#style-preview").textContent =
    profile.instructions || "확인한 제작 선호가 아직 없어요.";
  state.series = series;
  const current = $("#series-select").value;
  $("#series-select").replaceChildren();
  const empty = el("option", "일반 제작");
  empty.value = "";
  $("#series-select").append(empty);
  $("#series-list").replaceChildren();
  for (const s of series) {
    const opt = el("option", s.title);
    opt.value = s.id;
    $("#series-select").append(opt);
    const card = el("article", undefined, "card");
    card.append(
      el("h3", s.title),
      el("p", s.instructions),
      button("규칙 수정", () => {
        $("#series-id").value = s.id;
        $("#series-title").value = s.title;
        $("#series-instructions").value = s.instructions;
        $("#series-confirm").checked = false;
      }),
    );
    $("#series-list").append(card);
  }
  $("#series-select").value = current;
}
bindForm("#profile-form", async () => {
  await api("/api/profile", {
    method: "PUT",
    body: {
      instructions: $("#profile-instructions").value,
      confirmed: $("#profile-confirm").checked,
    },
  });
  await loadPreferences();
  notice("확인한 제작 선호를 저장했어요. 다음 요청부터 반영돼요.");
});
bindForm("#series-form", async () => {
  const id = $("#series-id").value;
  await api("/api/series" + (id ? "/" + id : ""), {
    method: id ? "PUT" : "POST",
    body: {
      title: $("#series-title").value,
      instructions: $("#series-instructions").value,
      confirmed: $("#series-confirm").checked,
    },
  });
  $("#series-form").reset();
  $("#series-id").value = "";
  await loadPreferences();
  notice("시리즈 규칙을 저장했어요.");
});
function renderIdeas(ideas) {
  $("#ideas").replaceChildren();
  for (const [i, idea] of ideas.entries()) {
    const item = el("article", undefined, "idea");
    item.append(
      el("span", `IDEA 0${i + 1}`, "eyebrow"),
      el("h3", idea.title),
      el("p", idea.objective),
      el(
        "p",
        `선행 개념: ${idea.prerequisites}\n기존 자료와의 관계: ${idea.relationship}\n추천 이유: ${idea.reason}`,
      ),
      button("이 주제로 원고 만들기", () => send(idea), "primary"),
    );
    $("#ideas").append(item);
  }
}
async function send(idea = null) {
  if (state.busy) return;
  const text = idea
    ? `${idea.title} 주제로 카드뉴스와 퀴즈 초안을 만들어줘.`
    : $("#message").value.trim();
  if (!text) return;
  const request = {
    request_id: crypto.randomUUID(),
    conversation_id: state.conversationId,
    mode: idea ? "draft" : $("#mode").value,
    message: text,
    selected_content_ids: selectedSources(),
    series_id: $("#series-select").value || null,
    card_count: Number($("#card-count").value),
    selected_idea: idea,
    start: $("#filter-start").value || null,
    end: $("#filter-end").value || null,
  };
  const comparable = (r) => JSON.stringify({ ...r, request_id: null });
  if (state.pending && comparable(state.pending) !== comparable(request)) {
    notice(
      "응답 확인이 안 된 요청이 있어요. 원래 입력 그대로 재시도하거나 새 대화를 시작하세요.",
      true,
    );
    return;
  }
  const body = state.pending || request;
  state.pending = body;
  state.busy = true;
  const unlock = lockEditing();
  $("#send").disabled = true;
  $("#loading").hidden = false;
  $("#save-state").textContent = "생성 중 · 아직 저장되지 않았어요";
  try {
    const result = await api("/api/chat", { method: "POST", body });
    state.pending = null;
    state.conversationId = result.conversation_id;
    saveActive();
    if ($("#messages .welcome")) $("#messages").replaceChildren();
    message("user", body.message);
    message(
      "assistant",
      result.result.answer,
      result.result.source_ids.length
        ? `참고 원고 ${result.result.source_ids.length}개 · 자동 저장됨`
        : "참고 원고 없음 · 자동 저장됨",
    );
    if (!idea) $("#message").value = "";
    renderIdeas(result.result.ideas);
    if (result.draft_id) {
      state.lastDraftId = result.draft_id;
      $("#open-draft").hidden = false;
      await openDraft(result.draft_id, true);
    }
    $("#save-state").textContent = "대화가 저장됐어요";
    notice("대화가 자동 저장됐어요.");
  } catch (error) {
    $("#save-state").textContent = "저장 완료를 확인하지 못했어요";
    if ([401, 403, 404, 410, 422, 429, 502].includes(error.status))
      state.pending = null;
    throw error;
  } finally {
    state.busy = false;
    unlock();
    $("#send").disabled = false;
    $("#loading").hidden = true;
  }
}
bindForm("#chat-form", () => send());
async function loadConversation(id) {
  $(".planning-tools").open = true;
  if (state.busy) throw new Error("현재 답변이 끝난 뒤 불러와 주세요.");
  const data = await api("/api/conversations/" + id);
  state.conversationId = id;
  state.pending = null;
  saveActive();
  $("#messages").replaceChildren();
  $("#ideas").replaceChildren();
  state.lastDraftId = null;
  for (const m of data.messages) {
    message(m.role, m.content);
    if (m.result) renderIdeas(m.result.ideas);
    if (m.draft_id) state.lastDraftId = m.draft_id;
  }
  $("#open-draft").hidden = !state.lastDraftId;
  show("studio");
  notice("이전 대화를 불러왔어요.");
}
async function loadHistory() {
  const history = await api("/api/conversations");
  $("#history-list").replaceChildren();
  for (const c of history) {
    const card = el("article", undefined, "card");
    card.append(
      el("h3", c.title),
      el(
        "small",
        `${new Date(c.updated_at).toLocaleString("ko-KR")} · 메시지 ${c.message_count}개`,
        "muted",
      ),
    );
    const actions = el("div", undefined, "actions");
    actions.append(
      button("불러오기", () => loadConversation(c.id), "primary"),
      button("대화 삭제", async () => {
        if (!confirm("대화와 메시지를 삭제할까요? 보관한 원고는 유지됩니다."))
          return;
        await api("/api/conversations/" + c.id, { method: "DELETE" });
        if (state.conversationId === c.id) {
          state.conversationId = null;
          saveActive();
          state.lastDraftId = null;
          $("#messages").innerHTML = welcome;
          wireSuggestions();
          $("#ideas").replaceChildren();
          $("#open-draft").hidden = true;
        }
        await loadHistory();
        notice("대화를 삭제했어요.");
      }),
    );
    card.append(actions);
    $("#history-list").append(card);
  }
  if (!history.length)
    $("#history-list").append(
      el(
        "p",
        "아직 저장된 대화가 없어요. 작업실에서 첫 질문을 남겨 보세요.",
        "empty-small",
      ),
    );
}
async function loadDrafts() {
  const drafts = await api("/api/drafts");
  $("#draft-list").replaceChildren();
  $("#recent-drafts").replaceChildren();
  for (const d of drafts) {
    const card = el("article", undefined, "card");
    const reviewed = d.status === "reviewed";
    card.append(
      el(
        "span",
        reviewed ? "검토 완료" : "검토 필요",
        reviewed ? "tag done" : "tag",
      ),
      el("h3", d.draft.title),
      el("p", d.draft.objective, "muted"),
      el(
        "small",
        `카드 ${d.draft.cards.length}장 · 버전 ${d.version}`,
        "muted",
      ),
      button("원고 열기", () => openDraft(d.id), "primary"),
    );
    $("#draft-list").append(card);
    if ($("#recent-drafts").children.length < 3) {
      const recent = el("article", undefined, "card recent-draft");
      recent.append(
        el("small", `카드 ${d.draft.cards.length}장 · v${d.version}`, "muted"),
        el("h3", d.draft.title),
        button("이어서 편집", () => openDraft(d.id), "secondary"),
      );
      $("#recent-drafts").append(recent);
    }
  }
  if (!drafts.length)
    $("#draft-list").append(
      el(
        "p",
        "아직 원고가 없어요. 작업실에서 주제를 추천받고 '이 주제로 원고 만들기'를 눌러 보세요.",
        "empty-small",
      ),
    );
}
function field(label, value, change, options = {}) {
  const wrapper = el("label", label);
  const input = el(options.multiline ? "textarea" : "input");
  if (options.multiline) input.rows = options.rows || 3;
  input.value = value ?? "";
  input.maxLength = options.maxLength || 4000;
  if (options.attr) input.setAttribute(options.attr, "");
  input.addEventListener("input", () => {
    change(input.value);
    state.dirty = true;
    $("#draft-state").textContent = "저장하지 않은 수정";
  });
  wrapper.append(input);
  return wrapper;
}
async function openDraft(id, internal = false) {
  if (state.editingLocks && !internal)
    throw new Error("저장이 끝난 뒤 원고를 열어 주세요.");
  if (state.dirty && state.draft?.id === id) {
    document.querySelectorAll(".view").forEach((s) => {
      s.hidden = s.id !== "draft-editor";
    });
    highlightNav("drafts");
    return;
  }
  if (
    state.dirty &&
    state.draft?.id !== id &&
    !confirm("현재 수정 내용을 버리고 다른 원고를 열까요?")
  )
    return;
  await editingOperation(async () => {
    state.draft = await api("/api/drafts/" + id);
    state.dirty = false;
    renderDraft();
  });
}
function renderDraft() {
  const d = state.draft.draft;
  document.querySelectorAll(".view").forEach((s) => (s.hidden = true));
  $("#draft-editor").hidden = false;
  highlightNav("drafts");
  $("#draft-fields").replaceChildren();
  $("#draft-state").textContent =
    `v${state.draft.version} · ${state.draft.status === "reviewed" ? "사용자 검토 완료" : "검토할 초안"}`;
  const title = el("div", undefined, "card");
  title.append(
    field("제목", d.title, (v) => (d.title = v), { maxLength: 200 }),
    field("학습 목표", d.objective, (v) => (d.objective = v)),
  );
  $("#draft-fields").append(title);
  mountCardEditor($("#draft-fields"), {
    state,
    api,
    notice,
    run,
    editingOperation,
    renderDraft,
  });
  const quiz = el("details", undefined, "card quiz-editor");
  quiz.append(el("summary", "퀴즈와 해설 편집"));
  quiz.append(
    el("h2", "같은 개념의 퀴즈"),
    field("질문", d.quiz.question, (v) => (d.quiz.question = v), {
      multiline: true,
    }),
  );
  d.quiz.choices.forEach((c, i) =>
    quiz.append(field(`보기 ${i + 1}`, c, (v) => (d.quiz.choices[i] = v))),
  );
  const label = el("label", "정답");
  const select = el("select");
  d.quiz.choices.forEach((_, i) => {
    const opt = el("option", `보기 ${i + 1}`);
    opt.value = String(i);
    select.append(opt);
  });
  select.value = String(d.quiz.answer_index);
  select.onchange = () => {
    d.quiz.answer_index = Number(select.value);
    state.dirty = true;
    $("#draft-state").textContent = "저장하지 않은 수정";
  };
  label.append(select);
  quiz.append(
    label,
    field("해설", d.quiz.explanation, (v) => (d.quiz.explanation = v), {
      multiline: true,
    }),
  );
  d.quiz.choice_explanations.forEach((c, i) =>
    quiz.append(
      field(
        `보기 ${i + 1}의 판단 근거`,
        c,
        (v) => (d.quiz.choice_explanations[i] = v),
      ),
    ),
  );
  $("#draft-fields").append(quiz);
  const review = el("div", undefined, "card");
  review.append(el("h2", "사람이 확인할 항목"));
  d.review_items.forEach((item) => review.append(el("p", "□ " + item)));
  review.append(
    el("small", `참고 자료 ID: ${d.source_ids.join(", ") || "없음"}`, "muted"),
  );
  $("#draft-fields").append(review);
  $("#draft-feedback").value = "";
}
$("#open-draft").onclick = () => run(() => openDraft(state.lastDraftId));
$("#save-draft").onclick = () =>
  run(
    () =>
      editingOperation(async () => {
        state.draft = await api("/api/drafts/" + state.draft.id, {
          method: "PUT",
          body: {
            version: state.draft.version,
            draft: state.draft.draft,
            style: state.draft.style || null,
            feedback: $("#draft-feedback").value,
          },
        });
        state.dirty = false;
        renderDraft();
        notice("원고를 저장했어요.");
      }),
    $("#save-draft"),
  );
$("#review-draft").onclick = () =>
  run(() =>
    editingOperation(async () => {
      if (state.dirty) throw new Error("먼저 수정한 원고를 저장해 주세요.");
      if (
        !confirm(
          "수식·조건·정답을 직접 검토했나요? AI 생성 성공과 별개의 확인입니다.",
        )
      )
        return;
      state.draft = await api("/api/drafts/" + state.draft.id + "/review", {
        method: "POST",
        body: { version: state.draft.version, confirmed: true },
      });
      renderDraft();
      notice("사용자 검토 완료로 표시했어요.");
    }),
  );
$("#export-draft").onclick = () =>
  download("content-draft.json", {
    draft: state.draft.draft,
    style: state.draft.style,
  });
$("#export-markdown").onclick = () => {
  const d = state.draft.draft;
  const text =
    `# ${d.title}\n\n${d.objective}\n\n` +
    d.cards
      .map(
        (c, i) =>
          `## ${i + 1}. ${c.title}\n\n${c.body}\n\n수식: ${c.formula}\n조건: ${c.conditions}\n도식: ${c.diagram}`,
      )
      .join("\n\n") +
    `\n\n## 퀴즈\n${d.quiz.question}\n` +
    d.quiz.choices.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    `\n정답: ${d.quiz.answer_index + 1}\n${d.quiz.explanation}\n` +
    d.quiz.choice_explanations.map((c, i) => `보기 ${i + 1}: ${c}`).join("\n") +
    "\n\n## 검토 항목\n" +
    d.review_items.map((c) => "- " + c).join("\n") +
    "\n\n참고 ID: " +
    d.source_ids.join(", ");
  download("content-draft.md", text, "text/markdown");
};
let importPending;
$("#new-card-work").onclick = () => {
  $("#card-import").hidden = false;
  $("#import-title").focus();
};
$("#close-import").onclick = () => ($("#card-import").hidden = true);
$("#import-json").onchange = () =>
  run(async () => {
    const file = $("#import-json").files[0];
    if (!file) return;
    if (file.size > 300000)
      throw new Error("JSON 파일은 300KB 이하로 가져와 주세요.");
    const text = await file.text();
    JSON.parse(text);
    $("#import-text").value = text;
    notice("JSON 파일을 읽었어요. 카드로 가져오기를 눌러 저장하세요.");
  });
bindForm("#card-import", async () => {
  if (state.dirty) throw new Error("편집 중인 원고를 먼저 저장해 주세요.");
  const raw = $("#import-text").value.trim();
  const title = $("#import-title").value.trim() || "새 카드뉴스";
  let draft, style;
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    draft = parsed.draft || parsed;
    style = parsed.style;
  } else {
    const pages = raw
      ? raw.split(/^---\s*$/m).filter((p) => p.trim())
      : Array.from(
          { length: Number($("#import-count").value) },
          (_, i) => `카드 ${i + 1}\n여기에 내용을 작성하세요.`,
        );
    if (pages.length < 4 || pages.length > 10)
      throw new Error(
        "카드는 4~10장으로 나눠 주세요. 카드 사이는 --- 한 줄로 구분합니다.",
      );
    draft = {
      title,
      objective: "직접 가져온 원고 · 검토 후 사용",
      cards: pages.map((page, i) => {
        const [heading, ...body] = page.trim().split("\n");
        return {
          title: heading || `카드 ${i + 1}`,
          body: body.join("\n").trim() || heading,
          formula: "",
          conditions: "",
          diagram: "",
          artwork: [],
        };
      }),
      quiz: {
        question: "퀴즈 작성 전",
        choices: ["보기 1", "보기 2", "보기 3", "보기 4"],
        answer_index: 0,
        explanation: "해설 작성 전",
        choice_explanations: [
          "확인 필요",
          "확인 필요",
          "확인 필요",
          "확인 필요",
        ],
      },
      review_items: ["수식·도식·정답을 직접 확인하세요."],
      source_ids: [],
    };
  }
  const payload = { draft, ...(style ? { style } : {}) };
  const fingerprint = JSON.stringify(payload);
  if (importPending?.fingerprint !== fingerprint)
    importPending = { fingerprint, request_id: crypto.randomUUID() };
  state.draft = await api("/api/drafts", {
    method: "POST",
    body: { ...payload, request_id: importPending.request_id },
  });
  importPending = null;
  state.dirty = false;
  $("#card-import").hidden = true;
  $("#card-import").reset();
  renderDraft();
  notice("카드를 가져왔어요. 각 카드를 열어 이어서 편집하세요.");
});
$("#login").onclick = () =>
  run(async () => {
    if (!auth)
      throw new Error(
        "먼저 Firebase 웹 설정을 준비해 주세요. README에서 설정 방법을 확인할 수 있어요.",
      );
    await auth.login();
  });
$("#logout").onclick = () =>
  run(async () => {
    if (state.busy || state.editingLocks)
      throw new Error("저장과 답변 생성이 끝난 뒤 로그아웃해 주세요.");
    if (state.dirty && !confirm("저장하지 않은 원고가 있어요. 로그아웃할까요?"))
      return;
    await auth.logout();
  });
async function session(user) {
  state.user = user;
  imageReview.sessionChanged();
  $("#login").hidden = !!user;
  $("#logout").hidden = !user;
  $("#user-name").textContent = user?.displayName || "개인 작업실";
  $("#setup").hidden = !!user;
  if (!user) {
    state.contents = [];
    state.data = [];
    state.series = [];
    state.conversationId = null;
    state.draft = null;
    resetCardEditor();
    state.dirty = false;
    state.lastDraftId = null;
    state.pending = null;
    $("#messages").innerHTML = welcome;
    wireSuggestions();
    $("#ideas").replaceChildren();
    $("#draft-fields").replaceChildren();
    for (const id of [
      "content-list",
      "top-list",
      "history-list",
      "draft-list",
      "recent-drafts",
      "series-list",
      "data-list",
    ])
      $("#" + id).replaceChildren();
    $("#content-form").reset();
    resetData();
    $("#profile-form").reset();
    syncPrefBuilder("");
    $("#series-form").reset();
    $("#message").value = "";
    $("#open-draft").hidden = true;
    $("#summary-period").textContent = "로그인 후 데이터가 표시돼요.";
    for (const id of ["summary-average", "summary-count", "summary-trend"])
      $("#" + id).textContent = "—";
    $("#trend-chart").replaceChildren();
    $("#style-preview").textContent = "확인한 제작 선호가 아직 없어요.";
    renderSources();
    show("review");
    return;
  }
  try {
    await Promise.all([
      loadData(),
      loadContents(),
      loadPreferences(),
      loadDrafts(),
    ]);
    const id = localStorage.getItem(storageKey());
    if (id) {
      try {
        await loadConversation(id);
      } catch (e) {
        if (e.status === 404) localStorage.removeItem(storageKey());
        else throw e;
      }
    }
  } catch (e) {
    notice(e.message, true);
  }
}
try {
  auth = await connectAuth(session);
} catch (e) {
  $("#setup").hidden = false;
  notice(e.message, true);
}
