# 창업논문 도우미 (Electron + Python 사이드카)

에이전트(Codex / Claude Code)가 인터뷰·작문을 하는 동안, 학생이 **저장 상태·검사 결과·다음 할 일·산출물**을 보고
잠금 잔류·정본 손상 같은 막힘을 스스로 풀 수 있게 하는 데스크톱 GUI입니다. AI 도우미를 연결하면 답변과 작업 폴더의
내용이 선택한 제공업체(OpenAI 또는 Anthropic)로 전송됩니다. 앱 자체는 그 외 어디에도 자료를 보내지 않습니다.

## 구조

- `sidecar/knuaf_sidecar/` — 프로토콜은 stdlib, XLSX 미리보기는 openpyxl을 쓰는 Python 프로세스. Electron이 `python -m knuaf_sidecar --scripts-dir <S>`로 띄우고
  JSON-lines(stdin/stdout)로 대화합니다. 요청·응답 모두 UTF-8이며, 사이드카가 stdin/stdout/stderr 인코딩을
  직접 고정하므로 Python의 상속 코드페이지가 달라도 한글·공백 작업 경로를 그대로 처리합니다.
  `gg_core`는 in-process로 호출하고(상태·검사·잠금·스냅샷·발행),
  CLI 전용 스크립트(build_docx, gg_excel_*, gg_office, gg_deps, gg_kordoc)는 서브프로세스로 실행해 출력을
  `{ok, exit, status, data, path, block_reason, commit_state, detail, stdout, stderr}` 봉투로 정규화합니다. 쓰기 메서드는 하나의 락으로 직렬화되며,
  `methods.list`가 각 메서드의 쓰기 여부를 보고합니다. 읽기 전용 조회로 `materials.list`(intake 사실 + sources/ 파일),
  `artifact.list`(build/ 출력 영역·정본 outputs 등록 경로·생성 receipt와 해시가 일치하는 루트 Word), `artifact.preview`(xlsx 읽기 전용 표·md 텍스트·pdf 표지)가 있습니다.
  `project.major`는 원본의 공개 전공 계약으로 유효 바인딩만 읽습니다. renderer는 그 전공을 출력 요청의 `major_id`로
  명시하고 원본이 정본 바인딩과 다시 대조합니다. 없거나 무효인 바인딩은 전공 확인 요청으로 돌아가며 기본 전공을 만들지 않습니다.
  출력 취소는 전공 사전 조회부터 같은 clientId로 추적합니다. 조회 중 취소하면 main이 이미 읽기를 끝냈어도
  후속 출력은 시작하지 않으며 UI 대기를 끝냅니다. 이미 시작한 출력은 기존 main/sidecar 취소 결과를 따릅니다.
  진행 줄의 취소 단추는 오른쪽에 고정해 경과 시간의 숫자나 단계 문구가 바뀌어도 움직이지 않습니다.
  `office.clean`은 요청한 job 목록 전체를 원본 cleanup_guard에 넘깁니다. 닫힌 job의 삭제와 미확인 세션의
  보존·거절을 함께 보고하며, 일부 job이 거절되면 전체 성공으로 표시하지 않습니다.
  출판 오류는 commit 상태와 exit 2(미반영)·3(반영 후 정리 남음)·4(반영 여부 불명)를 유지합니다.
  잠금은 `gg_lock.inspect_lock`(구조 조회), `probe_lock`(일회성 점유 관측), `cleanup_owner`(소유 증거만 정리)를 사용합니다.
  점유 관측은 다음 쓰기 허가가 아니며, 정리는 실제 OS guard를 재획득한 경우에만 실행합니다. PID나 기록의 나이로 해제하지 않습니다.
  기존 정본의 v2 전환은 모든 writer 중단을 명시 확인하는 별도 오프라인 절차입니다. 자동 init·잠금 삭제·전환은 하지 않습니다.
- `src/main/` — 인터프리터 선택(`KNUAF_PYTHON` > `<프로젝트>/.venv` > 번들 python > PATH), 사이드카 브리지, IPC, 설정.
  `file:read`는 작업 폴더 안 `.pdf`/`.md`/`.txt`만(50MB 이하) 바이트로 돌려주고, `file:save-as`는 폴더 안 파일을
  사용자가 고른 위치로 복사합니다 — 둘 다 경로가 폴더 밖으로 나가면 거절합니다.
  사이드카의 폴더 설정·재시작은 직렬화하고, 이전 프로세스와 stdio의 종료를 확인하기 전에는 새 실행기를 띄우지 않습니다.
  시작 응답(`ready`와 `methods.list` 합계)은 10초 제한이며, 실패하면 소유 프로세스를 종료·정리합니다.
  종료 요청은 진행 중인 시작과 이미 큐에 있던 시작을 취소하고 즉시 종료 절차에 들어갑니다. 동시 종료 요청은 같은 정리에 합류합니다.
  정상 종료 3초 뒤 강제종료를 시도하며 종료 절차 전체 6초 안에 확인되지 않으면 실패로 격리합니다. Windows 강제종료는
  `taskkill /PID <소유 PID> /T /F` 성공과 sidecar close를 모두 요구합니다(launcher/base 전파는 Windows 실기기 확인 필요).
  종료 오류의 `data.recovery=retry_stop`이면 설정의 **적용·재시작**으로 같은 실행기 종료를 재시도합니다.
  `external_cleanup`이면 새 spawn 없이 외부 정리 안내를 표시합니다. 앱만 다시 켜도 잔류 프로세스가 없어짐을 보장하지 않으며,
  다른 작업을 저장한 뒤 컴퓨터 재시작을 안내합니다. 앱 종료도 사이드카 종료 결과를 기다립니다.
