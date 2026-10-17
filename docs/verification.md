# 검증 기록

2026-10-17 · 로컬 구현 검증. 운영 배포 완료를 의미하지 않습니다.

## 완료한 검증

- Python 3.12 가상환경, FastAPI /docs 및 /health.
- pytest: 43개 통과. 인증 없음/잘못된 토큰/허용 UID, 소유자 격리, 입력 검증, CRUD, 통계, 원고 검색, 게시물 성과 검증, 요약의 시스템 프롬프트 주입, 대화 저장·삭제, 생성 구조, 재요청·동시 요청, 일일 제한, 저장 실패, 초안 버전 충돌, 수정 피드백, 명시적 선호 저장.
- Playwright + Chrome: 기본 흐름 1개 및 저장/재시도 회귀 시나리오 3개 통과. 데이터 추가, 채팅, 주제 후보 3개, 카드 6장, 초안 수정·저장, 새로고침 복원, 대화 불러오기, 악성 HTML 문자열 비실행, 390px 모바일 가로 넘침 검사.
- 정적 프론트 빌드: 공개 설정만 생성. 빌드 격리/설정 거부 테스트 2개 통과. 운영 설정은 백엔드와 별도.
- 실제 OpenAI SDK를 HTTP 전송 경계에서만 대체해 구조화 스키마, 토큰 제한, store=false, 자동 재호출 없음 확인.
- 2026-10-17 Anthropic 호환 경로: 실제 Anthropic SDK를 HTTP 전송 경계에서만 대체해 게이트웨이 base URL, 강제 도구 호출, 토큰 제한, 자동 재호출 없음, max_tokens·refusal·도구 미호출·스키마 불일치 거부, 제공자 선택을 확인(9개).
- 코드 리뷰에서 발견한 commit 응답 유실 시 중복 생성, 같은 초안 재열기/저장 중 편집 유실을 실패 테스트로 재현한 뒤 수정. 99개 메시지에서 101개로 초과하는 경계도 차단.
- 테스트 도구에서 httpx 사용의 Starlette deprecation warning 1개가 발생합니다. 테스트 실패는 아니며 운영 요청에는 해당하지 않습니다.
- M1-1 고정 커밋 CSV 파싱: 139일, 834슬롯, 유효 수치 833개, 결측 1개. CSV 수치는 `1110.00000000` 형식이므로 정수와 동등한 소수 표현만 허용하고 실제 소수는 거부.
- 재수입 시 기존 ID와 사용자 수정 보존.

## 실제 서비스 연결 검증 (2026-10-17, 로컬 서버)

Firebase 프로젝트 `m1-2-1c289` + COPA 게이트웨이(Anthropic 호환, `claude-sonnet-4`)로 로컬 백엔드를 실행하고, 허용 UID의 실제 Firebase ID 토큰으로 API를 호출했다.

- 브라우저 Google 로그인 → 미등록 UID 403 → `ALLOWED_USER_UIDS` 등록 후 작업실 진입.
- 토큰 없음/잘못된 토큰 401. Firestore 실제 데이터 생성·수정·요약·삭제, 원고 생성·삭제, 대화 삭제 통과.
- 후보 생성 1회(약 21~25초): 정확히 3개, 근거 ID는 선택 원고 범위 안.
- 같은 request_id 재전송은 0.3초 만에 동일 응답(모델 재호출 없음), 같은 ID에 다른 내용은 409.
- 원고 생성 1회(카드 4장, 약 65초): 선택 후보 제목 유지, review_items 8개, 퀴즈 정답 수동 확인. 초안 수정 저장 200 후 이전 version 저장 409.
- 발견·수정: COPA는 응답 시작이 약 60초 없으면 504로 끊는다 → Anthropic 경로를 스트리밍으로 변경. 한국어 원고는 4000토큰 한도에 걸려 잘림 → Anthropic 사용 시 `MAX_OUTPUT_TOKENS=8000` 권장.
- 주의: 셸에 `ANTHROPIC_BASE_URL`이 이미 있으면 `.env`보다 우선한다(python-dotenv 기본 동작). Claude Code 터미널 등에서 실행할 때는 해당 변수를 비우고 실행한다.
- 남은 확인: 카드 6~10장 원고의 소요 시간(프론트 제한 115초), 실제 비용, Render·Vercel 배포.

- 2026-10-17 컨텍스트 주입 변경: `/api/data/summary`와 같은 요약을 시스템 프롬프트 `[사용자 데이터 요약]`에 넣고, 원고·대화 기록은 사용자 메시지로 분리. 로컬 실제 연결 확인에서 COPA 응답의 요약 수치가 `/api/data/summary` 값과 일치함을 확인했습니다.

## 배포 검증 (2026-10-17)

