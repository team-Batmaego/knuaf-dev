# 출시·실기기 설치 확인표 (창업논문 도우미)

계기: 2026-11-07 맥 최종 회차가 이름이 같은 마운트 이미지(`창업논문 도우미` vs `창업논문 도우미 1`)를 헷갈려 옛 판(buildCommit 38bc97f0)으로 진행됨 — `HANDOFF-MAC-p60.md`, `REVIEW-SKILL-INSTALL.md`.
형님 지시(2026-11-07 21:09, 오모냥 전달): "옛 버전은 기록용으로 구글 드라이브에 올린 후 정리 하는 게 어때? 앞으로도. 혼용 방지"

설치·재설치 발주문마다 아래 1~3을 넣는다.

## 1. 옛 판 정리 (설치 전)
- [ ] 이전 판 설치 파일(DMG·ZIP·EXE)이 작업 폴더·다운로드에 남아 있으면 **쓰지 않는다**. 디노 정리 대상으로 표시한다(구글 드라이브에 기록용으로 올린 뒤 로컬에서 정리 — 디노 담당).
- [ ] 마운트된 옛 이미지가 있으면 쓰지 않는다. 설치에 쓸 이미지만 남았는지 `hdiutil info`(맥)로 확인한다. 꺼내기·정리는 디노 몫, 시험 칸은 표시만.

## 2. 설치 파일 경로 1:1 대조
- [ ] 설치할 파일의 경로와 SHA256을 산출물(CI 아티팩트·체크섬 파일)과 대조한다.
- [ ] 맥: 그 DMG가 마운트된 **정확한 볼륨 경로**(`hdiutil info`의 image-path ↔ mount-point)를 1:1로 확인하고, 그 경로에서만 복사한다. 번호 붙은 동명 볼륨(`… 1`)에 주의.
- [ ] 윈도우: 설치 실행 파일 경로·SHA256을 같은 방식으로 확인한다.

## 3. 실행 앱과 산출물 대조 (설치 후, 시험 시작 전)
- [ ] 실행 중인 앱의 실행 파일 경로를 확인한다(맥 `ps -p <PID> -o comm`, 윈도우 프로세스 경로).
- [ ] 설치된 `app.asar`의 **buildCommit**(`out/main/index.js`의 buildCommit)이 이번 재빌드 커밋과 같다.
- [ ] 설치된 `app.asar` SHA256이 산출물 안의 `app.asar` SHA256과 같다.
- [ ] 동봉 `resources/skill/SKILL.md` SHA256이 산출물 동봉본과 같고, 앱 overlay 표시 `knuaf-dev:app:start`가 들어 있다.
- [ ] 위 값들을 결과서(RESULT-*) 맨 위에 적는다. 하나라도 다르면 시험하지 말고 멈춰 책임자에게 보고한다.

## 4. 시험 프로젝트
- [ ] 새 시험 프로젝트의 `.agents/skills/knuaf-dev/SKILL.md`에 overlay가 있고 동봉본과 같은지 확인한다.
- [ ] 기존(옛 판으로 만든) 프로젝트를 열 때 스킬이 최신으로 갱신되는지 확인한다(백업 보존 포함).

## 5. 채널 PR (앱·스킬 공통)
- [ ] 채널 PR을 **merge commit**으로 머지했다(squash/rebase 금지). 원래 갈래 커밋이 `main`에 포함되어야 다음 채널 실행이 막히지 않는다.
- [ ] 머지 직후 남은 원격 갈래를 태그로 보관하고 지웠다. 갈래 머리의 **전체 SHA**(`<FULL>`, 원격에서 조회한 값)를 태그 대상으로 고정했다. 로컬 `origin/<branch>` 추적 참조는 옛 제안을 가리킬 수 있으므로 쓰지 않는다. 태그 이름에는 짧은 SHA(`<sha7>`)를 넣어 같은 채널을 다시 정리해도 충돌하지 않게 하고, **가벼운 태그**(annotated 금지)여야 `ls-remote`가 그 커밋의 SHA를 그대로 보여 준다. 원격 태그가 같은 전체 SHA를 가리키는 것을 확인한 뒤에만 갈래를 지운다.
  ```bash
  git fetch origin <FULL> \
    && test "$(git rev-parse FETCH_HEAD)" = <FULL> \
    && git tag archive/<branch>-<sha7> <FULL> \
    && git push origin refs/tags/archive/<branch>-<sha7> \
    && test "$(git ls-remote origin refs/tags/archive/<branch>-<sha7> | cut -f1)" = <FULL> \
    && git push origin --delete <branch>
  ```
  `--force`·`--force-with-lease`는 쓰지 않는다. 같은 이름 태그가 다른 커밋을 가리키면 push가 거부되므로 멈추고 사람이 확인한다. `<branch>`는 `app-channel-v<V>` 또는 `skill-channel-update`. 기존 관례 `archive/app-channel-v0.6.0`·`archive/app-channel-v0.6.2`는 SHA 접미가 없던 옛 이름이고, 새 이름은 항상 `-<sha7>`가 붙는다.
- [ ] 채널 PR을 **머지하지 않고 닫았으면** 같은 절차로 갈래를 보관·삭제한다. 닫힌 갈래를 남기면 다음 정기 실행이 "미머지 채널 제안"으로 실패한다.
- [ ] `skill-release` 실행이 초록이면 실행 요약에 채널 경고가 없는지 확인한다. 초록 + 경고는 "게시할 새 판이 없다"는 뜻이고, 밀린 채널 정리는 여전히 남아 있다.
- [ ] `skill-release`가 `publish` 잡에서 오래 대기하면 `skill-release` 환경 승인 화면을 확인한다. 승인 전에는 릴리스·갈래가 만들어지지 않는다.
- [ ] `publish` 로그에 "채널 PR 자동 생성 실패"가 있으면 실행 요약부터 읽는다. `skill-channel-update`는 재사용되는 갈래라 이름만으로 이번 판이 push됐다고 보면 안 된다. 요약은 원격 갈래의 `updates/channel.json`·`app/skill-source.json` blob SHA를 이번 제안과 비교해 알려 준다: (a) 같으면 릴리스·갈래는 이번 판으로 끝났고 PR만 없으므로 `gh pr create --head skill-channel-update --base main`을 사람이 실행한다. (b) 다르면 이전 제안이 남은 것이므로 갈래에 이번 판이 반영됐는지 먼저 확인하고, 아니면 옛 갈래를 보관·삭제한 뒤 릴리스 자산을 확인하고 새 실행으로 다시 시도한다. (c) 조회 실패(403·503·통신 오류)면 존재·부재를 단정하지 말고 저장소 상태를 직접 확인하며, 갈래 부재가 확인된 경우에만 릴리스만 공개된 것으로 보고 새 실행으로 다시 시도한다(같은 판 재사용 금지).
- [ ] `updates/channel.json`은 앱·스킬이 한 파일을 공유하므로 쪼개지 않는다. 이미 배포된 앱 0.6.1·0.6.2가 이 경로만 읽기 때문이다. 두 채널 PR을 동시에 열지 않는다.
