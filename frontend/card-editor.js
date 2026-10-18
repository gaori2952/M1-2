import { renderCard, exportCards, defaultStyle } from "./card-renderer.js";
const names = {
  title: "제목",
  body: "본문",
  formula: "수식",
  conditions: "적용 조건",
  diagram: "도식",
};
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const label = (text, input) => {
  const n = node("label", text);
  n.append(input);
  return n;
};
let activeId = null,
  activeIndex = 0,
  pending = null;
export function resetCardEditor() {
  activeId = null;
  activeIndex = 0;
  pending = null;
}
export function mountCardEditor(
  container,
  { state, api, notice, run, editingOperation, renderDraft },
) {
  const doc = state.draft,
    d = doc.draft;
  if (activeId !== doc.id) {
    activeId = doc.id;
    activeIndex = 0;
    pending = null;
  }
  if (activeIndex >= d.cards.length) activeIndex = 0;
  const root = node("div", undefined, "card-workbench");
  container.append(root);
  const selected = new Set();
  let history;
  const previews = [],
    panels = [],
    tabs = [];
  const action = (text, fn, cls = "secondary") => {
    const b = node("button", text, cls);
    b.type = "button";
    b.onclick = () => run(fn, b);
    return b;
  };
  const dirty = () => {
    state.dirty = true;
    document.querySelector("#draft-state").textContent = "저장하지 않은 수정";
  };
  const saved = () => {
    if (state.dirty)
      throw new Error(
        "먼저 원고를 저장해 주세요. 저장된 버전으로 검토·적용·복원합니다.",
      );
  };
  const selectCard = (i) => {
    activeIndex = i;
    history?.replaceChildren();
    panels.forEach((p, j) => (p.hidden = i !== j));
    tabs.forEach((t, j) => t.classList.toggle("selected", i === j));
  };
  const overview = node("div", undefined, "card-overview");
  const heading = node("div", undefined, "section-top");
  heading.append(node("h2", "카드 한눈에 보기"));
  heading.append(
    action("모두 선택", () => {
      selected.clear();
      d.cards.forEach((_, i) => selected.add(i));
      root
        .querySelectorAll("[data-card-select]")
        .forEach((c) => (c.checked = true));
      updateCount();
    }),
  );
  root.append(heading, overview);
  const workspace = node("div", undefined, "card-edit-layout");
  const editor = node("div", undefined, "card-page-editors");
  const side = node("aside", undefined, "card inspector");
  workspace.append(editor, side);
  root.append(workspace);
  function queuePreview(i) {
    const p = previews[i];
    clearTimeout(p.timer);
    const seq = ++p.seq;
    p.timer = setTimeout(async () => {
      try {
        const svg = await renderCard(d.cards[i], i, d.cards.length, doc.style);
        if (seq !== p.seq || !root.isConnected) return;
        p.full.replaceChildren(svg);
        p.thumb.replaceChildren(svg.cloneNode(true));
        p.error.hidden = true;
      } catch (e) {
        if (seq !== p.seq || !root.isConnected) return;
        p.full.replaceChildren(
          node("div", "미리보기를 확인해 주세요.", "preview-error"),
        );
        p.thumb.replaceChildren(node("span", "확인 필요"));
        p.error.textContent = e.message;
        p.error.hidden = false;
      }
    }, 120);
  }
  function textField(c, i, key, multiline = false) {
    const input = node(multiline ? "textarea" : "input");
    input.value = c[key] || "";
    input.maxLength = key === "title" ? 200 : key === "body" ? 4000 : 2000;
    if (multiline) input.rows = key === "body" ? 5 : 2;
    input.setAttribute(`data-card-${key}`, "");
    input.oninput = () => {
      c[key] = input.value;
      dirty();
      queuePreview(i);
    };
    return label(
      names[key] +
        (key === "formula"
          ? " · LaTeX"
          : key === "diagram"
            ? " · 그림 설명"
            : ""),
      input,
    );
  }
  d.cards.forEach((c, i) => {
    const tile = node("div", undefined, "card-thumb");
    tile.setAttribute("data-card-thumb", i);
    tabs.push(tile);
    const check = node("input");
    check.type = "checkbox";
    check.setAttribute("data-card-select", i);
    check.onchange = () => {
      check.checked ? selected.add(i) : selected.delete(i);
      updateCount();
    };
    const selectLabel = label(`${i + 1}번 선택`, check);
    selectLabel.className = "check";
    const thumb = node("div", undefined, "thumb-art");
    const open = action(
      `${String(i + 1).padStart(2, "0")} · ${c.title}`,
      () => selectCard(i),
      "thumb-open",
    );
    open.prepend(thumb);
    tile.append(open, selectLabel);
    overview.append(tile);
    const panel = node("section", undefined, "card card-page");
    panels.push(panel);
    const full = node("div", undefined, "card-preview"),
      error = node("p", undefined, "preview-error");
    error.hidden = true;
    error.setAttribute("role", "status");
    previews.push({ full, thumb, error, seq: 0 });
    panel.append(
      node(
        "span",
        `CARD ${String(i + 1).padStart(2, "0")} / ${d.cards.length}`,
        "eyebrow",
      ),
      full,
      error,
    );
    const inputs = node("div", undefined, "card-inputs");
    for (const key of Object.keys(names))
      inputs.append(textField(c, i, key, ["body", "diagram"].includes(key)));
    const drawing = node("details", undefined, "drawing-editor");
    drawing.append(node("summary", "도식 요소 직접 편집"));
    drawing.append(
      node(
        "p",
        "위치 범위: 가로 0–1000, 세로 0–360. 선·화살표는 시작점 → 끝점, 도형은 두 모서리입니다.",
        "muted",
      ),
    );
    const elements = node("div");
    drawing.append(elements);
    function renderElements() {
      elements.replaceChildren();
      (c.artwork || []).forEach((e, j) => {
        const row = node("div", undefined, "drawing-row");
        row.setAttribute("data-drawing-row", "");
        const kind = node("select");
        for (const [v, t] of Object.entries({
          line: "선",
          arrow: "화살표",
          circle: "원·타원",
          rect: "사각형",
          text: "라벨",
        })) {
          const o = node("option", t);
          o.value = v;
          kind.append(o);
        }
        kind.value = e.kind;
        kind.onchange = () => {
          e.kind = kind.value;
          dirty();
          queuePreview(i);
        };
        row.append(label("요소", kind));
        for (const k of ["x", "y", "x2", "y2"]) {
          const input = node("input");
          input.type = "number";
          input.min = 0;
          input.max = k.startsWith("x") ? 1000 : 360;
          input.value = e[k];
          input.oninput = () => {
            if (!input.checkValidity()) return;
            e[k] = Number(input.value);
            dirty();
            queuePreview(i);
          };
          row.append(label(k, input));
        }
        const text = node("input");
        text.maxLength = 80;
        text.value = e.text;
        text.oninput = () => {
          e.text = text.value;
          dirty();
          queuePreview(i);
        };
        row.append(
          label("라벨", text),
          action("삭제", () => {
            c.artwork.splice(j, 1);
            dirty();
            renderElements();
            queuePreview(i);
          }),
        );
        elements.append(row);
      });
    }
    renderElements();
    drawing.append(
      action("＋ 도식 요소", () => {
        if ((c.artwork || []).length >= 24)
          throw new Error("도식 요소는 최대 24개예요.");
        c.artwork ??= [];
        c.artwork.push({
          kind: "arrow",
          x: 180,
          y: 150,
          x2: 680,
          y2: 150,
          text: "",
        });
        dirty();
        renderElements();
        queuePreview(i);
      }),
    );
    panel.append(inputs, drawing);
    editor.append(panel);
    queuePreview(i);
  });
  selectCard(activeIndex);
  side.append(
    node("span", "FOCUSED EDIT", "eyebrow"),
    node("h2", "선택한 부분만 고치기"),
  );
  const count = node("p", "카드를 선택해 주세요.", "selection-count");
  side.append(count);
  function updateCount() {
    count.textContent = selected.size
      ? `${[...selected]
          .sort((a, b) => a - b)
          .map((i) => i + 1)
          .join(", ")}번 카드 선택`
      : "카드를 선택해 주세요.";
  }
  const scopes = node("fieldset", undefined, "scope-fields");
  scopes.append(node("legend", "수정할 수 있는 항목"));
  for (const [key, name] of Object.entries(names)) {
    const c = node("input");
    c.type = "checkbox";
    c.value = key;
    c.checked = key === "body";
    c.setAttribute("data-scope", key);
    const l = label(name, c);
    l.className = "check";
    scopes.append(l);
  }
  const instruction = node("textarea");
  instruction.id = "revision-instruction";
  instruction.rows = 4;
  instruction.maxLength = 4000;
  instruction.placeholder =
    "예: 3번 도식의 화살표 방향만 고쳐줘. 확인할 근거가 부족하면 알려줘.";
  const propose = action(
    "검토·수정안 받기",
    () =>
      editingOperation(async () => {
        saved();
        const indices = [...selected].sort((a, b) => a - b),
          fields = [...scopes.querySelectorAll("input:checked")].map(
            (n) => n.value,
          );
        if (!indices.length || !fields.length || !instruction.value.trim())
          throw new Error("카드, 수정 항목, 요청 내용을 지정해 주세요.");
        const body = {
          version: doc.version,
          card_indices: indices,
          fields,
          instruction: instruction.value.trim(),
        };
        const fingerprint = JSON.stringify([doc.id, body]);
        if (pending?.fingerprint !== fingerprint)
          pending = { fingerprint, request_id: crypto.randomUUID() };
        propose.textContent = "선택한 카드를 검토하고 있어요…";
        try {
          const p = await api(`/api/drafts/${doc.id}/proposals`, {
            method: "POST",
            body: { ...body, request_id: pending.request_id },
          });
          pending = null;
          showProposal(p);
          notice("수정안을 비교해 보세요. 아직 원고는 바뀌지 않았어요.");
        } catch (e) {
          if ([400, 401, 403, 404, 422, 429, 502].includes(e.status))
            pending = null;
          throw e;
        } finally {
          propose.textContent = "검토·수정안 받기";
        }
      }),
    "primary",
  );
  propose.id = "propose-cards";
  side.append(
    scopes,
    label("이번 요청", instruction),
    propose,
    node(
      "p",
      "수정안 확인 → 적용할 카드 선택 → 반영. AI 검토는 정확성을 보증하지 않아요.",
      "muted",
    ),
  );
  const proposalArea = node("section", undefined, "proposal-area");
  root.append(proposalArea);
  function showProposal(p) {
    proposalArea.replaceChildren(
      node("h2", "수정 전후 비교"),
      node("p", p.summary || "처리 중인 요청입니다."),
    );
    if (!p.patches) return;
    const accepted = new Set(p.patches.map((x) => x.card_index));
    for (const patch of p.patches) {
      const box = node("article", undefined, "card proposal-diff");
      box.setAttribute("data-proposal-diff", "");
      const choice = node("input");
      choice.type = "checkbox";
      choice.checked = true;
      choice.onchange = () =>
        choice.checked
          ? accepted.add(patch.card_index)
          : accepted.delete(patch.card_index);
      const l = label(`${patch.card_index + 1}번 카드 적용`, choice);
      l.className = "check";
      box.append(l);
      patch.findings.forEach((f) => box.append(node("p", f, "review-finding")));
      let changed = false;
      for (const field of [
        ...p.fields,
        ...(p.fields.includes("diagram") ? ["artwork"] : []),
      ]) {
        const before = patch.before[field] ?? (field === "artwork" ? [] : ""),
          after = patch.after[field] ?? (field === "artwork" ? [] : "");
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        changed = true;
        box.append(node("strong", names[field] || "도식 요소"));
        const row = node("div", undefined, "diff-columns");
        for (const [labelText, v] of [
          ["수정 전", before],
          ["제안", after],
        ]) {
          const col = node("div");
          col.append(
            node("small", labelText),
            node("pre", typeof v === "string" ? v : JSON.stringify(v, null, 2)),
          );
          row.append(col);
        }
        box.append(row);
      }
      if (p.fields.includes("diagram")) {
        const pair = node("div", undefined, "diff-columns");
        for (const card of [patch.before, patch.after]) {
          const slot = node("div", undefined, "diff-preview");
          pair.append(slot);
          renderCard(card, patch.card_index, d.cards.length, doc.style)
            .then((svg) => slot.append(svg))
            .catch((e) => slot.append(node("p", e.message, "preview-error")));
        }
        box.append(pair);
      }
      if (!changed) box.append(node("p", "이 카드에는 변경 제안이 없어요."));
      proposalArea.append(box);
    }
    const apply = action(
      "선택한 수정안 적용",
      () =>
        editingOperation(async () => {
          saved();
          if (!accepted.size) throw new Error("적용할 카드를 선택해 주세요.");
          state.draft = await api(
            `/api/drafts/${doc.id}/proposals/${p.id}/apply`,
            {
              method: "POST",
              body: {
                version: p.version,
                card_indices: [...accepted].sort((a, b) => a - b),
              },
            },
          );
          state.dirty = false;
          renderDraft();
          notice("선택한 카드에 수정안을 적용했어요.");
        }),
      "primary",
    );
    apply.disabled = p.status !== "ready" || p.version !== doc.version;
    proposalArea.append(apply);
    if (apply.disabled)
      proposalArea.append(
        node(
          "p",
          "이미 적용했거나 이전 버전의 제안입니다. 현재 원고에서 새 검토를 요청하세요.",
          "muted",
        ),
      );
    proposalArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  side.append(
    action("이전 검토 제안 보기", () =>
      editingOperation(async () => {
        saved();
        const proposals = await api(`/api/drafts/${doc.id}/proposals`);
        proposalArea.replaceChildren(node("h2", "검토 제안 이력"));
        if (!proposals.length)
          proposalArea.append(node("p", "아직 검토 제안이 없어요."));
        proposals.forEach((p) =>
          proposalArea.append(
            action(
              `${new Date(p.created_at).toLocaleString("ko-KR")} · ${p.status} · ${p.instruction}`,
              () => showProposal(p),
            ),
          ),
        );
      }),
    ),
  );
  history = node("div", undefined, "card-history");
  side.append(history);
  const historyButton = action("현재 카드의 수정 이력", () =>
    editingOperation(async () => {
      saved();
      const historyIndex = activeIndex;
      const revisions = await api(`/api/drafts/${doc.id}/revisions`);
      history.replaceChildren();
      const changed = revisions.filter(
        (r) =>
          JSON.stringify(r.before.cards[historyIndex]) !==
          JSON.stringify(r.after.cards[historyIndex]),
      );
      if (!changed.length)
        history.append(
          node("p", "이 카드의 저장된 수정 이력이 없어요.", "muted"),
        );
      for (const r of changed) {
        const before = r.before.cards[historyIndex];
        if (!before) continue;
        history.append(
          node(
            "p",
            `${new Date(r.created_at).toLocaleString("ko-KR")} · ${r.note || "직접 수정"}`,
            "muted",
          ),
        );
        const preview = node("details");
        preview.append(
          node("summary", "복원할 내용 보기"),
          node(
            "pre",
            Object.keys(names)
              .map((k) => `${names[k]}: ${before[k] || ""}`)
              .join("\n"),
          ),
        );
        history.append(preview);
        history.append(
          action(`이 수정 전으로 ${historyIndex + 1}번 카드 복원`, () =>
            editingOperation(async () => {
              saved();
              state.draft = await api(`/api/drafts/${doc.id}/restore`, {
                method: "POST",
                body: {
                  version: doc.version,
                  revision_id: r.id,
                  card_index: historyIndex,
                },
              });
              state.dirty = false;
              renderDraft();
              notice("이 카드만 이전 상태로 복원했어요.");
            }),
          ),
        );
      }
    }),
  );
  historyButton.id = "card-history";
  side.append(historyButton);
  const design = node("details", undefined, "template-settings");
  design.append(node("summary", "고정 디자인 설정"));
  const style = { ...defaultStyle, ...doc.style };
  const brand = node("input");
  brand.value = style.brand;
  brand.maxLength = 40;
  brand.oninput = () => {
    doc.style = { ...style, ...doc.style, brand: brand.value };
    dirty();
    d.cards.forEach((_, i) => queuePreview(i));
  };
  design.append(label("브랜드", brand));
  for (const [key, options] of Object.entries({
    accent: { ink: "잉크", blue: "블루", green: "그린" },
    paper: { white: "화이트", warm: "웜 화이트" },
  })) {
    const select = node("select");
    for (const [v, t] of Object.entries(options)) {
      const o = node("option", t);
      o.value = v;
      select.append(o);
    }
    select.value = style[key];
    select.onchange = () => {
      doc.style = { ...style, ...doc.style, [key]: select.value };
      dirty();
      d.cards.forEach((_, i) => queuePreview(i));
    };
    design.append(label(key === "accent" ? "글·도식 색" : "종이 색", select));
  }
  design.append(
    node(
      "p",
      "이 설정은 AI가 바꾸지 않아요. 완성 이미지의 디자인을 자동 추출하는 기능은 제공하지 않습니다.",
      "muted",
    ),
  );
  side.append(design);
  const downloads = node("div", undefined, "export-actions");
  for (const [id, text, all] of [
    ["export-card-png", "현재 카드 PNG", false],
    ["export-card-zip", `전체 ${d.cards.length}장 PNG · ZIP`, true],
  ]) {
    const b = action(
      text,
      () =>
        editingOperation(async () => {
          notice("카드를 이미지로 만들고 있어요…");
          await exportCards(doc, all ? null : activeIndex);
          notice("이미지 파일을 준비했어요.");
        }),
      all ? "primary" : "secondary",
    );
    b.id = id;
    downloads.append(b);
  }
  side.append(
    downloads,
    node(
      "p",
      "1080 × 1080 · 글이 넘치거나 수식 오류가 있으면 해당 카드를 먼저 고쳐 주세요.",
      "muted",
    ),
  );
}
