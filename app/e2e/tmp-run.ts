/**
 * 실행 하나가 쓸 임시 폴더 뿌리 — 시험이 끝나면 이 실행이 만든 뿌리만 지운다.
 *
 * e2e 는 `mkdtempSync(join(tmpdir(), 'kd-…'))` 로 폴더를 수백 개 만든다(프로젝트·userData·
 * 가짜 CLI·가짜 런타임·.venv 씨앗). 스펙마다 지우기를 빠뜨리면 `$TMPDIR` 에 그대로 쌓여
 * 60GB 까지 갔다. 스펙 44개에 teardown 을 다는 대신, **config 가 실행 시작에 뿌리 하나를
 * 만들고 `TMPDIR` 을 그 안으로 돌린 뒤 종료에 뿌리를 지운다** — 스펙·픽스처·앱·자식
 * 프로세스가 만드는 모든 임시 폴더가 같은 뿌리 아래로 들어오므로 누락이 구조적으로 불가능하다.
 *
 * 지우는 권한은 **이 프로세스가 `mkdtempSync` 로 직접 만든 경로**에만 있다(`state().owned`). 환경변수는
 * 워커에게 "어느 뿌리를 쓰라"고 알려 주는 힌트일 뿐이고, 삭제 대상은 절대 env 로 정하지 않는다.
 * 래퍼가 `KNUAF_E2E_TMP_ROOT` 를 사용자 폴더로 세워 두고 실행해도 이 프로세스는 자기 뿌리를
 * 새로 만들 뿐 그 폴더를 건드리지 않는다. 물려받은 경로에는 삭제 권한이 없어 워커가 config 를
 * 다시 읽어도 부모의 뿌리를 지우지 않는다.
 *
 * 워커 판별은 env 가 아니라 프로세스 사실로 한다: 러너가 `fork` 한 워커는 IPC 채널을 들고
 * 태어나고 진입 스크립트가 Playwright 의 worker entry 다. 독립 실행은 env 를 통째로 물려받아도
 * 채널이 없으므로 항상 자기 뿌리를 만든다. 그래서 워커가 띄운 별도 실행이 부모 뿌리를 함께
 * 쓰다가 부모 종료에 같이 지워지는 일이 없다.
 *
 * `globalTeardown` 은 시험이 실패해도 돈다(실측: 1 failed 실행에서도 뿌리 삭제). 실패 증거
 * (`test-results/` 의 trace·스크린샷)는 저장소 안에 따로 남으므로 지워지지 않는다.
 * `process.once('exit')` 는 teardown 을 못 거치는 정상 종료를 덮고, SIGTERM·SIGHUP 훅은
 * `pkill`·`timeout`·터미널 닫기로 끊긴 실행을 덮는다(실측: 훅 없으면 971MB 잔여). 신호를 받으면
 * 워커와 증거 기록이 끝나기를 기다리지 않고 곧바로 끝내므로, **중단된 실행의 증거 완성은
 * 보장하지 않는다** — 이미 저장된 `test-results` 만 지우지 않는다.
 *
 * 남은 폴더를 눈으로 봐야 할 때는 `KNUAF_E2E_KEEP_TMP=1` 로 지우기를 끈다.
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = 'KNUAF_E2E_TMP_ROOT'
const RUN = 'KNUAF_E2E_TMP_RUN'
const PREFIX = 'kd-run-'
const TMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

interface Saved { key: string; value: string | undefined }
interface Owned { root: string; base: string; saved: Saved[] }

/**
 * 이 프로세스가 `mkdtempSync` 로 **직접 만든** 뿌리만 담는다. config 와 `globalTeardown` 이
 * 같은 파일을 서로 다른 인스턴스로 읽어도 한 상태를 보도록 전역 심볼에 둔다 — 그래도 이
 * 프로세스 밖에서는 보이지 않으므로 env 로 위조할 수는 없다.
 */