- `src/main/chat/` — Codex App Server(`codex app-server`)·Claude Agent SDK와의 구조화 채팅. 스냅샷은
  `<프로젝트>/.knuaf-gui/chat-<provider>.json`에 남고, 실행 중 종료는 `interrupted`/`uncertain`으로 복구됩니다.
  앱 종료가 시작되면 연결 상태를 다시 조회하거나 새 도우미 연결을 만들지 않고 기존 연결을 정리합니다.
  도우미 실행 중에는 사이드카 쓰기 호출이 `agent_busy`로 거절됩니다(반대로 앱이 쓰기 중이면 채팅 전송이 거절됩니다).
  `~/.codex/skills`·`~/.agents/skills`에 남은 전역 `knuaf-dev` 사본은 codex `-c skills.config=…` 오버라이드로
  그 세션에서만 끕니다(사용자 config.toml은 건드리지 않음) — 낡은 사본이 프로젝트 사본과 이름 충돌하지 않게.
- `src/main/userdata.ts` — 앱 표시이름이 바뀌며 생긴 옛 `userData` 폴더에서 `settings.json`을 한 번 이어 받습니다.
  새 폴더가 이미 설정을 갖고 있으면 건드리지 않고 옛 폴더도 삭제하지 않습니다. 이름을 또 바꾸면
  `LEGACY_USERDATA_NAMES`에 옛 폴더 이름을 추가하세요.
- `src/preload/` — `window.knuaf` (contextIsolation, sandbox).
- `src/renderer/` — React 화면. 앱을 켜면 대화 입력칸이 바로 열리고, 모델 칩에서 AI 연결과 전환을 관리합니다.
  왼쪽 프로젝트 목록은 최근 폴더를 보여 주며 좁은 창에서는 서랍으로 열립니다. 첫 메시지 뒤
  `문서/knuaf-dev/<논문 이름>`에 새 폴더를 만들거나 기존 폴더를 고릅니다. 같은 이름이 있으면 새 이름을 붙여 기존 폴더를 보존합니다.
  폴더 생성 중 새 논문을 시작하면 이전 요청은 대화를 열거나 보내지 않습니다. 이미 만들어진 폴더는 자동 삭제하지 않습니다.
  프로젝트 목록에서 파일 관리자로 폴더를 열 수 있습니다. AI 회사는 서로 대화 맥락을 공유하지 않습니다.
  **자료** / **결과물**(목록·미리보기·파일 만들기) / **점검**(할 일·고칠 곳·네 가지 확인) /
  **설정**(폴더·도우미 연결·문제 해결·고급 도구·실행기)은 작업 공간 위에 엽니다.
  `helper_mode`는 `codex-chat`/`claude-chat` 둘(claude-chat은 Agent SDK 경로로 아직 실험 중);
  구 `codex_terminal`과 제거된 인앱 터미널 값(`codex-term`/`claude-term`)은 로드 때 채팅으로
  마이그레이션됩니다(`src/main/settings.ts`). 채팅이 막힐 때의 비상구는 설정의
  "앱 밖 터미널로 도우미 열기" 버튼(`.command` + `shell.openPath`)입니다.
  처음 여는 논문 폴더에서는 진입점과 관계없이 한 번 권한 방식을 묻습니다. "항상 허용"은 모든 논문 폴더에서 요청을 자동 승인합니다(파일 변경 및 폴더 밖 명령 포함).
  "매번 묻기"는 전역 확인을 켜고 기존 폴더별 예외도 지웁니다. 설정에서 전역 선택을 바꿀 수 있습니다. Windows는 첫 폴더를 열기 전에 임시 파일 쓰기 시험을 합니다.
  - 자료: intake 사실로 기록된 현재 작성물·재무 파일과 sources/ 파일 목록(현재 작성물·참고자료 구분)을 보여 줍니다.
    파일을 골라도 채팅 답변에 경로를 넣을 뿐 현재 작성물로 채택하지 않습니다(intake-selection.md).
  - 결과물: build/ 아래의 DOCX·XLSX·PDF·MD와 `project.json.outputs` 등록 파일을 목록·미리보기·다른 이름 저장·외부 열기 합니다.
    루트 Word는 `build_docx.py`가 발행한 동반 `.manifest.json`의 `kind: draft`·입력 해시·현재 파일 해시 일치가 있어야 포함합니다.
    정본 등록은 `adopt_output`이 만든 `.gg-artifacts/` 관리 사본 경로를 사용합니다. 루트 원고·참고자료는 확장자만으로 포함하지 않습니다.
    파일 목록을 열 때와 도우미 작업이 끝날 때 다시 읽으므로 정본 개정이 바뀌지 않아도 생성 파일이 반영됩니다.
    대화·자료·점검의 프로젝트 파일 링크도 같은 미리보기 시트를 엽니다. PDF는 pdf.js (`pdfjs-dist`, Electron 37 Chromium과 맞지 않아
    `legacy` 빌드)로 그리고, DOCX는 `docx-preview`를 sandbox iframe 안에서 렌더링합니다. 그림·수식·복잡한 서식은
    일부 다를 수 있다는 안내를 표시합니다. XLSX는 사이드카가 openpyxl로 읽은 표를 그립니다(재계산 안 된 수식이 과반이면 경고).
    openpyxl이 없는 실행기를 선택한 경우에는 빈 화면 대신 패키지 준비가 필요하다는 이유와
    **원래 앱으로 열기** 안내를 표시합니다. 표 시트가 없는 파일도 빈 상태 안내를 표시합니다.
    논문 준비가 끝나지 않아 만들 수 없으면 파일 목록에 이유와 도우미에게 준비를 요청하는 안내를 표시합니다.
    **재무 엑셀 만들기**는 유효 전공 바인딩을 확인하고 등록한 학생 재무 파일을 우선 복사합니다. 선택한 파일의
    읽기 실패를 동봉본으로 대체하지 않습니다. 등록 파일이 없으면 전공별 양식을 먼저 확인하도록 안내하며,
    특용작물 전공에서 명시적으로 선택한 X01만 동봉 자산으로 만듭니다. H01·X02를 X01로 대체하지 않습니다.
    다른 전공은 원본의 지원 출력·양식 조사 계약을 그대로 따릅니다. 새 사본은 실제 Excel 재계산·본문 대조·제출 승인이 아닙니다.
    **재무 파일 검사**는 명시한 source → 등록된 학생 재무 파일 → source가 없을 때만 전공별 양식 순서입니다.
    빈 입력칸도 source 생략으로 처리합니다. 학생 파일 검사는 전공 없이 가능하며, 손상·유실 오류를 동봉 양식으로 대체하지 않습니다.
    설치는 assets와 `version.json`·`skill.json`·`install-manifest.json`을 보존하며, root metadata도 내용 fingerprint에 포함합니다.
    프로젝트 두 공급자 설치 경로는 `.knuaf-gui/skill-install.json`에 기록해 원본 `gg_update.py auto`가 `managed`로 종료하게 합니다.

