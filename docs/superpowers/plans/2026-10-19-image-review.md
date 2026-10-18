# 카드뉴스 이미지 검토 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여러 카드 이미지를 장별로 검토하고 수정한 장만 재검토할 수 있는 웹 서비스를 만든다.

**Architecture:** Firebase 인증·Firestore 저장소·사용량 제한·FastAPI 앱을 재사용한다. 이미지 검토의 모델 전송, 결과 검증, 버전 저장을 별도 모듈로 분리하고 바닐라 프론트의 새 기본 화면에 연결한다. 이미지 파일은 UID·해시로 구분한 IndexedDB에만 보관하고 서버에는 일시 전송한다.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic, firebase-admin, OpenAI/Anthropic SDK, Pillow(이미지 디코딩), HTML/CSS/JavaScript, IndexedDB, pytest, 기존 Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-10-19-image-review-design.md`

## Global Constraints

- PNG/JPEG/WebP 정지 이미지 1~10장; 원본 장당 10MB; 검토용 긴 변 2,400px 이하·장당 1MB 이하; 요청 최대 16MB.
- 이미지의 동일 브라우저 보관 한계를 화면에 표시하고 Firestore·로그·공개 저장소에 이미지 base64를 저장하지 않는다.
- 수식·개념·도식의 정확성을 먼저 보고 디자인 일관성과 가독성도 확인한다. 판독 불가는 확인 필요로 남긴다.
- 카드당 지적 최대 5개, 연결 지적 최대 5개. 자동 정확성 보증·자동 이미지 수정·자동 게시를 제공하지 않는다.
- 기존 데이터·원고·대화를 삭제하거나 변환하지 않는다. 기존 API와 과제의 시계열·CRUD·채팅·기록·Swagger·배포 구조를 유지한다.
- 현재 제공업체의 이미지 지원은 미확인이다. 합성 이미지로 실제 호출을 검증하고, 미지원 시 설정 오류를 알린다. 제공업체는 자동 변경하지 않는다.
- 새로운 인프라·유료 구독은 생성하지 않는다. 합성 자료만 테스트·스크린샷·공개 커밋에 사용한다.

## Review Focus

- 두 파일의 이름이 같아도 카드 UUID로 결과가 연결되고, 같은 UUID에 다른 이미지 결과가 섞이지 않아야 한다(Task 1, 2, 4).
- 새 이미지가 이전 이미지와 비슷해도 새 버전의 지적·사용자 체크는 독립적이어야 한다(Task 2, 4).
- 저장 응답이 끊겨도 같은 요청 UUID로 조회·재시도하면 이미 생성한 결과를 복구해야 한다(Task 2, 4).
- 느린 요청 도중 로그아웃·계정 변경 시 이전 계정의 이미지·응답을 표시하지 않아야 한다(Task 3, 4).
- 브라우저 저장소 삭제·쓰기 실패·다른 기기 사용은 빈 이미지나 가짜 성공 대신 복구 안내를 보여야 한다(Task 3, 4).

---

### Task 1: 이미지 검증과 실제 이미지 모델 전송

**Files:** Create `backend/app/image_review_models.py`, `backend/app/image_review_generation.py`, `backend/app/image_assets.py`, `backend/tests/test_image_review_transport.py`; modify `backend/requirements.txt`, `backend/requirements.lock`.

**Interfaces:**
- `decode_asset(asset: ReviewImage) -> dict`: MIME·디코딩·픽셀·크기·SHA256 검증 후 `{card_id, name, mime, base64, sha256}` 반환. 이미지 내용은 저장하지 않음.
- `ImageReviewer(settings).review(images: list[dict], context: dict) -> dict`: 현재 설정 제공업체의 멀티모달 요청으로 `ReviewReply` 반환.
- `ReviewReply`는 `cards[{card_id, summary, findings[{category, location, evidence, reason, suggestion}], resolutions[{finding_id, status}]}]`, `connections[{card_ids, category, location, evidence, reason, suggestion}]`를 갖는다. `category`는 `error|uncertain|improvement`, 해결 상태는 `resolved|remaining|uncertain`이다. 출력 문자열 길이와 목록 개수를 제한한다.

- [ ] **1. RED:** 테스트에서 손상 이미지·잘못된 MIME·다중 프레임·초대형 해상도·잘못된 해시를 거부하고 정상 PNG/JPEG/WebP가 통과하도록 작성한다. OpenAI 요청에 `input_image`와 `store=False`, Anthropic 요청에 base64 image 블록과 강제 도구 스키마가 들어가는지 목 SDK로 검사한다. 출력 잘림·거부·누락을 성공으로 취급하지 않는다.
- [ ] **2. RED 실행:** `.venv/bin/python -m pytest backend/tests/test_image_review_transport.py -q` → 새 모듈 미구현으로 실패 확인.
- [ ] **3. 구현:** Pillow로 검토용 파일의 실제 디코딩과 애니메이션 여부를 확인한다. base64를 텍스트로 보내지 않고 각 SDK의 이미지 블록으로 전달한다. 기존 생성 프롬프트와 분리한 고정 검토 지시문에 판독 한계·근거·이미지 안의 지시문 무시를 명시한다. 전체 장 ID와 문맥을 전달한다.
- [ ] **4. GREEN:** 위 테스트 통과; `.venv/bin/ruff check backend/app/image* backend/tests/test_image_review_transport.py` 통과.
- [ ] **5. 커밋:** 새 모듈·테스트·의존성만 `feat: 이미지 검토 모델 전송과 입력 검증`으로 커밋한다.

### Task 2: 소유권·버전·요청 복구를 갖춘 검토 API

**Files:** Create `backend/app/image_review_service.py`, `backend/app/routes/image_reviews.py`, `backend/tests/test_image_reviews.py`; modify `backend/app/main.py`.

**Interfaces:**
- `create_app(..., image_reviewer=None)`에 테스트 주입 지점을 추가하고 운영 기본값은 Task 1의 `ImageReviewer(settings)`를 사용한다.
- 스펙의 `/api/image-reviews` 생성·목록·단건, `/{id}/runs` 실행·상태, `/{id}/cards/{card_id}/versions`, `/{id}/checks/{finding_id}`를 구현한다. 생성·실행 요청은 UUID와 기준 작업 버전을 요구한다.
- 생성 시 확정 카드 ID·순서를 저장한다. 최초 전체 검토는 전체 카드 ID와 정확히 일치하는 이미지가 필요하다. 이후 단일 재검토는 현재 맥락의 이미지 전부와 대상 장의 직전 이미지를 받아 기존 해시와 대조한다.
- 실행 결과는 `{request_id, status, review_version}`와 결과 참조를 반환한다. 결과 조회는 소유자에게만 허용한다. 목록은 최근 요약만 반환한다.

- [ ] **1. RED:** `MemoryStore`·목 모델로 생성→전체 검토→한 장 교체 검토→이전 버전 조회→사용자 체크를 테스트한다. 다른 장 결과가 바뀌지 않고 연결 검토는 갱신 필요 상태여야 한다. 다른 UID는 404, 누락·중복·다른 카드 ID와 불일치 이미지 해시는 422여야 한다.
- [ ] **2. RED:** 동일 요청 재시도는 모델 호출 횟수 `1`, 요청 UUID의 본문 변경과 오래된 기준 버전은 409, 한도 초과는 429여야 한다. 저장 성공 후 응답 유실·동시 재시도·모델 예외·만료·서버 결과 검증 실패를 테스트한다. 모델 응답에 없는 이전 지적을 해결로 연결할 수 없어야 한다.
- [ ] **3. RED 실행:** `.venv/bin/python -m pytest backend/tests/test_image_reviews.py -q` → 라우터 미구현 실패 확인.
- [ ] **4. 구현:** 모델 호출 전에 원자적 예약·공유 quota 증가, 트랜잭션 밖에서 호출, 완료 시 기준 버전 검사와 결과·버전·요청 상태의 원자적 저장을 한다. 이미지·원본 요청 base64는 Firestore에 기록하지 않는다. 저장 응답 유실은 완료 요청 조회로 복구한다. 실행 중은 재호출하지 않고 180초 이후 중단 상태를 안내한다. 명시적 새 검토만 새 UUID를 쓴다.
- [ ] **5. 구현:** 이미지 라우터에 요청 바이트 제한을 적용하여 Content-Length 유무와 관계없이 16MB 초과를 거부한다. 체크는 특정 장 버전의 서버 발급 지적 ID에만 연결한다. 클라이언트 지적 ID로 다른 작업에 접근하지 못하게 한다.
- [ ] **6. GREEN:** 신규 테스트와 기존 백엔드 전체 테스트 통과; Firestore read-before-write 제약을 MemoryStore 테스트 외에 코드 검토로 확인한다.
- [ ] **7. 커밋:** `feat: 장별 이미지 검토 API와 버전 이력`.

### Task 3: 이미지 보관과 업로드·장별 결과 화면

**Files:** Create `frontend/image-review.js`, `frontend/review-images.js`, `frontend/image-review.css`; modify `frontend/index.html`, `frontend/app.js`, `frontend/build-config.mjs`, `tests/build.test.mjs`.

**Interfaces:**
- `review-images.js`: `prepareFile(file) -> {sha256, mime, base64, blob, name}`; `putImages(uid, assets)`, `getImage(uid, sha256)`. IndexedDB key는 UID와 해시다. 원본과 검토용 blob을 함께 저장한다. 글자를 읽을 수 없는 과도한 축소가 필요하면 실패 안내한다.
- `mountImageReview(root, {api, getUser, notice})`는 `sessionChanged()`와 `isBusy()`를 반환한다. 기존 `session(user)`에서 새 모듈도 초기화하고 이전 계정의 DOM·메모리·객체 URL을 폐기한다.
- 이미지 검토를 기본 `.view`로 추가하고 기존 작업실·원고함은 제작 도구에 둔다. 기존 요소 ID·라우터·데이터는 유지한다. 빌드 복사·자산 해시·중첩 import 갱신에 새 모듈·CSS를 포함한다.

- [ ] **1. RED:** 빌드 테스트에 새 JS·CSS 복사와 버전 갱신 검사를 작성해 실패 확인한다. 파일 처리의 크기·개수·형식 실패는 Task 4 E2E로 검증한다.
- [ ] **2. 구현:** 업로드 선택·드롭, 파일명 자연 정렬, 순서 이동·삭제, 선택적 검토 기준과 명시적 기본값 저장, 전체 검토 버튼을 만든다. 1~10장 제한을 안내하고 잘못된 파일이 정상 선택을 지우지 않도록 한다.
- [ ] **3. 구현:** 장 목록·큰 이미지·오른쪽 결과를 구성하고 모바일에서는 세로 배치한다. 확대는 읽기 전용 모달로, Esc·닫기 버튼·포커스 복귀를 제공한다. 문자열은 textContent로 출력하고 모델 HTML을 실행하지 않는다. 불확실·수정·표현 제안과 사용자 체크를 구분한다.
- [ ] **4. 구현:** 장 이미지 교체·재검토·직전 버전·전체 연결 검토 상태를 연결한다. 대기 이미지와 아직 처리하지 않은 변경을 보존하고, 완료 응답을 확인하기 전 현재 버전을 덮어쓰지 않는다. 같은 요청 복구와 새 검토를 구분한다.
- [ ] **5. 구현:** IndexedDB 저장 실패는 AI 요청 전에 안내한다. 로컬 이미지가 없는 검토는 결과를 표시하되 해시가 일치하는 이미지 재선택을 안내한다. 이전 계정의 늦은 응답은 폐기하고 새 화면에서 복구할 수 있게 한다.
- [ ] **6. GREEN:** `node --test tests/build.test.mjs`, Prettier 검사 통과; 기존 화면으로 이동·로그인·로그아웃 동작 유지 확인.
- [ ] **7. 커밋:** `feat: 이미지 업로드와 장별 검토 작업실`.

### Task 4: 실제 브라우저 흐름·모델 호환·문서 검증

**Files:** Create `tests/e2e/image-review.mjs`; modify `backend/tests/preview.py`, `package.json`, `README.md`, `docs/verification.md`; add 합성 자료의 `docs/screenshots/image-review*.png`.

**Interfaces:** 테스트용 `PreviewGenerator` 또는 별도 검토 fixture를 `create_app(image_reviewer=...)`로 주입한다. 테스트 모듈은 운영 앱에서 import하지 않는다. 실제 모델 확인은 합성 이미지로만 수행하며 Firestore에 결과를 쓰지 않는다.

- [ ] **1. RED:** 합성 6장(중복 파일명 포함) 업로드→정렬 변경→전체 검토→장별 결과→한 장 교체→해결 제안→사용자 체크→이전 버전→새로고침 복구의 E2E를 작성하고 화면 미구현 상태에서 실패 확인한다. 실제 UI 구현 시나리오가 정해진 Task 3 시작 전 이 RED 검사를 먼저 실행한다.
- [ ] **2. 검증:** 모델 응답 유실을 한 번 주입해 재시도가 모델 호출을 늘리지 않는지 확인한다. IndexedDB 실패 시 API 미호출, 저장소 삭제 후 이미지 재선택, 느린 요청 중 로그아웃·다른 UID 로그인 후 이미지·응답 누출 없음, 모델 문자열 XSS 비실행을 검사한다.
- [ ] **3. 검증:** 모바일 가로 넘침 없음, 파일 선택·장 이동·이미지 확대·교체가 가능함을 확인한다. 합성 카드로 데스크톱·모바일 스크린샷을 저장하고 직접 시각 확인한다.
- [ ] **4. 실제 모델:** 현재 설정 제공업체에 합성 이미지 2장을 보내 멀티모달 전송·스키마·장 ID 대응을 검증한다. 이미지를 읽는지 구분할 수 있는 시각 표식과 명확한 오류를 넣는다. 미지원·거부·출력 잘림은 숨기지 않고 문서화하고 실행 환경 설정을 명확히 안내한다. 키는 출력하지 않는다.
- [ ] **5. 회귀:** 백엔드 전체 pytest·Ruff·정적 빌드·포맷 검사와 기존 `flow`, `durability`, `editor`, `editor-regressions` E2E를 실행한다. 실패는 원인 수정 후 관련 범위만 재실행하고 마지막 전체 검증은 한 번 수행한다.
- [ ] **6. 문서:** 사용 순서, 검토 범위·이미지 보관 한계, API, 실제/목 테스트 차이, 현재 제공업체 및 GPT 과제 요건 차이를 README와 verification에 기록한다.
- [ ] **7. 독립 검토:** executing-plans의 최종 검토 지침에 따라 완성 변경에 대해 독립 리뷰를 받고 재현 가능한 지적을 수정한다. 비밀 키·원고·실제 이미지가 Git diff에 없는지 확인한다.
- [ ] **8. 커밋·PR:** `test: 이미지 검토 흐름 검증과 사용 안내` 커밋 후 `codex/image-review`를 push하고 구체적인 검증 결과를 포함한 PR을 생성·첨부한다. 새 운영 화면 전환은 검증된 결과를 제시한 뒤 사용자 승인을 최종 단계로 받는다.

## 실행 방식 제안 및 현재 상태

- 권장: **Native**. 위 작업은 API와 화면의 계약에 서로 의존하고, 기존 코드를 이해한 현재 에이전트가 직접 구현하는 편이 맥락 전달 비용이 적다. 마지막에 독립 검토를 한 번 수행한다.
- 설계서는 사용자 승인 완료. 이 구현 계획은 자기 검토 완료, 사용자 검토 전이다.
- 제품 코드는 아직 변경하지 않았다. 운영 서비스도 변경하지 않았다.