- Render `https://m1-2-6ae7.onrender.com`: `/health` 200(configured=true), `/docs`·`/openapi.json` 200, 토큰 없는 요청 401.
- 허용 UID의 실제 Firebase ID 토큰으로 Render API 호출: 데이터 요약, 콘텐츠 라이브러리, 대화·초안 조회가 정상 응답함.
- Render에서 COPA 채팅이 성공했고, 응답의 요약 수치가 API 요약과 일치함을 확인. 확인용 대화는 즉시 삭제.
- Vercel `https://m1-2-frontend-theta.vercel.app`: 빌드된 config의 API 주소·Firebase 프로젝트 확인, Render CORS 프리플라이트 200(`access-control-allow-origin` 일치).
- 배포 프론트에서 Render까지 요약 카드, 데이터 목록, 라이브러리, 대화 기록의 화면 흐름과 페이지 오류 없음을 확인. (Google 로그인 팝업 자체는 사용자 브라우저에서 확인)
- 발견·수정: Render의 서비스 계정 JSON 값이 깨져 모든 보호 API가 401 → 한 줄 JSON으로 재입력 후 해결. `ALLOWED_ORIGINS` 미반영 시 CORS 400 → 재배포로 해결.

## 테스트 환경과 실제 서비스의 구분

자동 테스트는 **테스트 파일에서만** 인증 검증·저장소·모델 경계를 대체합니다. 통계·API·권한 검사·개인화 컨텍스트·출력 검증·대화 저장 로직은 실제 애플리케이션 코드를 실행합니다.
`backend/tests/preview.py`는 합성 시계열 120개와 모의 생성 결과를 사용하는 로컬 테스트 서버입니다. Render 시작 명령은 `app.main:app`이며 테스트 서버를 사용하지 않습니다.

스크린샷은 이 합성 테스트 환경의 화면입니다. 실제 개인 데이터/GPT 응답이나 배포 증빙으로 제출하면 안 됩니다.

## 아직 검증하지 않은 항목

- Firebase ID 토큰 철회와 Firestore 트랜잭션 경계 (로컬에서 실제 로그인 및 CRUD는 확인했으나 별도로 시험하지 않음)
- 실제 OpenAI 호출 및 COPA의 반복 호출 품질, 수식·정답 정확성, 실제 사용 비용
- 실제 모바일 기기의 Google 로그인
- GPT 프로젝트 원문 전체 회수와 이미지 시각 검증

이번 로컬 연결 검증은 Firebase와 COPA를 사용했습니다. OpenAI 경로는 사용하지 않았으며, Firebase 토큰 철회와 Firestore 트랜잭션 경계는 별도 검증이 필요합니다.
Firestore 어댑터는 공식 SDK 트랜잭션을 사용하지만 메모리 저장소 테스트만으로 클라우드 트랜잭션 검증을 대신하지 않습니다.

## 운영 연결 후 확인 순서

1. Firebase 테스트 사용자로 로그인하고 허용 UID / 거부 UID를 확인한다.
2. 별도 테스트 자료 1개를 추가·수정·삭제하고 summary 변화를 확인한다.
3. GPT 후보 1회, 원고 1회를 생성하고 선택 주제·근거 ID·수식·퀴즈를 직접 검토한다.
4. 같은 요청 ID 재전송, 대화 다시 열기, 원고 버전 충돌을 확인한다.
5. 배포 주소에서 같은 흐름을 반복하고 실사용 데이터가 포함되지 않은 제출 화면을 새로 캡처한다.

## 구현 범위와 제한

- 단일 개인 사용자부터 시작하며 ALLOWED_USER_UIDS로 명시적으로 허용한다.
- 서버가 컬렉션을 소유자별 조회 후 메모리에서 기간·검색을 처리한다. 10,000문서를 넘으면 잘못된 부분 결과 대신 오류를 반환한다. 대규모 사용 전 서버 쿼리와 페이지네이션이 필요하다.
- 대화는 최대 100메시지, 모델 입력은 최근 8메시지·최대 5개 원고(각 12,000자)이다.
- 삭제된 대화의 요청 ID는 재생성 방지용 최소 tombstone으로 남으며 원래 응답·개인 본문은 제거한다. 원고·피드백은 별도 보관 자료로 유지한다.
- 일일 요청 한도는 UTC 기준이며 실패한 모델 시도도 횟수에 포함한다. 자동 모델 재호출은 없다.
- 수식 편집은 LaTeX 원문을 보존한다. 초기 화면은 원문 표기이며 수식 조판 렌더링은 후속 개선이다.
- 일반 선호는 사용자가 직접 확인 후 저장한다. 피드백은 자동으로 영구 선호로 승격하지 않는다.

## 참조한 공식 문서

- [OpenAI 구조화 응답](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Firebase ID 토큰 검증](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firestore 트랜잭션](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Firebase 웹 모듈 설정](https://firebase.google.com/docs/web/setup)

- [Render FastAPI 배포](https://render.com/docs/deploy-fastapi)
- [Vercel 빌드 설정](https://vercel.com/docs/builds/configure-a-build)