스킬(`knuaf-dev`)은 전역이 아니라 프로젝트 로컬(`<프로젝트>/.claude/skills`, `<프로젝트>/.agents/skills`)에 설치됩니다.

### 모델 칩

입력칸의 모델 칩에서 계정이 쓸 수 있는 ChatGPT 모델과 생각 깊이를 고릅니다.
폴더를 정하기 전에도 고를 수 있으며, 선택은 `settings.json.chat_models`에 공급자별로 남습니다.
같은 회사 모델은 다음 메시지부터 같은 대화에 적용됩니다. 기본은 **안 고름(계정 기본)**입니다.
고른 적 없는 학생에게는 기본값 확인용 임시 대화를 만들지 않고, 전송에 model·effort도 붙이지 않습니다(L-02).

추천과 용도는 `src/shared/chat.ts`의 확정표를 씁니다. 계정 목록에 Sol 또는 Astra가 있으면 높음 줄,
없으면 낮음 줄을 쓰고, 목록에 없는 모델·숨긴 모델은 표시하지 않습니다.
별칭과 실제 계정 모델의 대응·요금제별 이용 가능 여부는 실기기 확인 대상입니다.
Claude는 모델 목록·추천 없이 기존 계정 기본값을 유지합니다.
검토는 새 대화 안내만 제공하며, 검토용 새 대화나 자동 모델 전환은 구현하지 않습니다.

대화 로드 때 목록을 자동 조회하지 않습니다. 칩을 열면 조회하고, 오류 시 **모델 목록 새로고침**으로 재조회합니다.
읽기 중 새 선택이 시작됐거나 읽기 시작 시 선택 저장이 진행 중이었다면 그 응답의 옛 선택은
화면에 반영하지 않습니다(MC1-03). 관련 회귀는 `e2e/model-chip.spec.ts`,
실제 Electron 조작·같은 대화 전송·밝음/어두움·1440/1024 배치는 `e2e/model-picker-ui.spec.ts`에서 확인합니다.
캡처가 필요하면 `KNUAF_CHIP_CAPTURE_DIR=<저장 폴더>`를 지정해 후자를 실행합니다.
직접 가짜 Codex 연결을 만드는 시험도 `skillTargets()`·`installSkill()`로 프로젝트 스킬을 실제 설치하고,
`subscriptionEnv()`·`fakeCodexEnv()`·`findExecutable()`로 구독 환경과 실행 파일 탐색을 공유합니다.
Windows의 `codex.cmd`·`Path/PATH`와 설치 파일의 경로 별칭을 시험에서 따로 추측하지 않습니다.
가짜 서버의 `skills/list`도 존재하는 `SKILL.md`만 realpath로 보고합니다. 스킬 누락 시 전송 차단과
한글·공백 폴더를 가리키는 별칭(Windows junction/Unix 심링크)의 전송 회귀를 `model-chip.spec.ts`에 둡니다.

