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
 * await channel.endTurn()                            // 턴 끝·중단
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
  endTurn(): Promise<void>
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
  const ready = prepareHome(paths)
  const heartbeat = startHeartbeat(paths.channel, { now })

  let runner: Runner | null = null
  let runnerFolder: string | null = null
  let stopped = false

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

  const ensureRunner = async (): Promise<void> => {
    await ready
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

  void ensureRunner()
  const folderTimer = setInterval(() => {
    void ensureRunner().catch(() => {
      /* 폴더 전환 확인 실패는 다음 박자에 다시 한다. */
    })
  }, options.scanMs ?? 750)
  folderTimer.unref?.()

  return {
    async beginTurn(folder, turnId) {
      await ready
      // 새 턴은 옛 요청의 쓰기를 끊는다 — 세대값을 올리고, 이 틱에 게이트를 연다. 열지 않으면 감시자가
      // 집은 요청이 전부 `cancelled`가 된다(게이트는 `endTurn` 뒤 닫힌 채로 남는다, R-6).
      generation += 1
      closed = false
      await writeTurn(paths.turn, turnId, folder, now())
      // 턴이 시작되면 그 폴더의 감시자가 필요하다 — 다음 박자를 안 기다린다.
      if (options.getFolder() !== runnerFolder) await ensureRunner()
    },
    async endTurn() {
      await ready
      // 세대값을 올림과 **같은 틱에** 게이트를 닫아 새 쓰기를 막고, 이미 시작한 쓰기가 끝나기를 기다린 뒤
      // 턴을 지운다(R-6). 세대값만 올리면 턴 파일을 지우는 사이 집힌 요청이 새 세대값으로 살아남는다.
      generation += 1
      closed = true
      await new Promise<void>((done) => onDrained(done))
      await (options.clearTurn ?? clearTurn)(paths.turn)
    },
    async recordStudentMessage(folder, text) {
      await ready
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
      clearInterval(folderTimer)
      runner?.stop()
      runner = null
      await heartbeat.stop()
      // 저장소 준비가 실패했더라도 종료 경로는 던지지 않는다.
      await ready.catch(() => {})
    },
    async idle() {
      await ready
      await runner?.idle()
    }
  }
}
