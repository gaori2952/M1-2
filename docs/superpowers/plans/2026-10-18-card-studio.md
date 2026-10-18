# Card editing studio implementation plan

Goal: preserve a user's content and design while reviewing, revising and exporting individual cards.
Approved brief: 2026-10-18 in-chat design and user's explicit request to implement it.
Architecture: retain FastAPI/Firestore/vanilla app. Add owner-scoped review proposals, server-enforced field masks, optimistic revisions and per-card restore. Render text, LaTeX and bounded vector primitives into a fixed SVG template; export the same SVG to PNG and ZIP.

## Constraints and decisions
- Preserve existing drafts and APIs; no source-data migration or deletion.
- Existing brand/layout remains the default; style is explicit per-document metadata and never model-editable.
- AI proposes changes; applying a chosen proposal is a distinct user action. Non-selected cards/fields stay unchanged by server construction.
- A proposal uses a saved draft version; concurrent changes produce 409. Requests have UUID replay and share daily AI quota.
- Restore copies just one card from a persisted revision into a new version, without removing history.
- Existing flat images cannot be decomposed automatically in this iteration. Support editable text/card JSON import. Diagrams use bounded vector primitives (no arbitrary SVG/HTML).
- Scientific correctness remains a human review decision. Render errors/overflow block image export rather than silently truncate.
- No framework; bundle renderer dependencies in the static build. Private sources stay out of Git.

## Tasks
- [x] Backend: failing API tests for scoped edits, stale proposals, owner checks, replay, quota, restore, input validation. Implement proposals/field masks/version history and both configured model transports.
- [x] Frontend: import/create/open entry, page overview and single-card editing, selection + field controls, proposal diff/apply, card restore, fixed template preview, individual/ZIP export. Retain quiz/chat/data/history functionality.
- [x] Verification: backend/full build tests, browser integration against synthetic-only local preview (AI mocked), PNG count/dimensions, XSS/overflow, mobile, existing flow regression, screenshot inspection.
- [ ] Fresh reviewer, address material findings, README/verification evidence, commit/push and create reviewable PR. Production deployment status must be stated separately.

## Review focus
- Model attempts changes outside selected fields/cards; malicious vector text.
- Network uncertainty during proposal generation/application and duplicate retry.
- Existing draft schemas, explicit template settings and unsaved edits survive navigation/save.
- Per-card restore must not revert other cards, quiz or template.
- Long Korean copy, invalid TeX, empty/missing drawings, and 10-page exports.

## Progress
- Scope mapped; base bf5a083, branch codex/card-editing-studio. Existing clean worktree reused.

- Backend initial 11 new tests RED (missing endpoints), then GREEN. Current suite 59 passed incl. SDK transports, owner isolation, immutable field masks, stale generation, quota and commit-ack recovery.
- Browser entry test RED (missing action), then GREEN including ten PNGs, scoped diagram-only apply, restore, malicious text, overflow, mobile.
- Existing flow and three durability browser checks passed.
- Actual configured Anthropic-compatible provider: one synthetic review call, max output 2400, valid CardReviewReply and five vector elements. No real Firestore data used. OpenAI review path covered with real SDK + fake HTTP only.
- Final reviewer found two blockers: mutable restore target (P1), bold title width (P2). Both reproduced RED in editor-regressions.mjs then fixed GREEN. Full backend/build/browser suites remain green. No deferred findings.
