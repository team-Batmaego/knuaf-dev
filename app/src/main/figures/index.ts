/**
 * figures/index.ts — 그림 통로의 **유일한 진입점** (발주 ③: 인자로 다 받는 함수 하나)
 *
 * ```ts
 * const channel = startFigureChannel({
 *   figureHome,                 // <userData>/figures
 *   getFolder,                  // 지금 열린 논문 폴더 realpath | null
 *   resolveSkillSource,         // update/store.ts:83
 * })
 * await channel.beginTurn(folder, turnId)            // 메인 턴 시작 지점
 * await channel.recordStudentMessage(folder, text)   // 학생 메시지 원문
 * await channel.endTurn(turnId)                      // 턴 끝·중단(소유 턴만 닫는다)
 * await channel.stop()                               // 앱 종료
 * ```
 *
 * 이 모듈은 엔진·화면과 **연결하지 않는다**(발주: 배선은 다음 PR). 앱이 호출만 하면 되는 모양까지가
 * 이번 범위다. 그래서 폴더·턴·스킬 판은 전부 밖에서 들어온다 — 이 모듈이 앱 상태를 직접 읽지 않는다.
 *
 * 폴더가 바뀌면 감시자를 새로 만든다. 이전 폴더에 남은 요청은 새 폴더 기준 턴 검사에서 `stale`이 되고,
 * 그 결과가 이전 폴더가 아니라 **지금 폴더**의 res 칸에 남는다(계약: res는 앱 저장소, 폴더 무관).
 */

import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { FigureRes } from './contract'
import { readRequestFile } from './request-file'
import { beginTurn as writeTurn, endTurn as clearTurn } from './turn'
import { loadRules } from './rules'
import { processRequest, type FetchFn, type TurnGate, type WriteSeam } from './process'
import type { ImageDecoder } from './reencode-window'
import { figurePaths, folderHash, prepareHome, writeJsonNew } from './storage'
import { recordStudentMessage as fillChoiceSheets } from './choices'
import { runWatcher, type FoundRequest, type Runner } from './watcher'
import { startHeartbeat } from './heartbeat'

export interface FigureChannelOptions {
  /** `<userData>/figures` — 앱만 쓰는 저장소. */
  figureHome: string
  /** 지금 연 논문 폴더 realpath. null이면 요청을 집지 않는다. */
  getFolder: () => string | null
  /** 검증된 활성 판(또는 앱 동봉판) 루트. null·실패는 "규칙 없음"이다. */
  resolveSkillSource: () => string | null
  /** 디코더·받기 대역(시험). 기본은 Electron 숨김 창 · node:https. */
  decode?: ImageDecoder
  fetchFn?: FetchFn
  /** 저장 쓰기 대역(시험). 기본은 `storage` 구현. 첫 쓰기를 멈춰 `endTurn` 경계를 본다(R-6). */
  write?: WriteSeam
  /**
   * 턴 파일 지우기 대역(시험). 기본은 `turn.endTurn`. 지우기를 멈춰 두면 감시자는 아직 턴이 살아
   * 있다고 보고 요청을 집는다 — 그 요청이 `endTurn()`이 돌아온 뒤 산출물을 만드는지 본다(R-6 남은 경로).
   */
  clearTurn?: (path: string) => Promise<void>
  now?: () => number
  scanMs?: number
  ttlMs?: number
}

export interface FigureChannel {
  beginTurn(folder: string, turnId: string): Promise<void>
  /**
   * 턴 하나를 닫는다. **`turnId` 가 지금 소유자일 때만** 지운다 — 통로는 하나인데 턴은 폴더·공급자마다
   * 있으므로, 다른 폴더의 옛 턴이 늦게 끝나면서 지금 도는 턴의 `turn.json` 을 지우면 그 턴의 정상
   * 요청이 전부 `stale` 이 된다(I-01).
   */
  endTurn(turnId: string): Promise<void>
  /** 학생 메시지 원문을 그 폴더의 빈 후보표 전부에 붙인다. 갱신한 표 수. */
  recordStudentMessage(folder: string, text: string): Promise<number>
  /** 앱 종료 — 타이머를 멈추고 지금 도는 요청은 끝까지 둔다. */
  stop(): Promise<void>
  /** 지금 도는 요청이 끝나기를 기다린다(시험용). */
  idle(): Promise<void>
}

