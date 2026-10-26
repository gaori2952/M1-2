# Instagram Memory Chat Implementation Plan

> For agentic workers: execute independent frontend and ingestion tasks in parallel under dispatching-parallel-agents; review the whole branch before integration.

**Goal:** A simple Instagram-grounded chat that reads source images, compares drafts, reuses posts, summarizes feedback/series and copies a GPT handoff.
**Architecture:** Existing chat persistence/provider transports plus owner-scoped persistent post readings. Bounded safe image ingestion; frontend resolves at most one reading before a question and keeps image retries in IndexedDB.
**Tech Stack:** FastAPI, Pydantic, Firestore, Anthropic/OpenAI existing SDKs, Pillow, vanilla JS.
**Spec:** docs/superpowers/specs/2026-10-26-instagram-memory-chat-design.md

## Interfaces and ownership
- Ingestion task owns `post_reading_models.py`, `post_media.py`, `post_reading_service.py`, tests/test_post_readings.py. `PostReadingReply`: title<=160, summary<=1000, topics<=20 strings<=80, pages1..10 of {card_id string<=64,text<=600,description<=300,legible bool}. `ReadPostInput`: request_id UUID, post_id string1..200. `read_post(db, reader, settings, uid, body, downloader=download_post_images)`: returns {status:'ready',post_id,reading:{title,summary,topics,pages},covered_count,total_count,cached,read_at}. `select_posts(db,settings,uid,query,post_ids=[])`: returns candidates max3 {post_id,title,cached,image_count}, at most one uncached selected for auto read. `reading_status(db,uid,request_id)` returns ready/pending/failed. `post_memory(db,uid,posts)` returns dict post_id -> valid reading envelope only when source signature matches. Shared AI quota collection `quotas`, fields count/day; reading requests have own leases. Reader interface `.read(images,context)` and image payloads {card_id,name,mime,base64,sha256}. Exact allowed media host is buffer-updates-media-backfill-bucket.s3.amazonaws.com plus subdomains of cdninstagram.com/fbcdn.net. No video decoding.
- Root owns provider extension `ImageReviewer.read`, chat request `images` ReviewImage[]<=10 and growth_options.post_ids<=5, reply optional work_text<=12000, context reading integration, API routes, tests. GET /api/post-readings/select?query=...&post_id=... returns {candidates:[...]}; POST /api/post-readings body ReadPostInput; GET /api/post-readings/requests/{uuid}. Chat source refs contain `reading` envelope and preview_url when available. No client-submitted reading text.
- Frontend task owns growth.js/growth.css, index.html/app.js only if necessary, own new browser test. Reuse prepareFile/putImages/getImage from review-images.js. Persist pending.image_assets metadata; before chat POST remove that local key and hydrate validated `images`. Auto read first uncached selected candidate via endpoints; preserve reading UUID if ambiguous, query status before retry. Question owns conversation/attachments; all async results checked by epoch. Keep old growth timing selectors in collapsed details as needed for compatibility but hide advanced settings by default. Clear visible main metric wall; basic account status + summary can be collapsed. Five prompt chips: find/compare/reuse/feedback/series. Show optional work_text + copy handoff and post source thumbnails. Explicit read button in post browsing. Core CRUD/history stays accessible. Form defaults carousel/lifetime, no visible settings requirement.

## Tasks
- [ ] 1. Ingestion: failing tests, safe downloads/normalization, cache+leases+quota, green tests.
- [ ] 2. Root: failing transport/chat tests, add validated multimodal attachments, memory references and task-aware outputs, routes, green suite.
- [ ] 3. Frontend: single chat flow, post reading actions, attachments and durable retries, copy handoff, desktop/mobile test.
- [ ] 4. Integration review, fresh full tests/build, bounded real validation, README, PR/publish/deploy and live verification.

## Review focus
- Cross-owner or arbitrary URL input; signed URL leakage; redirects/oversized/animated images.
- Duplicate billing on ambiguous response, changed post media or concurrent questions.
- No raw image bytes or large pending base64 in Firestore/localStorage.
- Cached reading matched to actual source pages, no claims of full account/video coverage.
- Late async results after logout, missing IndexedDB images, safe rendered text and readable mobile layout.
