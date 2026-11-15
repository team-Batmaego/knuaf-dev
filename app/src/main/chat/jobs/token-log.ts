import { constants, mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 한 턴의 토큰 사용량을 논문 폴더의 `.knuaf-gui/token-usage-<provider>.jsonl` 에 한 줄 덧붙인다.
 * 대화별로 나중에 합산하기 쉽게 JSONL 로 두고, 학생 글은 담지 않는다(숫자·식별자만).
 *
 * **대화를 막지 않는다.** 검토 CT-01: 동기 append 는 예외만 삼킬 뿐, 쓰기가 대기하면(FIFO·
 * 느린 파일시스템·동기화 폴더) 대화 처리까지 멈춘다. 그래서
 *  - I/O 는 전부 비동기로 미루고 호출은 즉시 돌아간다(호출자는 기다리지 않는다).
 *  - 대기 줄이 `MAX_PENDING` 을 넘으면 그 턴의 기록을 **버린다** — 느린 기록이 대화를 밀지 않는다.
 *  - 일반 파일이 아닌 대상(FIFO·장치·디렉터리)은 열지 않는다. POSIX 에서는 `O_NONBLOCK` 으로
 *    열어 읽는 쪽이 없어도 open 이 멈추지 않게 한다.
 *  - 모든 실패는 삼킨다. 기록은 부가 정보이고 대화가 우선이다.
 *
 * **순번**(검토 CT-03): 연결 객체가 아니라 로그 파일이 기준이다. 이 프로세스에서 그 대화를
 * 처음 기록할 때 기존 파일에서 마지막 `requestSequence` 를 찾아 이어받는다 — 연결을 다시 만들고
 * 같은 대화를 이어 가도 `[1, 2]` 이고 첫 요청 표시가 두 번 true 가 되지 않는다.
 */

/** 한 번에 밀어 넣을 수 있는 기록 수. 넘치면 그 턴 기록을 버린다(대화 우선). */
const MAX_PENDING = 32
/**
 * 한 줄을 기다려 주는 시간. 넘기면 그 기록을 버리고 다음 줄로 넘어간다 — 느린 저장 장치에서
 * 줄이 영영 막혀 이후 기록이 전부 사라지는 것을 막는다. 늦게 도착한 줄이 한 칸 뒤로 갈 수
 * 있지만, 각 줄에 대화·순번이 들어 있어 순서는 기록 자체로 복원된다.
 */
const WRITE_DEADLINE_MS = 5000
/** FIFO·파이프에 읽는 쪽이 없을 때 open 이 멈추지 않게 한다. 윈도우는 의미가 없어 0. */
const NONBLOCK = process.platform === 'win32' ? 0 : constants.O_NONBLOCK

export interface TokenSequence {
  requestSequence: number
  notificationSequence: number
}

export interface TokenEntry {
  /** 대화 식별자 — 순번을 이어받는 단위다. */
  conversationId: string
  /** 같은 요청에 딸린 알림을 묶는 키(Codex 의 turnId). Claude 는 결과마다 새 키. */
  turnKey: string
  /** 순번이 정해진 뒤 기록 한 줄을 만든다. `null` 이면 쓰지 않는다. */
  build: (sequence: TokenSequence) => object | null
}

interface ConversationState {
  request: number
  turnKey: string
  notifications: number
}

/** `<파일>\0<대화>` 별 순번. 프로세스가 살아 있는 동안만 유지된다(재시작은 파일에서 이어받는다). */
const states = new Map<string, ConversationState>()
/** 기록 I/O 를 한 줄로 세운다 — 같은 파일에 동시에 쓰지 않는다. */
let chain: Promise<void> = Promise.resolve()
let pending = 0

/** 밀린 기록이 끝날 때까지 기다린다(시험·종료 직전의 결정성 확보용). 실패는 이미 삼켜졌다. */
export function flushTokenRecords(): Promise<void> {
  return chain
}

export function appendTokenRecord(root: string, provider: 'claude' | 'codex', entry: TokenEntry): void {
  if (!root) return
  // 느린 기록이 쌓여 대화를 밀지 않도록, 줄이 차면 이번 기록은 버린다.
  if (pending >= MAX_PENDING) return
  pending += 1
  const file = join(root, '.knuaf-gui', `token-usage-${provider}.jsonl`)
  chain = chain
    .then(() => append(file, entry))
    .catch(() => { /* 기록 실패는 대화를 막지 않는다 */ })
    .finally(() => { pending -= 1 })
}

async function append(file: string, entry: TokenEntry): Promise<void> {
  // 순번은 먼저 잡고 쓴다 — 느리게 도착한 줄도 자기 순번을 들고 간다.
  const state = await stateFor(file, entry.conversationId)
  const record = entry.build(nextSequence(state, entry.turnKey))
  if (!record) return
  const deadline = Promise.withResolvers<void>()
  const timer = setTimeout(() => deadline.resolve(), WRITE_DEADLINE_MS)
  try {
    await Promise.race([write(file, record), deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

async function write(file: string, record: object): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const handle = await openForAppend(file)
  if (!handle) return
  try { await handle.write(`${JSON.stringify(record)}\n`, null, 'utf8') } finally { await handle.close() }
}

/**
 * 덧붙이기용 핸들. 일반 파일이 아니면 `null` — FIFO 에 쓰기를 열면 읽는 쪽이 올 때까지
 * 멈추고, 그 멈춤이 (비동기라도) 기록 줄 전체를 잡아 둔다.
 */
async function openForAppend(file: string): Promise<FileHandle | null> {
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NONBLOCK, 0o644)
  } catch {
    return null
  }
  try {
    if (!(await handle.stat()).isFile()) { await handle.close(); return null }
  } catch {
    await handle.close()
    return null
  }
  return handle
}

/** 이 대화의 순번 상태. 프로세스에서 처음이면 기존 로그에서 마지막 요청 순번을 이어받는다. */
async function stateFor(file: string, conversationId: string): Promise<ConversationState> {
  const key = `${file}\0${conversationId}`
  const hit = states.get(key)
  if (hit) return hit
  const state: ConversationState = { request: await lastRequestSequence(file, conversationId), turnKey: '', notifications: 0 }
  states.set(key, state)
  return state
}

/**
 * 기존 로그에서 그 대화의 마지막 `requestSequence`. 파일이 없거나 읽을 수 없으면 0(새 대화).
 * 일반 파일만 읽는다 — FIFO 를 읽으면 쓰는 쪽을 기다린다.
 */
async function lastRequestSequence(file: string, conversationId: string): Promise<number> {
  let handle: FileHandle
  try { handle = await open(file, constants.O_RDONLY | NONBLOCK) } catch { return 0 }
  try {
    if (!(await handle.stat()).isFile()) return 0
    const text = await handle.readFile('utf8')
    let last = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      let record: { conversationId?: unknown; requestSequence?: unknown }
      try { record = JSON.parse(line) } catch { continue }
      if (record?.conversationId !== conversationId) continue
      const n = record.requestSequence
      if (typeof n === 'number' && Number.isInteger(n) && n > last) last = n
    }
    return last
  } catch {
    return 0
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 같은 턴 키의 알림이면 알림 순번만 올리고, 새 턴이면 요청 순번을 올린다. */
function nextSequence(state: ConversationState, turnKey: string): TokenSequence {
  if (state.request === 0 || state.turnKey !== turnKey) {
    state.request += 1
    state.turnKey = turnKey
    state.notifications = 1
  } else {
    state.notifications += 1
  }
  return { requestSequence: state.request, notificationSequence: state.notifications }
}