export function startFigureChannel(options: FigureChannelOptions): FigureChannel {
  const paths = figurePaths(options.figureHome)
  const now = options.now ?? Date.now
  let runner: Runner | null = null
  let runnerFolder: string | null = null
  let stopped = false
  let folderTimer: NodeJS.Timeout | undefined
  const heartbeat = startHeartbeat(paths.channel, { now })
  /**
   * 통로가 꺼졌다(I-03). 저장소 준비나 **첫 하트비트**가 실패하면 그림 통로 전체를 끈다. 생존 신호를
   * 남기지 못하는 통로는 도우미가 15초 뒤 "낡음"으로 읽으므로, 감시자·턴 고리만 살려 두면 결과를 받을
   * 곳 없는 요청이 `cancelled` 로 닫히고 `turn.json` 만 남는다. 실패는 조용하다(그림만 꺼지고 대화는 그대로).
   */
  let failed = false
  const failChannel = (): void => {
    if (failed) return
    failed = true
    runner?.stop()
    runner = null
    runnerFolder = null
    if (folderTimer) {
      clearInterval(folderTimer)
      folderTimer = undefined
    }
    void heartbeat.stop()
  }

  /**
   * 통로를 쓸 수 있으려면 저장소 준비 **그리고** 첫 생존 신호가 필요하다(I-03). 첫 박자의 결과까지
   * 기다리는 이유는 순서 때문이다: 하트비트 쓰기가 실패하는 자리(`figure-channel.json` 이름이 디렉터리)에서도
   * `beginTurn` 이 먼저 지나가면 `turn.json` 이 남고 감시자가 계속 돈다 — 첫 박자를 기다리면 그 전에
   * 통로가 꺼져 아무것도 남지 않는다. `stop()` 뒤의 첫 박자도 실패로 보므로 약속이 매달리지 않는다.
   */
  const ready: Promise<void> = prepareHome(paths).then(async () => {
    const first = await heartbeat.first
    if (!first.ok) throw first.error
  })

  /**
   * 턴 파일 작업 사슬(I-01 남은 경계). 소유권 확인과 `turn.json` 쓰기·지우기를 **한 줄**로 세운다.
   * 확인만 하고 지우기를 늦추면, 확인을 통과한 옛 삭제가 그 사이 새 턴이 쓴 파일을 지운다(실측 재현:
   * B 가 상한을 넘겨 실행돼 `turn.json` 을 쓴 뒤 A 의 삭제가 그 파일을 지웠다). 사슬 안에서는 앞 작업이
   * 끝난 뒤에야 다음 작업이 시작하므로 그 틈이 없다.
   *
   * 대가: 옛 삭제가 멈추면 다음 턴의 파일 쓰기도 같이 늦어진다 — 그림만 늦고 대화는 그대로다(계약).
   */
  let turnOps: Promise<void> = Promise.resolve()
  const turnOp = <T>(run: () => Promise<T>): Promise<T> => {
    // 앞 작업이 실패해도 다음 작업은 돈다 — 한 번의 쓰기 실패로 턴 고리가 굳으면 안 된다.
    const next = turnOps.then(run, run)
    turnOps = next.then(() => undefined, () => undefined)
    return next
  }
  /**
   * 지금 통로를 쥔 턴의 id (I-01). 통로는 하나인데 턴은 폴더·공급자마다 있으므로, **소유자만**
   * `turn.json` 을 지우고 게이트를 닫는다. 소유자 확인 없이 닫으면 다른 폴더의 옛 턴이 늦게 끝나면서
   * 지금 도는 턴의 `turn.json` 을 지우고, 그 턴의 정상 요청이 전부 `stale`·`cancelled` 가 된다.
   */
  let ownerTurnId: string | null = null
  /**
   * 마지막으로 **닫힌** 턴 id. `beginTurn` 이 늦게 도착한 경우를 막는다 — 준비 상한(I-02)으로
   * `endTurn` 이 먼저 돌면, 뒤늦게 시작한 `beginTurn` 이 이미 끝난 턴의 `turn.json` 을 남겨 감시자가
   * 유령 턴의 요청을 계속 집는다. 요청 id 는 턴마다 유일하므로 마지막 하나만 기억하면 충분하다.
   */
  let lastClosedTurnId: string | null = null

  /**
   * 턴 세대값 (R-6). `endTurn()`은 세대값을 올리고 **게이트를 닫은 뒤** 진행 중인 쓰기가 끝나기를
   * 기다린다 — 그래야 `beginTurn`·`endTurn`이 돌려준 시점 이후에 그 턴의 PNG·증명·결과가 새로 생기지 않는다.
   * 쓰기 진입은 `open()` 한 번으로 확인과 등록을 같은 틱에 한다(await 사이에 세대가 바뀌는 틈을 없앤다).
   *
   * 게이트는 **닫힌 채로 시작한다**. 세대값만 올리면, 턴 파일을 지우는 사이에 집힌 요청이 새 세대값을
   * 받아 살아 있는 것으로 통과하고 `turn.json`이 아직 남아 있어 디스크 검사도 지나간다 — 그 요청이
   * `endTurn()` 뒤에 산출물을 만든다. 그래서 `endTurn`은 세대값을 올림과 같은 틱에 게이트를 닫고,
   * `beginTurn`만 연다. 닫힌 동안 `begin()`이 주는 lease는 `open()`이 항상 `null`, `live()`가 항상
   * `false`다(이미 시작한 요청도 남은 쓰기를 못 하고 `cancelled`로 닫힌다).
   */
  let generation = 0
  let closed = true
  let activeWrites = 0
  let drained: (() => void)[] = []
  const onDrained = (done: () => void): void => {
    if (activeWrites === 0) done()
    else drained.push(done)
  }
  const gate: TurnGate = {
    begin() {
      if (closed) return { live: () => false, open: () => null }
      // 이 요청의 세대값을 지금 잡는다 — 아래 첫 await 뒤에 잡으면 그 사이 `endTurn`을 놓친다.
      const gen = generation
      return {
        live: () => gen === generation,
        // 확인과 등록을 한 틱에 한다 — `await` 사이에 `endTurn`이 끼면 등록을 놓쳐 `endTurn`이 먼저 돌아간다.
        open: () => {
          if (gen !== generation) return null
          activeWrites += 1
          let released = false
          return () => {
            if (released) return
            released = true
            activeWrites -= 1
            if (activeWrites !== 0) return
            const waiting = drained
            drained = []
            for (const done of waiting) done()
          }
        }
      }
    }
  }

  /** 처리하지 못한 요청도 결과를 남긴다 — 안 남기면 도우미가 60초를 다 기다린다. */
  const closeRejected = async (id: string, reason: string): Promise<void> => {
    // 이미 결과가 있으면 **덮지 않는다** — 배타 생성이 검사와 쓰기를 한 번에 한다(I-1). 감시자의 `seen`은
    // 실행마다 새로 만들어지므로, 재시작 뒤 옛 요청 파일이 만료로 보여도 그때 남긴 `done`을 `expired`로
    // 바꾸면 학생은 결과를 잃는다.
    const res: FigureRes = { v: 1, id, status: 'rejected', reason, slot: '', needsChoice: false, images: [] }
    await writeJsonNew(join(paths.res, `${id}.res.json`), res)
  }

  const makeHandler = (folder: string) => async (item: FoundRequest): Promise<void> => {
    if (item.expired) {
      await closeRejected(item.id, 'expired')
      return
    }
    const read = await readRequestFile(item.path)
    if (!read.ok) {
      await closeRejected(item.id, read.reason === 'too_big' ? 'limit' : 'invalid')
      return
    }
    if (!read.parse.ok) {
      await closeRejected(item.id, 'invalid')
      return
    }
    // 파일 이름과 본문 id가 다르면 어느 쪽이 정본인지 알 수 없다 — 아무것도 받지 않고 닫는다(R-5).
    if (read.parse.request.id !== item.id) {
      await closeRejected(item.id, 'invalid')
      return
    }
    await processRequest({ request: read.parse.request, folder }, {
      paths,
      loadRules: () => loadRules(options.resolveSkillSource()),
      decode: options.decode,
      fetchFn: options.fetchFn,
      write: options.write,
      gate,
      now
    })
  }

  /**
   * 저장소 준비 실패는 **통로만 끈다**(I-03). 예전에는 `void ensureRunner()` 의 거절을 아무도 받지 않아
   * 비처리 거절이 되었고, 그 실패가 앱 종료로 이어질 수 있었다. 이제 실패를 여기서 받아 `failed` 로
   * 굳히고, 그 뒤의 고리는 전부 조용한 no-op 이 된다(그림만 꺼지고 대화는 그대로).
   */
  const ensureRunner = async (): Promise<void> => {
    if (failed) return
    try {
      await ready
    } catch {
      failChannel()
      return
    }
    const folder = options.getFolder()
    // 폴더가 없거나 그대로면 할 일이 없다(감시자는 자기 폴더만 본다).
    if (folder === runnerFolder) return
    runner?.stop()
    runner = null
    runnerFolder = folder
    if (!folder || stopped) return
    runner = runWatcher({
      folder,
      handle: makeHandler(folder),
      scanMs: options.scanMs,
      ttlMs: options.ttlMs,
      now
    })
  }

  // 첫 감시 시작도 거절을 밖으로 내보내지 않는다 — 위 `ensureRunner` 가 이미 실패를 삼킨다.
  void ensureRunner()
  folderTimer = setInterval(() => {
    void ensureRunner().catch(() => {
      /* 폴더 전환 확인 실패는 다음 박자에 다시 한다. */
    })
  }, options.scanMs ?? 750)
  folderTimer.unref?.()

  return {
    async beginTurn(folder, turnId) {
      if (failed) return
      try { await ready } catch { failChannel(); return }
      // 준비 상한에 걸려 이미 닫힌 턴이면 열지 않는다 — 열면 지운 턴 파일이 되살아난다(위 주석).
      if (lastClosedTurnId === turnId) return
      // 소유권은 사슬 **앞**에서 잡는다 — 사슬에서 기다리는 사이 옛 `endTurn` 이 확인하면 이 턴이 아니라
      // 옛 턴을 닫아야 맞다(I-01). 게이트는 사슬 안에서 **파일을 쓴 뒤** 연다: 파일이 아직 없는 동안
      // 게이트가 열려 있으면 감시자가 집은 요청이 `cancelled` 로 닫혀 학생의 그림 요청을 잃는다.
      ownerTurnId = turnId
      await turnOp(async () => {
        // 사슬에서 기다리는 사이 이 턴이 닫혔거나(늦은 `endTurn`) 다른 턴이 소유권을 가져갔으면 쓰지
        // 않는다 — 쓰면 이미 닫힌 턴의 파일이 남거나, 뒤이어 지워질 파일을 한 번 더 만든다.
        if (ownerTurnId !== turnId) return
        await writeTurn(paths.turn, turnId, folder, now())
        if (ownerTurnId !== turnId) return
        // 세대값을 올림과 **같은 틱에** 게이트를 연다(사이에 await 없음) — 앞 턴의 lease 를 끊는다.
        generation += 1
        closed = false
      })
      // 턴이 시작되면 그 폴더의 감시자가 필요하다 — 다음 박자를 안 기다린다.
      if (options.getFolder() !== runnerFolder) await ensureRunner()
    },
    async endTurn(turnId) {
      // 이 턴은 닫혔다 — 늦게 도착할 `beginTurn` 이 되살리지 못하게 먼저 적는다.
      lastClosedTurnId = turnId
      // **소유자만** 닫는다(I-01). 통로는 하나지만 턴은 폴더·공급자마다 있으므로, 다른 폴더의 옛 턴이
      // 늦게 끝나면서 지금 도는 턴의 `turn.json` 을 지우면 그 턴의 정상 요청이 전부 stale 이 된다.
      if (ownerTurnId !== turnId) return
      if (failed) { ownerTurnId = null; return }
      try { await ready } catch { failChannel(); ownerTurnId = null; return }
      // 기다리는 사이 새 턴이 열렸으면 소유권이 넘어갔다 — 그 턴의 게이트를 닫으면 안 된다.
      if (ownerTurnId !== turnId) return
      // 세대값을 올림과 **같은 틱에** 게이트를 닫아 새 쓰기를 막고, 이미 시작한 쓰기가 끝나기를 기다린 뒤
      // 턴을 지운다(R-6). 세대값만 올리면 턴 파일을 지우는 사이 집힌 요청이 새 세대값으로 살아남는다.
      generation += 1
      closed = true
      const { promise: drainDone, resolve: drainResolve } = Promise.withResolvers<void>()
      onDrained(drainResolve)
      await drainDone
      // 지우기는 사슬 안에서, **소유권 확인과 같은 틱에** 한다(I-01 남은 경계). 확인을 사슬 밖에서 하면
      // 확인~지우기 사이에 새 `beginTurn` 의 쓰기가 끼어 들어 그 파일을 지운다(실측 재현).
      await turnOp(async () => {
        // 사슬을 기다리는 사이 소유권이 넘어갔으면(새 턴이 열렸으면) 지우지 않는다.
        if (ownerTurnId !== turnId) return
        ownerTurnId = null
        await (options.clearTurn ?? clearTurn)(paths.turn)
      })
    },
    async recordStudentMessage(folder, text) {
      if (failed) return 0
      try { await ready } catch { failChannel(); return 0 }
      // 요청 처리 쪽과 같은 해시를 쓰려면 폴더 표기도 같이 정규화해야 한다(맥 /tmp·/private/tmp).
      const hash = folderHash(await realpath(folder).catch(() => folder))
      const dir = join(paths.choices, hash)
      let slots: string[] = []
      try {
        slots = (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
      } catch {
        return 0
      }
      return fillChoiceSheets(paths.choices, hash, slots, text, now())
    },
    async stop() {
      stopped = true
      ownerTurnId = null
      clearInterval(folderTimer)
      runner?.stop()
      runner = null
      await heartbeat.stop()
      // 저장소 준비가 실패했더라도 종료 경로는 던지지 않는다.
      await ready.catch(() => {})
    },
    async idle() {
      if (failed) return
      try { await ready } catch { failChannel(); return }
      await runner?.idle()
    }
  }
}
