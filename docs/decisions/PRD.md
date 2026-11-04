<!-- 
PRD(Product Requirements Document, 제품 요구사항 정의서) 한 장 양식
- 형님의 결정을 받아 적는 문서다.
- 사람이 아직 결정하지 않은 칸은 기본값 `비어 있음`으로 유지한다.
- AI가 임의로 예시나 가상의 결정을 채워 넣지 않는다.
- 채운 항목 끝에는 근거를 붙인다: (형님 원문 "…", YYYY-MM-DD, 출처 경로). 근거 없는 내용은 `비어 있음`으로 둔다.
-->

# 제품 요구사항 정의서 (PRD) — 창업논문 도우미 (knuaf-dev)

<!-- 1. 누구를 위해: 이 제품이나 기능을 주로 사용하는 대상(사용자 페르소나/타깃 집단)을 적는다. -->
## 1. 누구를 위해 (Target Audience)
- 한국농수산대학교(한농대) 학생 등 창업논문 작성이 필요한 사용자 (형님 피드백 "한농대 학생 — 뇌 빼고 쓰는 쉬운 UI", 2026-10-18, /Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/DESIGN.md:20 / 형님 원문 "뇌 빼고 쓰는 사람, 지능이 낮은 사람도 쉽게 쓸 수 있는 UI,UX를 지향해야한다.", 2026-11-03, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:41)
- 비전공 여부 및 컴퓨터/AI 도구 숙련도별 추가 페르소나 정의: 비어 있음 (형님 원문에는 비전공/도구 비숙련 제한이 없으므로 임의로 좁히지 않고 6절 열린 질문으로 분류)

<!-- 2. 풀 문제: 사용자가 겪는 핵심 불편(Pain Point, 고통 지점)과 이 작업으로 해결하려는 문제를 적는다. -->
## 2. 풀 문제 (Problem Statement)
- 문서 미리보기가 외부 앱이나 별도 레이어로 겹쳐 열려 맥락이 끊기고, 생성된 산출물 파일에 학생들이 쉽게 도달하지 못하는 불편 (형님 원문 "v0.6.0 공개 당장 안되겠다. 인앱 문서가 다른 레이어로 열리는 수준이라 부품들 붙이고 그냥 배포해야겠음. 지금은 좀 부끄럽다", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:26 / 형님 원문 "채팅 파일 버튼은 바로 열기면, 인앱 문서는 어떻게 켜는건가? 기본적으로 인앱부터 켜야지." 및 "최소한 산출물이라도 인앱에서 볼 수 있게 하는 게 우리 주 목적이자 강점", 2026-11-03, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:38)
- 명확한 요구사항 정의서와 결정 문서 없이 작업을 진행하여 전체 로드맵과 세부 결정 사항을 인지하기 어려운 문제 (형님 원문 "저런 결정 문서가 너무 필요하다. 못해서 PRD와 5층 설명을 문서화로 해서 내가 계속 인지하면서 작업을 해야하는데, 지금 거의 주먹구구식으로만 다 작업을 하고 있어서 슬프네. 이런 걸 타파하고 효율적으로 하고 싶어. 하다못해 맥북 바탕화면에 todos 위젯 같은걸 표시하던지 다른 방식으로 내가 로드맵 자체를 인지하고 있으면 좋을 것 같아.", 2026-11-04, /Users/nara/work/harness/2026-11-04-decision-docs/ORDER.md:15 / 축약본: /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:20)

<!-- 3. 성공 기준: 문제가 잘 해결되었는지 판단하는 측정 가능한 목표나 확인 조건을 적는다. -->
## 3. 성공 기준 (Success Criteria)
- 학습 비용 없이 누구나 바로 직관적으로 누르고 진행할 수 있는 쉬운 UI/UX 달성 (형님 원문 "뇌 빼고 쓰는 사람, 지능이 낮은 사람도 쉽게 쓸 수 있는 UI,UX를 지향해야한다.", 2026-11-03, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:41)
- 외부 뷰어를 띄우지 않고 앱 내부에서 산출물 문서(Word, Excel 등)를 곧바로 열어 확인 가능한 인앱 뷰어 체계 완성 (형님 원문 "최소한 산출물이라도 인앱에서 볼 수 있게 하는 게 우리 주 목적이자 강점", 2026-11-03, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:38)
- 논문 완성 소요 시간 단축률 등 정량적 성공 지표: 비어 있음