### 첫 메시지와 질문 카드

폴더 카드에서 넘긴 첫 메시지는 전송 전에 원래 논문의 초안에 기존 글과 함께 보관합니다.
모델 기본값 확인이나 폴더 준비가 실패·취소되면 그대로 남고, 다른 논문을 보고 있어도 그 논문 초안에 복원됩니다.
전송이 받아들여지면 보관본이 그대로일 때만 기존 초안으로 되돌립니다. 이를 위해
`chat.setDraft(root, text, expected?)`는 `expected`가 있으면 메인의 최신 초안이 일치할 때만 쓰고 성공 여부를 반환합니다.
대화 파일 형식과 폴더×AI 연결 열쇠는 바꾸지 않습니다.

질문 카드 아래에도 같은 모델 칩이 있으며, 모델·생각 깊이를 바꿔도 질문과 직접 입력 초안은 남습니다.
종이의 **고쳐 달라기**는 인용이 그려진 commit에서 입력칸에 초점을 옮깁니다. 여러 칸 질문은
직접 입력칸이 실제로 마운트된 뒤 요청을 소비하며, 다음 애니메이션 프레임을 기다리지 않습니다.
`e2e/qa2b.spec.ts`는 실제 드래그 뒤 초점과 추가 클릭 없는 키 입력을 함께 확인합니다.
앱 화면에는 수정하지 않은 Pretendard Variable 글꼴을 오프라인으로 동봉합니다
(SIL Open Font License 1.1, 원문 `src/renderer/src/fonts/LICENSE-Pretendard.txt`).
질문 제목은 줄 길이를 고르고, 보기 설명은 보기 본문 아래에서 줄바꿈합니다.
논문 종이 미리보기는 설치된 신명조 또는 HY신명조를 우선 쓰고, 없으면 시스템 명조 글꼴을 씁니다.
신명조 글꼴 파일은 앱에 동봉하지 않습니다.
긴 첫 메시지는 표시 높이를 제한하고 내부 스크롤로 읽습니다. 첫 화면 자체도 스크롤할 수 있어 폴더 조작이 막히지 않습니다.
INT1 회귀는 `e2e/int1.spec.ts`가 실제 prepare 실패·늦은 성공·새 편집 보존·질문 답변·1024×768 포인터 접근을 확인합니다.
`KNUAF_INT1_CAPTURE_DIR=<저장 폴더>`를 지정하면 질문 카드와 긴 첫 메시지의 밝음·어두움 캡처를 그곳에 저장합니다.

전송 승인이나 첫 메시지의 초안 정리 응답이 늦어도, 그 사이 스트림으로 받은 답변·완료 스냅샷을
옛 승인 스냅샷으로 덮지 않습니다. `e2e/int1-ci.spec.ts`는 두 반환 지점을 각각 붙잡아 이 순서를 검증합니다.
종료 중에는 앞서 시작한 `project.open()`이 늦게 `chat.load()`를 호출할 수 있습니다.
`e2e/agent-busy.spec.ts`는 그 추가 조회도 발생시키며, 호출 횟수가 아니라 모든 늦은 조회의 종료 오류와
실제 Codex 시작 기록이 늘지 않는 것을 종료 전후에 확인합니다.

## 개발

```bash
cd app
pnpm install
KNUAF_PYTHON=$(which python3.13) pnpm dev          # stage 호환 게이트 → compose 묶음으로 개발 실행
pnpm typecheck
pnpm build && KNUAF_PYTHON=$(which python3.13) pnpm test:e2e   # Playwright-electron 스모크
```

`pnpm -C app test:node`는 저장소 루트에서 실행하는 Node 전용 준비 상태·main IPC 회귀 명령입니다.
별도 `playwright.node.config.ts`의 두 spec 고정 목록만 실행하고 build·Electron·브라우저를 시작하지 않습니다.
`test:e2e`·기본 Playwright 설정은 GUI용입니다. `model-chip.spec.ts`처럼 GUI와 store가 섞인 파일은
Node 전용 목록에 추가하지 마세요. Node 검사는 정식 stage·설치본·실제 화면 검증의 대체가 아닙니다.