const STATE = Symbol.for('knuaf.e2e.tmp-run.owned')
type State = { owned: Owned | null }
function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>
  return holder[STATE] ??= { owned: null }
}

function isWorkerProcess(): boolean {
  // 워커만 러너와의 IPC 채널을 들고 태어난다. `fork` 로 띄운 독립 실행까지 워커로 오인하지
  // 않도록 진입 스크립트도 확인한다 — Playwright 가 경로를 바꾸면 워커가 자기 뿌리를 따로
  // 만들 뿐(안전한 저하) 남의 뿌리를 지우지는 않는다.
  return typeof process.channel !== 'undefined' && /worker[\\/]workerProcessEntry\.js$/.test(process.argv[1] ?? '')
}

/** 워커가 부모 실행의 뿌리를 이어받을 수 있는지 — 실행 ID 와 뿌리 이름이 한 쌍으로 맞아야 한다. */
function inheritedRoot(): string | null {
  if (!isWorkerProcess()) return null
  const root = process.env[ROOT]
  if (!root || !basename(root).startsWith(PREFIX)) return null
  if (process.env[RUN] !== basename(root) || !existsSync(root)) return null
  return realpathSync(root)
}

/**
 * 새 뿌리를 만들 자리 — 조상 실행의 뿌리 안에 만들면 그 실행이 끝날 때 함께 지워진다.
 * `TMPDIR` 이 조상 뿌리 안을 가리키면 그 바깥으로 나가고, 사라진 뿌리를 가리켜도(중단된 실행)
 * 설정 로드가 죽지 않도록 있는 조상까지 올라간다.
 */
function baseDir(): string {
  let current = resolve(tmpdir())
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  current = realpathSync(current)
  // 조상 중 **가장 바깥** `kd-run-*` 의 부모로 나간다 — `TMPDIR` 이 그 뿌리 안 깊은 곳을
  // 가리켜도(중첩 실행) 새 뿌리가 조상 뿌리 안에 들어가지 않는다.
  let base = current
  for (let probe = current; ; probe = dirname(probe)) {
    if (basename(probe).startsWith(PREFIX)) base = dirname(probe)
    if (dirname(probe) === probe) return base
  }
}

/** config 로드 때 한 번 — 이 실행의 임시 폴더 뿌리를 만들고 `tmpdir()` 을 그 안으로 돌린다. */
export function isolateTmpdir(): string {
  const owned = state().owned
  if (owned) return owned.root
  const inherited = inheritedRoot()
  if (inherited) return inherited
  // 맥의 `$TMPDIR` 은 `/var` ↔ `/private/var` 심볼릭 링크를 오간다 — 만든 자리와 지울 자리를
  // 같은 표현으로 맞춰 두려고 실제 경로로 고정한다.
  const base = baseDir()
  const root = mkdtempSync(join(base, PREFIX))
  state().owned = { root, base, saved: TMP_KEYS.map(key => ({ key, value: process.env[key] })) }
  // env 는 워커·자식에게 뿌리를 알려 주는 힌트다. 삭제 판단은 오직 위의 프로세스 안 상태가 한다.
  process.env[ROOT] = root
  process.env[RUN] = basename(root)
  // `os.tmpdir()` 는 호출할 때마다 `TMPDIR`(윈도는 `TEMP`·`TMP`)을 읽는다 — 여기서 돌려 두면
  // 스펙·픽스처가 만드는 폴더와 Electron 자식이 쓰는 임시 폴더가 모두 뿌리 아래로 들어온다.
  for (const key of TMP_KEYS) process.env[key] = root
  // `pkill`·`timeout`·터미널 창 닫기(SIGHUP)는 Playwright 에 핸들러가 없어 곧바로 죽는다 —
  // `exit` 훅이 안 돌아 뿌리가 남는다(실측: SIGTERM 잔여 971MB). **뿌리를 만든 프로세스에서만**
  // 잡는다 — 워커는 Playwright 가 심은 SIGTERM 무시를 그대로 두어야 정상 종료 절차를 안 깬다.
  // SIGINT 는 Playwright 가 스스로 정리 경로를 돌리므로(`1 interrupted` → teardown 실행) 두 손 뗀다.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => { cleanupTmpdir(); process.exit(code) })
  }
  return root
}

