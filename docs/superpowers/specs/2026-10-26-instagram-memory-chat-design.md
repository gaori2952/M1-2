# Instagram memory chat

User approved the proposal: one natural-language workspace around connected Instagram posts, with body reading, draft comparison, reuse, post feedback, series coverage, and a copy-ready GPT handoff. Existing FastAPI/vanilla frontend/Firestore/Render/Vercel and configured provider remain.

## Decisions
- Keep one conversational home, post browsing and history. Data CRUD/summary stay under secondary data management for course requirements. Existing standalone image review remains a secondary option; no new card designer.
- Prefer cached extraction of real post images over caption-only inference. Store structured page text/observations/topics with post IDs, page IDs, source signature and coverage. Unread pages, video bodies and missing images never become observed facts.
- Automatic reading considers at most one related, unread image post per user question. Explicit post reading is available in browsing. At most ten image assets per post; known first ten coverage is disclosed. Cached reads cost no new model call.
- Only server-owned Buffer asset URLs on verified Buffer/Meta CDN hosts may be downloaded. No client URL input, no raw image storage, bounded downloads/pixels/time, public DNS checks and restricted redirects.
- Draft images reuse existing browser preprocessing and owner-scoped IndexedDB. Chat sends transient validated images; Firestore saves hashes/names only. Pending retries hydrate the same images from IndexedDB without placing base64 in localStorage.
- Replies can return copy-ready work_text for reuse/series/feedback/GPT. Every assistant response has a manual copy handoff with relevant post links. Normal user questions determine the task without a settings form.
- Existing request leases, owner auth, shared daily AI quota, idempotent replay, prior successful data, and cache invalidation are preserved.

## Alternatives considered
- Reuse captions only: cheap but does not solve the evidenced missing-body problem.
- Re-read all posts on every question: high latency/cost; rejected.
- Selected incremental image reading + persistent verified references: chosen to satisfy the approved direction with bounded cost.

## Completion
Synthetic tests cover source ownership, cache/replay, unsafe URLs, attachment validation/transports, reply evidence, copy/reload/logout and mobile. Real verification is separately labeled, uses a small bounded sample and never publishes private posts or screenshots. No claim that every account post or video has been read.
