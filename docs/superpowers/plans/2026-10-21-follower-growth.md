# Follower Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Buffer 자료로 팔로워 성장 상담과 게시 실험을 연결하는 실제 사용 가능한 개인 웹 앱을 만든다.

**Architecture:** 기존 FastAPI·Firestore·인증·대화 예약을 유지한다. 서버가 읽기 전용 동기화와 통계·후보를 계산하고 GPT는 설명한다. 바닐라 UI의 첫 화면과 메뉴를 성장 흐름으로 바꾼다.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic, firebase-admin, OpenAI SDK, HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-19-follower-growth-design.md`

**Execution:** 사용자가 “작성하고 실현해줘”로 계획 작성과 연속 실행을 요청했다. 현재 전용 `codex/follower-growth` 브랜치에서 직접 실행하며 기존 작업·키를 유지한다. main 병합·운영 배포는 포함하지 않는다.

## Global Constraints

- 백엔드 Render, 프론트 Vercel, UI 프레임워크 없음. 기존 API·자료 보존.
- 팔로우 null과 0 구분, 형식 분리, 도달 양수에서만 전환율 계산.
- 읽기 전용 Buffer, 서버 키, 소유 UID·채널 고정, 개인 자료 Git 제외.
- 최대 2,000개/동기화, 60분 캐시, 사용자별 하루 5회, 전체 완료 후 성공 포인터 전환.
- 시간 구간 3시간, 구간당 3개·2일 이상, 비교 가능한 구간 최소 2개.
- 7일차 부근 관측은 실제 저장된 소스 갱신 시점의 6~8일 관측만 사용.
- 성장 상담은 OpenAI만 사용. 키 부재를 실제 GPT 성공으로 표시하지 않는다.
- 필수 CRUD·요약·채팅·대화 기록·139일 CSV 가져오기·README 제출 화면 유지.

## Review Focus

- 부분 동기화/응답 유실 후 이전 성공 자료와 요청 상태를 복구하는지 — Task 1.
- 미래·미게시·도달 0·팔로우 null이 성장 순위를 오염시키지 않는지 — Task 2.
- 다른 UID·채널과 임의 후보를 실험에 연결할 수 없는지 — Tasks 1, 2.
- GPT 없이 통계 사용 가능하고 대화 재시도가 중복 비용을 만들지 않는지 — Task 3.
- 로그아웃·화면 이동·재시도·모바일에서 입력과 계정 자료가 섞이지 않는지 — Task 4.

### Task 1: Buffer 읽기 연결과 완전한 동기화

**Files:** Create `backend/app/buffer_client.py`, `buffer_service.py`, `growth_models.py`, `routes/growth.py`, `backend/tests/test_buffer.py`; modify `config.py`, `main.py`, `.env.example`, `render.yaml`.

**Interfaces:** `BufferClient.fetch() -> {channel:dict, posts:list[dict]}`; `sync_buffer(db, client, settings, uid, request_id) -> dict`; `buffer_status(db, settings, uid) -> dict`; `current_posts(db, settings, uid) -> list[dict]`. Normalized posts preserve `id`, `format`, `sent_at`, `metrics_updated_at`, numeric `metrics`, original `raw_metrics`, text/assets/links/status. Fixed channel and owner are server configuration.

- [x] Write tests for successful pagination, duplicate IDs, cap/cursor/errors, invalid units/URLs, failed staging, prior pointer, owner, cooldown/quota/replay.
- [x] Run `.venv/bin/python -m pytest backend/tests/test_buffer.py -q`; expect RED until implementation exists.
- [x] Implement fixed queries with urllib transport injection, normalized validation, immutable sync generations, request recovery and pointer switch after all writes. Commit no private sources.
- [x] Run the same command; expect PASS. Commit `feat: sync Buffer posts with owner isolation`.

### Task 2: 성장 분석과 실험

**Files:** Create `backend/app/growth_analytics.py`, `growth_service.py`, `backend/tests/test_growth.py`; extend growth router/models.

**Interfaces:** `analyze_growth(posts, timezone, now=None) -> dict`; `build_recommendation(posts, channel, options, version, now=None) -> dict`; `growth_context(db, settings, uid, options) -> dict`; `save_experiment(db, settings, uid, body) -> dict`; `update_experiment(...) -> dict`. Summary has `formats`, `time_comparisons`, `limitations`; recommendation has server-controlled `candidates`, evidence IDs, version, goal, observation mode. Experiment creation takes a saved recommendation request UUID and candidate ID.

- [x] Test null/zero, format separation, same-age observations, future and pending exclusion, local midnight, sample thresholds and only user-confirmed future candidates.
- [x] Test experiment candidate integrity, owner/format/sent checks, immutable baseline, actual-time deviation and observation unavailable states.
- [x] Run `.venv/bin/python -m pytest backend/tests/test_growth.py -q`; expect RED.
- [x] Implement pure calculations and stored evidence; no invented effects, probabilities or API mutation.
- [x] Run the same command; expect PASS. Commit `feat: analyze follower conversion and record posting experiments`.

### Task 3: GPT 컨텍스트와 필수 시계열 가져오기

**Files:** Modify `models.py`, `generation.py`, `chat_service.py`, `main.py`, `routes/resources.py`, `importing.py`; create `backend/tests/test_growth_chat.py`.

**Interfaces:** ChatInput gains `mode="growth"` and validated `growth_options`; server attaches computed `result.growth`. Growth OpenAI generator is injectable for tests and required only for growth calls. Existing replies/history remain compatible. `POST /api/data/import` takes `{csv_text:str}` and returns imported/skipped and date/valid/missing counts.

- [x] Test supplied numeric summary and max 5 captions/2,000 chars, source validation, missing OpenAI key, UUID replay, saved recommendation, prior chat compatibility, CSV duplicate preservation/limits.
- [x] Run `.venv/bin/python -m pytest backend/tests/test_growth_chat.py -q`; expect RED.
- [x] Reuse existing reserve/generate/finish chat path. Use existing summary in system prompt; keep captions untrusted. Import through existing validated parser without overwrites.
- [x] Run `.venv/bin/python -m pytest -q`; expect PASS including baseline 86 tests. Commit `feat: add grounded growth chat and daily CSV import`.

### Task 4: 성장 중심 화면

**Files:** Create `frontend/growth.js`, `growth.css`, `tests/e2e/growth.mjs`, `backend/tests/growth_preview.py`; modify `index.html`, `app.js`, `build-config.mjs`, `tests/build.test.mjs`, `package.json`.

**Interfaces:** `mountGrowth(root, {api,getUser,notice,show,loadData})` returns `sessionChanged()`, `refresh()`, `openConversation(conversation)`, `isBusy()`. Root owns next-post and past-post views; existing data/history/tool screens remain accessible. Growth API uses existing auth transport; source text uses textContent.

- [x] Add build/E2E assertions for new default screen, asset inclusion, sync, server candidates without GPT, chat loading/history, experiment save/link, annotation, CSV and mobile/logout isolation.
- [x] Run build test and E2E before UI changes; expect RED for missing assets/new selectors.
- [x] Build three main navigation entries and optional old tools; preserve old flows and pending growth requests by UUID. Render actual null states, source evidence, last success and metrics times. No automatic API calls that mutate Buffer.
- [x] Run build tests, new E2E, existing flow/regression E2E with selectors updated only for relocated navigation; expect PASS. Commit `feat: make follower growth the primary app workflow`.

### Task 5: README, 실제 읽기 확인과 최종 검토

**Files:** Rewrite `README.md`, update `docs/architecture.md`, `docs/verification.md`; add clearly synthetic `docs/screenshots/growth-*.png`.

**Interfaces:** Runtime setup lists Buffer owner/channel/key, GPT and Firebase configuration. Production status is distinguished from local fixtures. Screenshots show question+answer+summary, CRUD and restored history.

- [x] Run full pytest, Ruff, Prettier, static build tests and targeted E2E. Inspect desktop/mobile screenshots. Expect all relevant checks PASS.
- [x] Make one actual Buffer read through the new client, saving no private data to Git. Verify source metrics coverage; actual OpenAI/Firestore cloud calls only when required configuration exists and report separately.
- [x] Obtain one fresh whole-change code review, fix important findings with reproducing tests, then run relevant suite again.
- [x] Document exact commands/results, unverified OpenAI/cloud/deployment, and changed scope. Commit docs and verified implementation. No automatic main merge or production deployment.

## 실행 결과

구현·검증 완료. 실제 Buffer/승인된 Firestore 저장·재조회 확인. OpenAI 키가 없어 실제 GPT 호출은 남아 있으며, 운영 배포는 하지 않았다. 세부 검증·판단은 `docs/verification.md`에 기록했다.