일반 Electron E2E의 `openProject()`는 worker마다 `gg_deps.py ensure`로 준비한 실제 패키지 환경을
각 시험 폴더의 독립 `.venv` 디렉터리로 복사한 뒤, 설정 > 문제 해결 > 준비 상태가 **준비됨**일 때 반환합니다.
최초 seed 설치에는 pip 패키지 공급원이 필요하며 설치 실패는 그대로 시험 실패입니다. `.venv` symlink나
IPC 성공 응답만으로 준비를 가장하지 않습니다. 의도적으로 준비를 붙잡는 시나리오는 네 번째 인자의
`{ preparation: 'pending' }`으로 이 전제만 제외하고 실제 `deps.doctor`/`deps:ensure` 경로를 제어합니다.
`doctor.all`은 종합 진단용이므로 준비 대기 fixture로 쓰지 않습니다.

`e2e/review-baseline.spec.ts`는 열린 임시 파일의 부모를 밖으로 옮기는 경합을 검사합니다.
Windows가 열린 자식 때문에 이동을 거절하면 그 오류의 전파와 원위치 임시 파일 정리를 검사하고,
이동이 성공하면 외부 디렉터리의 임시·완성 파일 부재를 검사합니다. 빈 이동 디렉터리의 존재가
보안 조건은 아니며, 어느 경로에서도 비교 기준이 발행되거나 외부 파일이 남아서는 안 됩니다.

재무 파일을 등록하지 않은 생성/미리보기 시험은 양식 안내 뒤 **공용 X01 빈 양식 사용**을 명시 선택합니다.
선택 전 출력이 없고 선택 뒤 실제 통합문서가 문서 탭에서 보이는지 확인하며, 자동 fallback을 요구하지 않습니다.
서명된 규칙집 업데이트 UI 시험은 현재 동봉 `skill.json`의 다음 patch를 후보로 서명하고 동봉판으로 rollback합니다.
같은 버전·다른 내용의 정상 거절을 업데이트 실패로 오인하지 않게 하는 fixture 규칙입니다.

개인 `.harness.conf`나 공유 하네스를 수정할 필요가 없습니다. 종전 훅 명령인
`.venv-dev/bin/python -m pytest`는 추적된 `tests/conftest.py`를 통해 수집 전에
고정 pin을 오프라인으로 준비하고, 실패하면 수집 오류 대신 준비 원인과 비0 종료를 냅니다.
CI의 `test-with-skill.mjs`도 같은 stage를 사용합니다. 직접 실행하려면 저장소 루트에서
`node app/scripts/test-with-skill.mjs --offline --python .venv-dev/bin/python`을 사용합니다.
캐시의 HEAD/tag·전체 상태뿐 아니라 실제 바이트를 고정 commit blob과 대조합니다.
숨김 index 플래그로 가린 변조도 거절하며, 검증한 입력의 격리 사본으로 호환 시험을 합니다.
준비 실패 시 예전 `resources/skill`로 통과시키지 않습니다. 상세 캐시/로컬 검증 절차는 루트 README를 따릅니다.

원본은 `skill-source.json`의 고정 commit/tag, 앱 전용 차이는 `skill-overlay/`입니다.
`stage:skill`은 W2 compose 결과를 최종 bytes 그대로 소비자·원본 내부 시험과
`UPSTREAM_PROTECTION_TESTS`에 명시한 원본 루트 보호 시험에 넣습니다.
이 목록은 앱에서 이관한 유효 보호에 대응하며 원본 루트 전체를 무조건 수집하지 않습니다.
시험이 누락되거나 하나라도 실패하면 동봉을 거절합니다. 모두 성공한 경우에만
`resources/skill/`로 동봉하며 dev/build/resource 준비·skill-release CI가 같은 게이트를 사용합니다.
실패하면 이전 묶음을 보존하며 구판 사본으로 자동 대체하지 않습니다.
호환 실패 메시지의 `consumer`·`upstream` 숫자는 시험 건수가 아니라 pytest 종료코드입니다(`0`은 성공).
소비자 시험은 Kordoc 차단 예외의 `reason`·`details`(자식 종료코드·stderr 포함)와 live guard의 probe/cleanup
응답을 실패 보고서에 남깁니다. 이 진단 출력은 stage 차단 조건을 바꾸지 않습니다.
Windows 가짜 Kordoc은 원본 fixture처럼 shim 옆 `node_modules/kordoc/dist/cli.js`를 제공해 실제 패키지로
넘어가지 않고 shell-free 경로를 시험합니다. 잠금 시험은 Windows의 `unavailable/busy_or_denied`와
`lock_ambiguous` 거절을 정확히 확인하고 owner/guard 보존·해제 뒤 정리 검사를 동일하게 수행합니다.
사이드카 시험 클라이언트는 단일 reader와 queue로 JSON-lines를 받아, 한 번에 도착한 이벤트·완료 응답을
TextIOWrapper가 미리 읽어도 OS `select()` 대기로 잃지 않습니다. 취소 완료의 5초 제한은 유지합니다.