/**
 * 지우기 전에 읽기 전용 잠금을 푼다.
 *
 * 앱 스킬 자리(`<userData>/skill-host/…`)는 설치 뒤 파일 `0444`·폴더 `0555` 로 잠긴다(설계 §4.2).
 * 그 폴더 안의 것을 지우려면 **폴더**에 쓰기 권한이 필요하므로 `rmSync` 는 `ENOTEMPTY` 로 실패한다
 * (`force`·`maxRetries` 로는 안 풀린다 — 재시도는 실패한 호출을 되풀이할 뿐이다).
 * 이 파일은 `--experimental-strip-types` 로 자식 프로세스가 직접 import 하므로 `../src/main/agent`
 * 를 끌어오지 않는다(확장자 없는 import 는 그 모드에서 해석되지 않는다) — 같은 규칙을 여기 둔다.
 * 링크는 따라가지 않는다: 링크 대상은 이 실행이 만든 것이 아니다.
 */
function unlockTree(target: string): void {
  let st
  try { st = lstatSync(target) } catch { return }
  if (st.isSymbolicLink()) return
  try { chmodSync(target, st.isDirectory() ? 0o755 : 0o644) } catch { /* 이미 쓰기 가능하거나 지원하지 않는다 */ }
  if (!st.isDirectory()) return
  let names: string[]
  try { names = readdirSync(target) } catch { return }
  for (const name of names) unlockTree(join(target, name))
}

/** 이 프로세스가 만든 뿌리만 지운다. 워커·남의 실행·물려받은 경로는 건드리지 않는다. */
export function cleanupTmpdir(): void {
  const owned = state().owned
  if (!owned) return
  // 지우기 전에 **만든 자리**를 확인한다 — 이름 규칙만 믿으면 그 사이 `TMPDIR` 이 바뀐 실행에서
  // 엉뚱한 경로를 지울 수 있다.
  if (!basename(owned.root).startsWith(PREFIX) || dirname(owned.root) !== owned.base) { finish(owned); return }
  if (process.env.KNUAF_E2E_KEEP_TMP === '1') { console.log(`[e2e] 임시 폴더 유지: ${owned.root}`); finish(owned); return }
  try {
    // 앱이 아직 파일을 잡고 있으면(윈도) 바로 실패한다 — 몇 번 다시 시도하고, 그래도 안 되면
    // 시험 결과를 깨뜨리지 않고 남긴다. 소유 상태를 버리지 않으므로 종료 훅이 한 번 더 시도한다.
    // 앱 스킬 자리는 읽기 전용으로 잠긴 채 남으므로 먼저 연다 — 부모가 안 써지면 `EACCES` 로
    // 실패하고, 그때만 상태를 남겨 재시도한다.
    unlockTree(owned.root)
    rmSync(owned.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    console.warn(`[e2e] 임시 폴더를 지우지 못했습니다(종료 때 다시 시도): ${owned.root}: ${(error as Error).message}`)
    return
  }
  finish(owned)
}

/** 실제로 지웠거나(또는 유지 옵션으로 남기기로 했을 때)만 부른다 — 실패면 상태를 남겨 재시도한다. */
function finish(owned: Owned): void {
  if (state().owned !== owned) return
  state().owned = null
  // 세 변수는 이 실행 전 값으로 되돌린다 — 원래 없던 것은 지운다. `os.tmpdir()` 가 지운 뿌리를
  // 계속 가리키면 teardown 뒤 같은 프로세스가 만드는 임시 폴더가 ENOENT 로 깨진다.
  for (const { key, value } of owned.saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env[ROOT]
  delete process.env[RUN]
}

export default function globalTeardown(): void { cleanupTmpdir() }
