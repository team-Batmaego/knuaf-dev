/**
 * 실행 하나가 쓸 임시 폴더 뿌리 — 시험이 끝나면 이 뿌리만 지운다.
 *
 * e2e 는 `mkdtempSync(join(tmpdir(), 'kd-…'))` 로 폴더를 수백 개 만든다(프로젝트·userData·
 * 가짜 CLI·가짜 런타임·.venv 씨앗). 스펙마다 지우기를 빠뜨리면 `$TMPDIR` 에 그대로 쌓여
 * 60GB 까지 갔다. 스펙 44개에 teardown 을 다는 대신, **config 가 실행 시작에 뿌리 하나를
 * 만들고 `TMPDIR` 을 그 안으로 돌린 뒤 종료에 뿌리를 지운다** — 스펙·픽스처·앱·자식
 * 프로세스가 만드는 모든 임시 폴더가 같은 뿌리 아래로 들어오므로 누락이 구조적으로 불가능하다.
 *
 * `globalTeardown` 은 시험이 실패해도 돈다(실측: 1 failed 실행에서도 뿌리 삭제). 실패 증거
 * (`test-results/` 의 trace·스크린샷)는 저장소 안에 따로 남으므로 지워지지 않는다.
 * `process.once('exit')` 는 teardown 을 못 거치는 정상 종료를 덮고, SIGTERM·SIGHUP 훅은
 * `pkill`·`timeout`·터미널 닫기로 끊긴 실행을 덮는다(실측: 훅 없으면 971MB 잔여). 워커도
 * config 를 다시 읽지만 `KNUAF_E2E_TMP_OWNER`(pid) 가 달라 지우지 않는다 — 먼저 끝나는 워커가
 * 남의 뿌리를 지우는 일이 없다.
 *
 * 남은 폴더를 눈으로 봐야 할 때는 `KNUAF_E2E_KEEP_TMP=1` 로 지우기를 끈다.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const ROOT = 'KNUAF_E2E_TMP_ROOT'
const BASE = 'KNUAF_E2E_TMP_BASE'
const OWNER = 'KNUAF_E2E_TMP_OWNER'
const PREFIX = 'kd-run-'

/** config 로드 때 한 번 — 이 실행의 임시 폴더 뿌리를 만들고 `tmpdir()` 을 그 안으로 돌린다. */
export function isolateTmpdir(): string {
  const inherited = process.env[ROOT]
  if (inherited && existsSync(inherited) && basename(inherited).startsWith(PREFIX)) {
    process.env[BASE] ??= realpathSync(dirname(inherited))
    return inherited
  }
  // 맥의 `$TMPDIR` 은 `/var` ↔ `/private/var` 심볼릭 링크를 오간다 — 만든 자리와 지울 자리를
  // 같은 표현으로 맞춰 두려고 실제 경로로 고정한다.
  const base = realpathSync(tmpdir())
  const root = mkdtempSync(join(base, PREFIX))
  process.env[ROOT] = root
  process.env[BASE] = base
  process.env[OWNER] = String(process.pid)
  // `os.tmpdir()` 는 호출할 때마다 `TMPDIR`(윈도는 `TEMP`·`TMP`)을 읽는다 — 여기서 돌려 두면
  // 스펙·픽스처가 만드는 폴더와 Electron 자식이 쓰는 임시 폴더가 모두 뿌리 아래로 들어온다.
  process.env.TMPDIR = root
  process.env.TMP = root
  process.env.TEMP = root
  // `pkill`·`timeout`·터미널 창 닫기(SIGHUP)는 Playwright 에 핸들러가 없어 곧바로 죽는다 —
  // `exit` 훅이 안 돌아 뿌리가 남는다(실측: SIGTERM 잔여 971MB). **뿌리를 만든 프로세스에서만**
  // 잡는다 — 워커는 Playwright 가 심은 SIGTERM 무시를 그대로 두어야 정상 종료 절차를 안 깬다.
  // SIGINT 는 Playwright 가 스스로 정리 경로를 돌리므로(`1 interrupted` → teardown 실행) 두 손 뗀다.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => { cleanupTmpdir(); process.exit(code) })
  }
  return root
}

/** 이 실행이 만든 뿌리만 지운다. 워커·남의 실행·tmpdir 밖 경로는 건드리지 않는다. */
export function cleanupTmpdir(): void {
  const root = process.env[ROOT]
  if (!root || process.env[OWNER] !== String(process.pid)) return
  delete process.env[ROOT]
  // 지우기 전에 **만든 자리**를 확인한다 — 이름 규칙만 믿으면 그 사이 `TMPDIR` 이 바뀐 실행에서
  // 엉뚱한 경로를 지울 수 있다.
  if (!basename(root).startsWith(PREFIX) || dirname(root) !== process.env[BASE]) return
  if (process.env.KNUAF_E2E_KEEP_TMP === '1') { console.log(`[e2e] 임시 폴더 유지: ${root}`); return }
  try {
    // 앱이 아직 파일을 잡고 있으면(윈도) 바로 실패한다 — 몇 번 다시 시도하고, 그래도 안 되면
    // 시험 결과를 깨뜨리지 않고 남긴다. 다음 실행은 다른 이름의 뿌리를 쓴다.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    console.warn(`[e2e] 임시 폴더를 지우지 못했습니다: ${root}: ${(error as Error).message}`)
  }
}

export default function globalTeardown(): void { cleanupTmpdir() }