현재 pin은 v0.4.2(`60311c11fbf12fdc04249be8c75eeaf027c06a66`)입니다.
pin 변경 시 consumer·upstream 내부·보호별 upstream root 전체 게이트를 통과해야 하며, 시험 제외·로컬 원본 패치·낡은 stage로 성공시키지 않습니다.
문서 소비자 보호는 최종 `SKILL.md`와 하위 `references/**/*.md`에서 퇴역 원장을
새 기록·쓰기 대상으로 지시하는 문형과 저장 위치 표를 거절합니다. 읽기·보존·쓰기 금지
언급은 허용합니다. 이후 원본 판이 다시 위반하면 제외 없이 거절합니다.

로컬 검증용 compose는 `KNUAF_SCRIPTS_DIR=/절대/묶음/scripts`(앱)와
`KNUAF_TEST_SCRIPTS_DIR=/절대/묶음/scripts`(pytest)로 지정합니다.
stage를 통과하지 않은 로컬 입력은 **검증 전용**이며, `pnpm exec electron-vite build`로 띄운 화면을
정식 stage/build·설치본 검증 통과로 집계하지 않습니다. packaged 앱은 개발 override를 무시합니다.

S0는 동봉 묶음의 `skill.json` 판/API를 읽으며 암묵적 1.0.0 추정은 없습니다.
에이전트 설치·사이드카·채팅은 같은 선택 묶음을 사용합니다. root metadata도 fingerprint에 들어가고
재설치 시 학생 수정 사본을 skill 탐색 경로 밖으로 백업합니다.
프로젝트 `.knuaf-gui/skill-install.json`은 양쪽 설치 경로를 표시하며, 설치본의 `gg_update.py auto`는
`managed`로 종료하여 앱 업데이트 경로와 경쟁하지 않습니다.

### 의존성 준비 계약

- 합성 스킬 판은 채널의 `skill.version`과 `package.json.skillVersion`(이번 배정 1.0.1) 중 높은 값을 stage 입력으로 사용합니다.
  앱 판·upstream 판·SKILL_API와 별개입니다. overlay.json에는 version을 추가하지 않습니다.
  skill-release는 게시·초안 최대값의 다음 patch와 배정값을 비교해 기존 번호를 재사용하지 않습니다.
- 폴더 열기가 성공하면 다음 비동기 조회보다 먼저 방문별 `checking`과 진행 카운터를 등록합니다.
  `deps.doctor`는 종합 `doctor.all`과 분리하고, current Python이 아닌 프로젝트 `.venv`의 실제 import·버전 확인만 ready로 인정합니다.
  빈/손상 진단은 blocked이며 설치를 시작하지 않습니다.
  실패한 다른 폴더 열기는 현재 폴더 방문의 소유권을 취소하지 않습니다. 열기 요청 세대는 별도로 증가해 오래된 성공은 거절합니다.
  main도 수동 재진단 시작 즉시 전송을 닫습니다. 현재 방문의 모든 진단이 끝나고 최신 진단이 ready일 때만 열며,
  실패·취소·옛 방문의 응답은 최신 준비 상태를 ready로 덮지 않습니다. 설치 중 진단은 설치 전체 검증의 소유권을 빼앗지 않습니다.
- 준비 결과는 `checking → installing → verifying → ready | blocked`입니다. 카운터 0은 성공이 아닙니다.
  자동 준비와 수동 패키지 준비는 같은 action·root별 physical single-flight를 사용합니다. 다시 진단은 설치하지 않습니다.
  설치 뒤 main 실행기 선택·재진단과 renderer 재조회까지 기다립니다. 오래된 방문은 현재 실행기·화면을 바꾸지 않습니다.
- 실패·취소·agent_busy면 전송 대기를 끝내되 초안을 보존하고, 준비 오류·다시 준비 동선을 남깁니다.
  재준비 성공이 거절된 메시지를 자동 전송하지 않습니다. 만들기도 ready 이전에는 실행하지 않습니다.
  소유한 설치 취소/종료는 자식 pip까지 중단하며, Windows taskkill 경로는 실기기 검증이 별도로 필요합니다.
  POSIX는 기존 TERM → wait → 그룹 KILL 순서를 유지합니다. 마지막 KILL의 PermissionError는
  `/bin/ps`의 PGID·상태 조회로 해당 그룹에 좀비(Z) 아닌 구성원이 없음을 확인한 경우에만 허용합니다.
  살아 있는 구성원이 있거나 조회가 실패하면 `process_stop_failed`이며, 리더 종료만으로 성공 처리하지 않습니다.
  cancel/shutdown은 이 오류를 해당 제어 요청에 응답하고 서버를 유지합니다. 취소 실패 자체는 작업 스레드·
  쓰기 락·pending의 수명을 바꾸지 않습니다. 이 국소 조회는 PGID 소유권/reap 경합이나 조회 뒤의 변화를
  방지하지 않으며, 그룹을 벗어난 후손의 종료까지 증명하지는 않습니다.

## 서명된 앱 업데이트 채널 게시