<!-- 4. 하지 않을 것: 이번 범위에서 의도적으로 제외(Out of Scope, 범위 밖)하거나 절대 하지 말아야 할 경계를 적는다. -->
## 4. 하지 않을 것 (Non-Goals / Out of Scope)
- 논문GUI 학생 그림 점검 기능에 형님 돈으로 유료 멀티모달(Jev) 호출 적용 제외 (형님 원문 "1,2번은 넣긴 할텐데 그건 나중의 일 아닌가? 메모바람. 3번은 굳이 내 돈으로 학생을??? 안해도 될 듯.", 2026-10-28, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:117)
- macOS 앱 배포 시 유료 애플 개발자 코드 서명 및 공증(연 99달러) 진행 보류 (형님 원문 "다 권고대로, Q4는 보류", 2026-10-31, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:77)
- 인터뷰 진행 시 학생 전공 선택 항목에 임의의 추천 배지나 표시 부여 금지 (형님 원문 "전공에서는 추천 넣지마라. 전공은 이미 자기 전공이 정해져 있는데, 작목 때문에 전공에 추천을 붙일 이유도 없음.", 2026-10-28, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:92)
- 학생 크레딧을 소진시키는 캐시 데우기(warming) 기능 구현 보류 (형님 원문 "ㅇㅇ 권고대로 해보자", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:30)
- 앱 내 엑셀 직접 편집 기능 제공 제외: 비어 있음 (10-29 구두 요약 기록 "앱 안에서 엑셀 직접 편집 기능은 필요 없음(채팅으로 고치면 됨)"은 따옴표 원문이 없어 열린 질문으로 분류)

<!-- 5. 단계 (로드맵): 판 번호(버전)별로 배포할 범위를 한 줄씩 적는다. -->
## 5. 단계 (Roadmap)
- v0.6.0: 인앱 문서 탭형 보기, 오른쪽 '내 논문' 종이 칸 및 여닫이 단추 다안, 문제 신고 단추, 윈도우 '나만 설치' 통일(기존 Program Files 설치본은 v0.6.0 1회 UAC 정리 예외), 앱 표시 이름 '창업논문 도우미', 순백 A 아이콘 조립 후 배포 (형님 원문 "v0.6.0 공개 당장 안되겠다. 인앱 문서가 다른 레이어로 열리는 수준이라 부품들 붙이고 그냥 배포해야겠음. 지금은 좀 부끄럽다", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:26 / 형님 원문 "창업논문 도우미로 하자.", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:19)
- v0.6.1: v0.6.0 공개 직후 무인 업데이트 동작 확인(형님 위임 "1,2번 알아서 해" 아래 책임자 계획 AP:8, H:18), kordoc MCP 연동 준비 (형님 원문 "권고로 가자 v0.6.0부터 출시하고 후속으로 하자. 대신 준비는 지금 할 수 있지않나?", 2026-11-03, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:46). (참고: 빈 목차는 v0.6.1 이후 배분 — 형님 원문 "그냥 빈 목차를 빼버릴까 ㅋㅋ 빈 목차 우선 빼고 내는 건 괜찮다.", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:24)
- v0.6.2: HWPX 산출 정식 지원 및 스킬 v0.4.1 패키징 묶기, 서명 키 정비 (형님 위임 "1,2번 알아서 해" 아래 책임자 계획 — 형님 확정 아님, DECISIONS SCO-11, 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:18 / /Users/nara/work/knuaf-dev/2026-11-04-v060-assemble/PLAN.md:33)
- v0.7: 다중 모델 오케스트레이션(Arena 기준 재설계 레인표 기본 제공 및 사용자 지정 오케스트레이션 최우선), 캐시 토큰 기록(일정 안 밀릴 때만 — 형님 원문 "ㅇㅇ 권고대로 해보자", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:30) (형님 원문 "Q3. 이거 우리가 레인 배치를 짜자. 당연히 사용자가 원하는 오케스트레이션을 얘기하면 우선으로 해주고... 사용자 오케스트레이션을 우선으로 하자.", 2026-10-31, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:76 / 형님 원문 "이대로 해보자. 조사 경로를 우리 스킬에 잘 녹이면 좀 괜찮겠지", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:18)
- v0.7.1: Claude excludeDynamicSections 비교 분석 및 프롬프트 캐시 최적화 (형님 원문 "ㅇㅇ 권고대로 해보자", 2026-11-04, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:30)

<!-- 6. 열린 질문: 아직 결정되지 않았거나 추가 확인이 필요한 항목을 적는다. -->
## 6. 열린 질문 (Open Questions)
- 대상 사용자의 세부 페르소나(비전공 여부, 컴퓨터/AI 도구 숙련도별 차등 지원 필요성 등)를 어떻게 정의할 것인가? (/Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/DESIGN.md:20, /Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:41)
- v0.6.0 배포 시 메인 화면 제목줄에 '초기 베타' 표시를 유지할 것인지 여부 (/Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:24)
- 앱 내 엑셀 직접 편집 기능 제외 방침을 향후에도 계속 유지할 것인지, 아니면 제한적인 셀 수정 기능을 지원할 것인지 여부 (/Users/nara/.omo/memory/agents/xai-grok-4-6-3c17c0d3/repo/system/human.md:88)
- 인터뷰 시작 시 AI 모델이 첫 질문에서 학교 표준 7개 장(`project.sections`)을 미리 등록하지 않을 경우 빈 목차 UX의 대체 표시 정책 (/Users/nara/work/knuaf-dev/2026-11-04-v060-assemble/DESIGN.md:35)
