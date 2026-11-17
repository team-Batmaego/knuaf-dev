/**
 * 가짜 app-server 를 `binary` 자리에 넣기 위한 얇은 실행 래퍼.
 *
 * `serverArgsFor` 가 붙이는 `app-server` 인자를 argv 로 넘겨야 하므로 스크립트를 그대로 띄울 수
 * 없고, Node 스크립트 경로를 `binary` 로 줄 수도 없다(연결은 `binary` 뒤에 인자를 붙인다).
 *
 * **윈도우는 셸 스크립트를 실행하지 못한다**(`spawn` 이 ENOENT). 그래서 `.cmd` 로 내고
 * `transport.ts` 의 `winSpawn` 이 cmd.exe 로 감싼다. 맥·리눅스는 종전대로 `#!/bin/sh` 다.
 * 이 분기가 없으면 담당 스펙 전체가 `app (windows-latest)` 에서 깨진다.
 *
 * `platform` 은 시험 주입용이다 — 윈도우 러너 없이도 윈도우 분기를 실제로 검사한다
 * (`winSpawn`·`findExecutable` 과 같은 방식).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function codexRelayLauncher(
  root: string, script: string, platform: NodeJS.Platform = process.platform, execPath: string = process.execPath
): string {
  if (platform === 'win32') {
    const wrapper = join(root, 'codex-wrapper.cmd')
    writeFileSync(wrapper, `@echo off\r\n"${execPath}" "${script}" %*\r\n`, 'utf-8')
    return wrapper
  }
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return wrapper
}