- `.github/workflows/app-release.yml`은 `main`에서 수동 실행하며, 이미 존재하는 릴리스 태그 하나만 받습니다. 설치본 자산 이름은 태그에서 계산합니다. 태그 커밋이 `main`의 조상이고, 태그 시점 앱 버전과 현재 업데이트 공개키가 `main`과 일치해야 합니다.
- 서명 전 `release.yml`의 `windows-installer` 아티팩트와 릴리스 자산의 바이트·크기를 대조합니다. 실행 아티팩트를 보관 기간 안에 찾지 못하면 멈춥니다. `SHA256SUMS-windows.txt` 대체는 허용하지 않습니다.
- 서명 job은 `skill-release` 환경의 기존 `SKILL_SIGNING_PRIVATE_KEY`만 사용합니다. 개인키에서 계산한 공개키의 DER 바이트를 앱의 `current` 공개키와 비교하며, 값은 출력하지 않습니다. 불일치하면 서명 전에 실패합니다.
- 키 비교 기준에는 시점 차이가 있습니다. 준비 job은 checkout 시점 `origin/main`의 `keys.ts`를 태그와 비교하지만, 서명 job은 실행 시작 시점 `github.sha`의 키를 사용합니다. 실행 시작부터 채널 PR 반영 완료까지 `keys.ts` 변경을 머지하지 마세요. 이 구간에 키 변경이 있었다면 실행 결과를 채널에 반영하지 말고, 키 변경이 반영된 `main`에서 새로 실행하세요. 이는 운영상 동결 규칙이며 시점 차이를 코드로 제거한 것은 아닙니다.
- 성공 시 워크플로는 `app-channel-v<V>` 갈래만 push합니다. PR은 사람이 열고, 자동 PR·태그·릴리스 생성은 하지 않습니다. 열린 채널 PR 또는 `main`에 아직 포함되지 않은 채널 갈래가 있으면 실행을 멈춥니다.
- `skill-release`의 정기 실행은 열린 앱·스킬 채널 PR이 있으면 새 작업 없이 정상 종료합니다. 수동 실행은 기존처럼 실패하며, 열린 채널 PR 없이 미병합 갈래만 남은 경우에는 정기 실행도 실패합니다. 상태 검사기는 로컬 `origin/main` 없이 원격 main SHA를 조회하므로 SHA만 받은 깊이 1 checkout에서도 동작합니다.
- 앱·스킬 채널 PR은 **merge commit**으로 머지합니다(squash/rebase 금지). squash/rebase로 원래 갈래 커밋이 `main`에 포함되지 않으면 다음 채널 실행이 안전상 중단됩니다. 이 경우 책임자가 채널 반영을 확인하고 남은 갈래를 정리한 뒤 재실행합니다.
- PR 전에는 `updates/channel.json`의 앱 항목 외 내용, 특히 기존 `skill` 항목이 `main`과 같은지 확인합니다. 0.6.0은 채널 변경을 릴리스 공개 전에 머지하고, 공개 직후 아래 검사를 실행해 결과를 기록합니다. 0.6.1부터는 공개 뒤 자산 검사를 통과하고 그 결과를 PR에 첨부한 후 머지합니다.

```bash
node app/scripts/check-app-channel.mjs --channel updates/channel.json
```

이 검사는 앱 채널의 서명·판·페이지를 확인한 뒤 GitHub 릴리스 자산을 인증 없이 GET하고, 서명된 크기와 SHA-256을 대조합니다. 벡터 회귀와 소비자 검증은 `node --test app/scripts/tests/app-release.test.mjs` 및 `pnpm -C app exec playwright test e2e/app-update-vector.spec.ts`로 실행합니다.

사이드카 프로토콜 테스트는 저장소 루트의 `tests/test_sidecar.py`에 있습니다.

알려진 A안 한계(독립검토 A1): 사용자 문구의 `copy.ts` 중앙관리 AST 검사는 대체 없이 제거되어
일부 새 화면 문구가 인라인입니다(A1-04). 첫 화면에는 시안의 세 가지 시작 제안 칩이 없습니다(A1-05).

브리지 수명주기·격리 회귀는 `e2e/sidecar-lifecycle.spec.ts`, 실제 Electron 재시작·오류 표시·PID 정리는
`e2e/sidecar-app.spec.ts`에서 확인합니다: `pnpm -C app build && pnpm -C app exec playwright test sidecar-lifecycle.spec.ts sidecar-app.spec.ts`.

개발·테스트 전용 환경 변수:

