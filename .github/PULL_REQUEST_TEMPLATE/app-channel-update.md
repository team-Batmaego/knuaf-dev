## 서명된 앱 채널 변경

`app-channel-v<V>` 갈래의 제안입니다. 이 PR은 사람이 열며, 자동 머지하지 않습니다.

- [ ] 대상 릴리스가 공개 저장소의 기존 태그·자산이며, 태그 커밋과 앱 버전이 일치합니다.
- [ ] `updates/channel.json`에서 `app` 항목만 바뀌었고, `skill` 항목은 base와 같습니다.
- [ ] 기존 출시 승인 4조건과 독립검토를 완료했습니다.
- [ ] 아래 버전별 순서를 지키고 `check-app-channel.mjs` 실행의 전체 결과를 이 PR에 첨부했습니다.
- [ ] 채널 PR은 merge commit으로 머지합니다(squash/rebase 금지). 갈래 커밋이 main에 포함되어야 다음 앱·스킬 채널 실행이 가능합니다.
- [ ] 머지 또는 닫은 뒤 원격 갈래를 보관·삭제합니다. 갈래 머리의 **전체 SHA**(`<FULL>`, 원격에서 조회한 값)를 태그 대상으로 고정하고, 로컬 `origin/<branch>` 추적 참조는 옛 제안을 가리킬 수 있으므로 쓰지 않습니다. 태그 이름의 짧은 SHA(`<sha7>`)는 같은 채널을 다시 정리해도 충돌하지 않게 하는 용도이고, **가벼운 태그**(annotated 금지)여야 `ls-remote`가 그 커밋의 SHA를 그대로 보여 줍니다. 원격 태그가 같은 전체 SHA를 가리키는 것을 확인한 뒤에만 갈래를 지웁니다: `git fetch origin <FULL> && test "$(git rev-parse FETCH_HEAD)" = <FULL> && git tag archive/<branch>-<sha7> <FULL> && git push origin refs/tags/archive/<branch>-<sha7> && test "$(git ls-remote origin refs/tags/archive/<branch>-<sha7> | cut -f1)" = <FULL> && git push origin --delete <branch>`. `--force`·`--force-with-lease`는 쓰지 않습니다. 같은 이름 태그가 이미 다른 커밋을 가리키면 push가 거부되므로 멈추고 사람이 확인합니다. <branch>는 `app-channel-v<V>` 또는 `skill-channel-update`입니다.

### v0.6.0

- [ ] 채널 PR을 릴리스 공개 전에 머지했습니다.
- [ ] 릴리스 공개 직후 `node app/scripts/check-app-channel.mjs --channel updates/channel.json`을 실행했습니다.
- [ ] 실행 결과를 첨부했습니다. 불일치하면 즉시 채널 변경을 되돌렸습니다.

### v0.6.1 이후

- [ ] 릴리스를 먼저 공개했습니다.
- [ ] 이 PR의 제안 `updates/channel.json`으로 `node app/scripts/check-app-channel.mjs --channel updates/channel.json`을 실행했습니다.
- [ ] 공개 자산의 크기·SHA-256 대조 결과를 첨부한 뒤에만 머지합니다.
