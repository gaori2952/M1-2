import {
  prepareFile,
  putImages,
  getImage,
  saveReviewSession,
  getReviewSession,
} from "./review-images.js";

const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const category = {
  error: "수정 필요",
  uncertain: "확인 필요",
  improvement: "표현 개선",
};
const resolution = {
  resolved: "해결됨",
  remaining: "남아 있음",
  uncertain: "판단 보류",
};
const payload = (asset, card) => ({
  card_id: card.card_id,
  name: card.name,
  sha256: asset.sha256,
  mime: asset.mime,
  base64: asset.base64,
});

export function mountImageReview(root, { api, getUser, notice }) {
  let generation = 0,
    busy = false,
    selected = [],
    doc = null,
    active = 0;
  let staged = new Map(),
    historical = null,
    pending = null,
    createId = null;
  let urls = [],
    account = null;
  let form = { title: "카드뉴스 검토", criteria: null, saveCriteria: false },
    creation = null;
  const current = () => account && getUser()?.uid === account;
  const scoped = () => {
    const epoch = generation;
    return () => {
      if (epoch !== generation || !current())
        throw new Error("로그인이 변경되었어요.");
    };
  };
  const cleanup = () => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
  };
  const image = (asset, alt, cls = "") => {
    const img = node("img", undefined, cls);
    const url = URL.createObjectURL(asset.blob);
    urls.push(url);
    img.src = url;
    img.alt = alt;
    return img;
  };
  const b = (text, handler, cls = "secondary") => {
    const n = node("button", text, cls);
    n.type = "button";
    n.addEventListener("click", () => perform(handler));
    return n;
  };
  async function perform(fn) {
    if (busy) return;
    const epoch = generation;
    busy = true;
    root.setAttribute("aria-busy", "true");
    root
      .querySelectorAll("button,input,textarea")
      .forEach((n) => (n.disabled = true));
    try {
      await fn();
    } catch (e) {
      if (epoch === generation) notice(e.message, true);
    } finally {
      if (epoch === generation) {
        busy = false;
        root.removeAttribute("aria-busy");
        root
          .querySelectorAll("button,input,textarea")
          .forEach((n) => (n.disabled = false));
        root
          .querySelectorAll("[data-read-only]")
          .forEach((n) => (n.disabled = true));
        if (pending)
          root
            .querySelectorAll("#review-all,#review-one,#review-replace")
            .forEach((n) => (n.disabled = true));
        if (doc)
          root
            .querySelectorAll("#review-one")
            .forEach(
              (n) => (n.disabled = !staged.has(doc.cards[active]?.card_id)),
            );
      }
    }
  }
  async function persist(extra = {}) {
    const assert = scoped();
    await saveReviewSession(account, {
      review_id: doc?.id || null,
      pending,
      createId,
      creation,
      form,
      selected,
      staged: [...staged],
      ...extra,
    });
    assert();
  }
  async function addFiles(files) {
    const assert = scoped();
    if (!current()) throw new Error("Google 로그인 후 이미지를 선택해 주세요.");
    if (creation)
      throw new Error("생성 중이던 작업을 먼저 같은 요청으로 복구해 주세요.");
    const failures = [];
    for (const file of [...files].sort((a, b) =>
      a.name.localeCompare(b.name, "ko", { numeric: true }),
    )) {
      if (selected.length >= 10) {
        failures.push("한 번에 최대 10장까지 선택할 수 있어요.");
        break;
      }
      try {
        const asset = await prepareFile(file);
        assert();
        await putImages(account, [asset]);
        assert();
        selected.push({
          card_id: crypto.randomUUID(),
          name: asset.name,
          sha256: asset.sha256,
        });
        createId = null;
      } catch (e) {
        assert();
        failures.push(e.message);
      }
    }
    await persist();
    await renderHome();
    assert();
    if (failures.length) notice(failures.join("\n"), true);
  }
  function uploadInput(id, label, handler, multiple = false) {
    const wrap = node("label", label, "review-file-button");
    const input = node("input");
    input.id = id;
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.multiple = multiple;
    input.addEventListener("change", () => {
      const files = [...input.files];
      input.value = "";
      perform(() => handler(files));
    });
    wrap.append(input);
    return wrap;
  }
  async function renderHome() {
    const assert = scoped();
    cleanup();
    doc = null;
    historical = null;
    root.replaceChildren();
    const head = node("div", undefined, "review-heading");
    const text = node("div");
    text.append(
      node("span", "BEFORE YOU PUBLISH", "eyebrow"),
      node("h1", "올리기 전에, 한 번 더."),
      node("p", "완성한 카드뉴스를 올리면 장마다 고칠 곳을 짚어드려요."),
    );
    head.append(text, node("span", "IMAGE REVIEW", "review-wordmark"));
    root.append(head);
    const drop = node("section", undefined, "review-drop");
    drop.append(
      node("div", "▧", "review-upload-icon"),
      node("h2", "카드뉴스를 한 번에 올려주세요"),
      node("p", "수식 · 개념 · 도식부터 가독성 · 디자인 일관성까지"),
    );
    drop.append(
      uploadInput("review-upload", "이미지 선택", addFiles, true),
      node("small", "PNG, JPEG, WebP · 최대 10장 · 원본 한 장당 10MB"),
    );
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragging");
      perform(() => addFiles(e.dataTransfer.files));
    });
    root.append(drop);
    if (selected.length) {
      const section = node("section", undefined, "review-preflight");
      section.append(
        node("h2", `검토할 카드 ${selected.length}장`),
        node(
          "p",
          "순서를 확인해 주세요. 같은 파일명도 각각의 카드로 구분해요.",
          "muted",
        ),
      );
      const list = node("div", undefined, "review-upload-grid");
      for (let i = 0; i < selected.length; i++) {
        const card = selected[i],
          asset = await getImage(account, card.sha256);
        assert();
        const tile = node("article", undefined, "review-upload-tile");
        tile.dataset.uploadCard = card.card_id;
        if (asset) tile.append(image(asset, `${i + 1}번 업로드 카드`));
        else tile.append(node("p", "이미지를 다시 선택해 주세요."));
        tile.append(
          node("strong", `${String(i + 1).padStart(2, "0")} · ${card.name}`),
        );
        const controls = node("div", undefined, "review-tile-controls");
        for (const [title, delta] of [
          ["앞으로", -1],
          ["뒤로", 1],
        ]) {
          const n = b(title, async () => {
            if (creation)
              throw new Error("생성 요청 복구 후 순서를 변경해 주세요.");
            const j = i + delta;
            if (j < 0 || j >= selected.length) return;
            [selected[i], selected[j]] = [selected[j], selected[i]];
            createId = null;
            await persist();
            await renderHome();
          });
          n.disabled = i + delta < 0 || i + delta >= selected.length;
          controls.append(n);
        }
        controls.append(
          b("제외", async () => {
            if (creation) throw new Error("생성 요청 복구 후 변경해 주세요.");
            selected.splice(i, 1);
            createId = null;
            await persist();
            await renderHome();
          }),
        );
        tile.append(controls);
        list.append(tile);
      }
      section.append(list);
      const titleLabel = node("label", "검토 제목");
      const title = node("input");
      title.id = "review-title";
      title.maxLength = 120;
      title.value = form.title;
      titleLabel.append(title);
      const criteriaLabel = node("label", "특히 확인할 점 · 선택");
      const criteria = node("textarea");
      criteria.id = "review-criteria";
      criteria.rows = 2;
      criteria.maxLength = 1000;
      criteria.placeholder = "예: 부호와 단위, 화살표 방향을 특히 봐줘";
      criteria.value =
        form.criteria ??
        localStorage.getItem(`image-review:${account}:criteria`) ??
        "";
      criteriaLabel.append(criteria);
      const saveLabel = node("label", undefined, "review-check");
      const save = node("input");
      save.type = "checkbox";
      save.id = "review-save-criteria";
      save.checked = form.saveCriteria;
      saveLabel.append(save, node("span", "이 기준을 다음 검토에도 사용"));
      title.addEventListener("input", () => {
        form.title = title.value;
      });
      criteria.addEventListener("input", () => {
        form.criteria = criteria.value;
      });
      save.addEventListener("change", () => {
        form.saveCriteria = save.checked;
      });
      if (creation) {
        title.readOnly = true;
        criteria.readOnly = true;
        section.append(
          node(
            "p",
            "이전에 생성하던 작업이 있어요. 전체 검토를 누르면 같은 요청으로 이어갑니다.",
            "review-version-note",
          ),
        );
      }
      const start = b(
        "전체 검토",
        async () => {
          const assert = scoped();
          if (!current()) throw new Error("Google 로그인 후 이용해 주세요.");
          if (!title.value.trim())
            throw new Error("검토 제목을 입력해 주세요.");
          const cards = [...selected];
          for (const card of cards)
            if (!(await getImage(account, card.sha256)))
              throw new Error("브라우저에 없는 이미지를 다시 선택해 주세요.");
          assert();
          createId ||= crypto.randomUUID();
          creation ||= {
            request_id: createId,
            title: title.value.trim(),
            criteria: criteria.value.trim(),
            cards,
          };
          await persist();
          assert();
          const created = await api("/api/image-reviews", {
            method: "POST",
            body: creation,
          });
          assert();
          if (save.checked)
            localStorage.setItem(
              `image-review:${account}:criteria`,
              criteria.value.trim(),
            );
          doc = created;
          selected = [];
          active = 0;
          createId = null;
          creation = null;
          staged.clear();
          pending = null;
          await persist();
          await startRun(null);
        },
        "primary",
      );
      start.id = "review-start";
      section.append(titleLabel, criteriaLabel, saveLabel, start);
      root.append(section);
    }
    const note = node(
      "p",
      "이미지는 이 브라우저에 보관됩니다. 검토할 때 현재 설정된 AI 제공업체로 전송되며, 검토 결과는 계정에 저장됩니다.",
      "review-storage-note",
    );
    root.append(note);
    const recent = node("section", undefined, "review-recent");
    recent.append(node("h2", "이전 검토"));
    root.append(recent);
    if (!current()) {
      recent.append(
        node(
          "p",
          "Google 로그인 후 검토를 시작하고 기록을 불러올 수 있어요.",
          "muted",
        ),
      );
      return;
    }
    const sessions = await api("/api/image-reviews");
    assert();
    if (!sessions.length)
      recent.append(node("p", "아직 검토한 카드뉴스가 없어요.", "muted"));
    for (const s of sessions) {
      const item = b(
        `${s.title} · ${s.card_count}장 · ${s.version ? "검토 결과 보기" : "검토 시작하기"}`,
        async () => {
          const assert = scoped();
          pending = null;
          staged.clear();
          historical = null;
          doc = await api(`/api/image-reviews/${s.id}`);
          assert();
          active = 0;
          await persist();
          await renderWork();
        },
        "review-recent-item",
      );
      recent.append(item);
    }
  }
  async function loadCurrent() {
    const assert = scoped();
    doc = await api(`/api/image-reviews/${doc.id}`);
    assert();
    historical = null;
    await persist();
    await renderWork();
  }
  async function startRun(target) {
    const assert = scoped();
    if (!pending) {
      const images = [];
      for (const c of doc.cards) {
        const asset =
          ((!target || target === c.card_id) && staged.get(c.card_id)) ||
          (await getImage(account, c.sha256));
        assert();
        if (!asset)
          throw new Error(
            "이 브라우저에 없는 이미지를 먼저 다시 선택해 주세요.",
          );
        images.push(payload(asset, c));
      }
      let previous_image = null;
      if (target) {
        const c = doc.cards.find((c) => c.card_id === target),
          prior = await getImage(account, c.sha256);
        assert();
        if (!prior) throw new Error("직전 버전 이미지를 다시 선택해 주세요.");
        previous_image = payload(prior, c);
      }
      pending = {
        request_id: crypto.randomUUID(),
        version: doc.version,
        target_card_id: target,
        images,
        previous_image,
      };
    }
    // Every send, including a retry, requires a durable request UUID first.
    await persist();
    assert();
    await renderWork();
    assert();
    const status = root.querySelector("#review-progress");
    if (status) {
      status.hidden = false;
      status.textContent =
        "이미지와 수식, 장 사이 연결을 검토하고 있어요. 잠시 기다려 주세요.";
    }
    try {
      await api(`/api/image-reviews/${doc.id}/runs`, {
        method: "POST",
        body: pending,
      });
      assert();
      const completedTarget = pending.target_card_id;
      pending = null;
      if (completedTarget) staged.delete(completedTarget);
      else staged.clear();
      await loadCurrent();
      notice(
        "이미지 검토 결과를 저장했어요. 지적과 판독 한계를 확인해 주세요.",
      );
    } catch (e) {
      assert();
      await persist();
      await renderWork();
      throw e;
    }
  }
  async function recover() {
    const assert = scoped();
    const status = await api(
      `/api/image-reviews/${doc.id}/runs/${pending.request_id}`,
    );
    assert();
    if (status.status === "ready") {
      const completedTarget = pending.target_card_id;
      pending = null;
      if (completedTarget) staged.delete(completedTarget);
      else staged.clear();
      await loadCurrent();
      notice("저장된 검토 결과를 복구했어요.");
    } else if (["failed", "interrupted"].includes(status.status)) {
      pending = null;
      await persist();
      await renderWork();
      notice(
        "직전 검토는 완료되지 않았어요. 이미지를 유지했으니 새 검토를 실행해 주세요.",
        true,
      );
    } else notice("아직 검토 중이에요. 잠시 후 상태를 다시 확인해 주세요.");
  }
  async function renderWork() {
    const assert = scoped();
    cleanup();
    root.replaceChildren();
    const head = node("div", undefined, "review-heading");
    const text = node("div");
    text.append(
      node("span", "YOUR DESIGN, A SECOND LOOK", "eyebrow"),
      node("h1", doc.title),
      node(
        "p",
        `${doc.cards.length}장 · ${doc.version ? `검토 ${doc.version}회` : "첫 검토 전"} · 이미지는 그대로, 검토는 장별로`,
      ),
    );
    const actions = node("div", undefined, "review-head-actions");
    actions.append(
      b("새 검토", async () => {
        if (
          staged.size &&
          !confirm(
            "교체 중인 이미지를 남겨 두고 새 검토로 이동할까요? 이전 검토를 다시 열면 교체 이미지는 다시 선택해야 해요.",
          )
        )
          return;
        staged.clear();
        pending = null;
        doc = null;
        await persist();
        await renderHome();
      }),
    );
    if (!historical) {
      const all = b(
        doc.version ? "전체 다시 검토" : "전체 검토",
        () => startRun(null),
        "primary",
      );
      all.id = "review-all";
      actions.append(all);
    }
    head.append(text, actions);
    root.append(head);
    const progress = node("p", undefined, "review-progress");
    progress.id = "review-progress";
    progress.setAttribute("role", "status");
    progress.hidden = true;
    root.append(progress);
    if (pending) {
      const recovery = node("div", undefined, "review-recovery");
      recovery.append(
        node(
          "p",
          "완료 응답을 기다리는 검토가 있어요. 상태를 확인하면 중복 호출 없이 결과를 불러올 수 있어요.",
        ),
        b("검토 상태 확인", recover),
        b("같은 요청 재시도", () => startRun(pending.target_card_id)),
      );
      root.append(recovery);
    }
    const layout = node("div", undefined, "review-layout");
    const rail = node("aside", undefined, "review-rail");
    rail.setAttribute("aria-label", "검토할 카드");
    for (let i = 0; i < doc.cards.length; i++) {
      const c = doc.cards[i];
      const asset =
        staged.get(c.card_id) || (await getImage(account, c.sha256));
      assert();
      const card = b(
        "",
        async () => {
          active = i;
          historical = null;
          await renderWork();
        },
        `review-card ${active === i ? "selected" : ""}`,
      );
      card.dataset.reviewCard = c.card_id;
      card.setAttribute("aria-label", `${i + 1}번 카드 보기`);
      if (asset) card.append(image(asset, `${i + 1}번 카드 썸네일`));
      else card.append(node("span", "이미지 없음", "review-missing-thumb"));
      card.append(
        node("strong", `${String(i + 1).padStart(2, "0")}`),
        node(
          "small",
          staged.has(c.card_id)
            ? "재검토 필요"
            : c.result
              ? `지적 ${c.result.findings.length}개`
              : "검토 전",
        ),
      );
      rail.append(card);
    }
    rail.append(b("전체 카드 연결 검토", () => renderConnections()));
    layout.append(rail);
    const c = doc.cards[active];
    const shown = historical || c;
    const asset = historical
      ? await getImage(account, historical.sha256)
      : staged.get(c.card_id) || (await getImage(account, c.sha256));
    assert();
    const canvas = node("section", undefined, "review-canvas");
    const cardTitle = node("div", undefined, "review-canvas-label");
    cardTitle.append(
      node("strong", `CARD ${String(active + 1).padStart(2, "0")}`),
      node("span", c.name),
    );
    canvas.append(cardTitle);
    if (asset) {
      const preview = b(
        "",
        () => {
          const dialog = node("dialog", undefined, "review-zoom");
          const close = b("닫기", () => dialog.close());
          dialog.append(
            close,
            image(asset, `${active + 1}번 카드 확대 이미지`),
          );
          document.body.append(dialog);
          dialog.addEventListener("close", () => dialog.remove());
          dialog.showModal();
        },
        "review-image-button",
      );
      preview.setAttribute("aria-label", "카드 이미지 확대");
      preview.append(image(asset, `${active + 1}번 카드 전체 이미지`));
      canvas.append(preview);
    } else
      canvas.append(
        node(
          "p",
          "이 브라우저에 이미지가 없어요. 같은 파일을 다시 선택하면 기존 결과와 함께 볼 수 있어요.",
          "review-missing",
        ),
      );
    if (historical) {
      canvas.append(
        node(
          "p",
          `이전 버전 ${historical.version} · 읽기 전용`,
          "review-version-note",
        ),
        b("현재 버전으로 돌아가기", async () => {
          historical = null;
          await renderWork();
        }),
      );
      if (!asset)
        canvas.append(
          uploadInput(
            "review-restore-history",
            "이 버전 이미지 다시 선택",
            async (files) => {
              if (!files[0]) return;
              const restored = await prepareFile(files[0]);
              assert();
              if (restored.sha256 !== shown.sha256)
                throw new Error(
                  "이전 버전의 이미지와 달라요. 해당 버전의 같은 파일을 선택해 주세요.",
                );
              await putImages(account, [restored]);
              assert();
              await renderWork();
            },
          ),
        );
    } else {
      if (staged.has(c.card_id))
        canvas.append(
          node("p", "새 이미지 · 재검토 필요", "review-version-note"),
        );
      canvas.append(
        uploadInput(
          "review-replace",
          asset ? "수정 이미지로 교체" : "이미지 다시 선택",
          async (files) => {
            if (!files[0]) return;
            const a = await prepareFile(files[0]);
            assert();
            if (!(await getImage(account, c.sha256)) && a.sha256 !== c.sha256)
              throw new Error(
                "기존 이미지와 달라요. 먼저 같은 이미지를 선택해 복구해 주세요.",
              );
            await putImages(account, [a]);
            assert();
            if (a.sha256 === c.sha256) staged.delete(c.card_id);
            else staged.set(c.card_id, a);
            await persist();
            await renderWork();
          },
        ),
      );
      if (staged.has(c.card_id))
        canvas.append(
          b("이미지 교체 취소", async () => {
            staged.delete(c.card_id);
            await persist();
            await renderWork();
          }),
        );
      if (doc.version) {
        const one = b("이 장 재검토", () => startRun(c.card_id), "primary");
        one.id = "review-one";
        one.disabled = !staged.has(c.card_id);
        canvas.append(one);
      }
      const history = b("이전 버전 보기", async () => {
        const versions = await api(
          `/api/image-reviews/${doc.id}/cards/${c.card_id}/versions`,
        );
        assert();
        const list = root.querySelector("#review-version-list");
        list.replaceChildren();
        for (const v of versions)
          list.append(
            b(`버전 ${v.version} 보기`, async () => {
              historical = v;
              await renderWork();
            }),
          );
        if (!versions.length)
          list.append(node("p", "아직 검토 이력이 없어요."));
      });
      history.id = "review-versions";
      canvas.append(history, node("div", undefined, "review-version-list"));
      canvas.lastChild.id = "review-version-list";
    }
    layout.append(canvas);
    const results = node("section", undefined, "review-results");
    results.id = "review-results";
    results.setAttribute("aria-label", "선택한 카드 검토 결과");
    results.append(
      node("span", "REVIEW NOTES", "eyebrow"),
      node("h2", `${active + 1}번 카드 검토`),
    );
    if (staged.has(c.card_id) && !historical)
      results.append(
        node(
          "p",
          "아래는 직전 이미지의 결과예요. 새 이미지의 재검토가 끝나면 갱신됩니다.",
          "review-version-note",
        ),
      );
    if (shown.result) {
      results.append(node("p", shown.result.summary, "review-result-summary"));
      for (const r of shown.result.resolutions) {
        const block = node("article", undefined, "review-resolution");
        block.append(
          node("p", `AI 판단: ${resolution[r.status]}`),
          node(
            "strong",
            r.previous_finding?.location ||
              `이전 지적 ${r.finding_id.slice(0, 8)}`,
          ),
        );
        if (r.previous_finding?.evidence)
          block.append(node("p", r.previous_finding.evidence));
        results.append(block);
      }
      if (!shown.result.findings.length)
        results.append(node("p", "이번 검토에서 지적 없음", "review-empty"));
      for (const f of shown.result.findings)
        results.append(finding(f, !!historical));
    } else
      results.append(
        node(
          "p",
          "전체 검토를 실행하면 수식·개념·도식부터 차례로 확인해요.",
          "review-empty",
        ),
      );
    results.append(
      node(
        "p",
        "AI는 작은 글자나 복잡한 수식을 잘못 읽을 수 있어요. 최종 판단은 원본과 함께 확인해 주세요.",
        "review-disclaimer",
      ),
    );
    layout.append(results);
    root.append(layout);
    root.append(
      node(
        "p",
        "이미지는 이 브라우저에 보관됩니다. 다른 기기에서는 같은 이미지를 다시 선택해야 해요.",
        "review-storage-note",
      ),
    );
    if (busy)
      root
        .querySelectorAll("button,input,textarea")
        .forEach((n) => (n.disabled = true));
  }
  function finding(f, readOnly = false) {
    const box = node("article", undefined, `review-finding ${f.category}`);
    box.append(
      node("span", category[f.category], "review-badge"),
      node("h3", f.location),
      node("blockquote", f.evidence),
    );
    box.append(
      node("p", f.reason),
      node("strong", "수정 제안"),
      node("p", f.suggestion, "review-suggestion"),
    );
    const label = node("label", undefined, "review-check");
    const check = node("input");
    check.type = "checkbox";
    check.checked = !!f.checked;
    check.disabled = readOnly;
    if (readOnly) check.dataset.readOnly = "";
    check.dataset.findingCheck = f.id;
    check.addEventListener("change", () => {
      const intended = check.checked;
      perform(async () => {
        const assert = scoped();
        try {
          await api(`/api/image-reviews/${doc.id}/checks/${f.id}`, {
            method: "PUT",
            body: { checked: intended },
          });
          assert();
          f.checked = intended;
        } catch (e) {
          check.checked = !intended;
          throw e;
        }
      });
    });
    label.append(check, node("span", "직접 확인했어요"));
    box.append(label);
    return box;
  }
  function renderConnections() {
    const results = root.querySelector("#review-results");
    results.replaceChildren(
      node("span", "ACROSS THE CARDS", "eyebrow"),
      node("h2", "전체 카드 연결 검토"),
    );
    if (doc.connections_stale || staged.size)
      results.append(
        node(
          "p",
          "이미지가 바뀌었어요. 전체 검토를 다시 실행하면 장 사이 연결 결과가 갱신됩니다.",
          "review-version-note",
        ),
      );
    if (!doc.connections.length)
      results.append(
        node(
          "p",
          doc.version
            ? "이번 검토에서 연결 지적 없음"
            : "아직 전체 검토 전이에요.",
          "review-empty",
        ),
      );
    for (const f of doc.connections) {
      const label = f.card_ids
        .map((id) => doc.cards.findIndex((c) => c.card_id === id) + 1)
        .join(", ");
      results.append(
        node("p", `${label}번 카드`),
        finding(f, doc.connections_stale),
      );
    }
  }
  return {
    isBusy: () => busy,
    async sessionChanged() {
      generation++;
      busy = false;
      root.removeAttribute("aria-busy");
      document.querySelectorAll(".review-zoom").forEach((d) => {
        d.close();
        d.remove();
      });
      cleanup();
      root.replaceChildren();
      account = getUser()?.uid || null;
      selected = [];
      doc = null;
      pending = null;
      staged = new Map();
      createId = null;
      historical = null;
      creation = null;
      form = { title: "카드뉴스 검토", criteria: null, saveCriteria: false };
      const epoch = generation;
      if (!account) {
        await renderHome().catch(() => {});
        return;
      }
      try {
        const saved = await getReviewSession(account);
        if (epoch !== generation) return;
        if (saved) {
          selected = saved.selected || [];
          createId = saved.createId || null;
          creation = saved.creation || null;
          form = saved.form || form;
          staged = new Map(saved.staged || []);
          pending = saved.pending || null;
          if (saved.review_id) {
            doc = await api(`/api/image-reviews/${saved.review_id}`);
            if (epoch !== generation) return;
            active = 0;
            await renderWork();
            return;
          }
        }
        await renderHome();
      } catch (e) {
        if (epoch === generation) {
          notice(e.message, true);
          await renderHome().catch(() => {});
        }
      }
    },
  };
}