- `KNUAF_SCRIPTS_DIR=/절대/compose/묶음/scripts` — 개발 모드에서 **묶음 전체**의 원본을 선택합니다. 부모 묶음의 `skill.json`이 필요합니다. 사이드카·에이전트 설치·W1의 S0가 같은 묶음을 사용하며, 설치본에서는 무시합니다.
- `KNUAF_TEST_SCRIPTS_DIR=/절대/compose/묶음/scripts` — pytest의 원본 선택. 예: 저장소 루트에서 `KNUAF_TEST_SCRIPTS_DIR=… .venv-dev/bin/python -m pytest tests/test_sidecar.py tests/test_sidecar_read_all.py tests/test_sidecar_publication.py`.
- `KNUAF_CLAUDE_MODEL=sonnet` — Claude 채팅 SDK 세션에 `model`을 고정합니다(테스트 전용).
- `KNUAF_DRY_LAUNCH=1` — 외부 터미널 실행 스크립트를 쓰기만 하고 열지 않습니다(테스트 전용).
- `KNUAF_LIVE=1` — `e2e/live-*.spec.ts`를 포함해 실행합니다. 실제 Claude/Codex 로그인과 구독 사용량이 필요하므로 기본 실행에서는 제외됩니다.
- `KNUAF_WINDOW_SHOTS=1` — 실제 창을 맨 앞으로 올려 찍는 macOS 안내서 사진 생성기 `e2e/window-shots.spec.ts`를 함께 돌립니다: `KNUAF_WINDOW_SHOTS=1 pnpm -C app test:e2e`. e2e 창은 기본적으로 화면에 뜨지 않습니다(`KNUAF_E2E_HIDDEN=1` — 창을 눈으로 보려면 `KNUAF_E2E_VISIBLE=1`).
- 화면 확인용: `app/e2e/watch-frontmost.sh <기록 파일> [초]`(macOS) — 0.5초 간격으로 화면 맨 앞 앱과 창이 화면에 있는 앱을 기록합니다.

## 패키징 (Phase 6)

```bash
pnpm dist:mac           # 또는 pnpm dist:win
```

`dist:*`는 필요한 리소스(번들 python, 휠하우스, 아이콘, 학생용 안내 PDF, 스테이징된 스킬)를
먼저 준비합니다. 개별로 돌리려면:

```bash
pnpm stage:skill        # 고정 knuaf-doc + 앱 overlay → 호환 게이트 → resources/skill
pnpm fetch:python       # python-build-standalone 3.12 → resources/python
pnpm build:wheelhouse   # staged 요구·bundled ABI/대상별 휠 검증 + 동봉 Python에 미리보기용 openpyxl 설치
pnpm build:icons        # build/clay-icons/*.png → iconset·icns·ico·png (Chromium 실행)
pnpm build:guide        # docs/학생용-사용안내.md → .html·.pdf (Chromium 실행)
pnpm build:guide --html-only  # 브라우저 금지 환경: HTML만 갱신, PDF는 그대로
```

번들 Python은 사이드카 실행과 `gg_deps.py ensure`의 base 인터프리터로 쓰입니다.
XLSX 미리보기는 프로젝트 패키지 준비 전에도 동작해야 하므로 `build:wheelhouse`가 동봉 Python에
openpyxl과 그 의존성(et-xmlfile)만 오프라인으로 설치하고 import를 확인합니다. 기존 휠하우스를
재사용해도 이 설치·확인은 생략하지 않습니다. 논문 작성·문서 도구의 나머지 패키지는 기존대로
`<프로젝트>/.venv`에 설치됩니다. 명시적 실행기·프로젝트 venv·관리 런타임의 선택 우선순위는 바꾸지 않습니다.
wheelhouse는 `.Complete`의 요구 파일·manifest·명세·동봉 Python ABI/대상·wheel 해시가 모두 맞을 때만 재사용합니다.
동봉 Python이 없거나 PYTHON override/교차 대상이면 빌드를 거절합니다. 오프라인 설치 실패 후 온라인 재시도는
두 단계의 원인을 보존하며, 취소 뒤에는 다음 설치 단계를 시작하지 않습니다.

XLSX 렌더러 회귀: `pnpm -C app exec playwright test xlsx-preview.spec.ts`.
이 스펙은 Electron을 실행하지 않지만 headless Chromium을 실행하므로 브라우저 금지 환경에서는 실행하지 않습니다.
Windows 분기는 브리지의 platform 값으로 확인하므로 Windows 설치본 실기기 검증을 대신하지 않습니다.

## 지키는 규칙 (스킬 문서에서 옴)

- 인터뷰 답변을 GUI로 받지 않음(`interview-ui.md`). 절 본문은 읽기 전용.
- 학생에게 JSON·명령어·모델 선택을 요구하지 않음(`SKILL.md:15`).
- 기계검사 / 내용검토 / 출력검토 / 교수 승인 4레인을 하나로 합치지 않음(`SKILL.md:34`). 진행률 % 없음.
- 유효한 독립검토가 없으면 최상단에 `독립검토 미실행` 배너.
- 잠금 구조·점유 관측은 분리합니다. 실제 guard를 점유할 수 있을 때만 남은 소유 기록을 정리하며 살아 있는 작업을 끊거나 guard를 삭제하지 않습니다.
- AI 도우미를 연결하면 답변과 작업 폴더의 내용이 선택한 제공업체(OpenAI 또는 Anthropic)로 전송됨.
  앱 자체는 그 외 어디에도 자료를 보내지 않음.
