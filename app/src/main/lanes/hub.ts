/**
 * `lanes:changed` 송신기 — 저장소·러너가 **바뀐 순간** 묶음을 다시 지어 보낸다.
 *
 * 한 번의 변경이 여러 쓰기를 만들기 때문에(상태 → 파일 → 기록 줄) 매번 보내면 화면이 같은
 * 묶음을 여러 번 받는다. 짧게 모아 한 번만 보내고, 짓는 도중 또 바뀌면 한 번 더 짓는다.
 * 화면은 `seq` 로 늦게 온 옛 묶음을 버리므로 순서는 문제되지 않는다(계약 §1).
 */
import type { LanesSnapshot } from '../../shared/lanes-ipc'
import { LanesPublisher } from './snapshot'
import type { LaneSource } from './source'
import { laneInput } from './source'

/** 한 번의 몰아 보내기 지연 — 같은 변경 묶음(러너 쓰기 2~3회)을 한 번으로 접는다. */
const COALESCE_MS = 30

export class LanesHub {
  private readonly publisher: LanesPublisher
  /**
   * 화면이 **지금 보고 있는 폴더**. 폴더 없는 변경(전역 동의)이 이 값을 덮으면 안 된다 —
   * [C1-15] `touch(null)` 이 이 값을 null 로 바꿔 이후 전송이 전역 묶음이 됐다.
   */
  private viewRoot: string | null = null
  /**
   * 폴더 선택 세대 — 조립이 느린 옛 폴더의 묶음이 새 폴더 뒤에 도착하는 것을 막는다([C1-17]).
   * 발행 시점에 세대와 폴더가 그대로인지 확인한다.
   */
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private disposed = false

  constructor(
    private readonly source: LaneSource,
    send: (snapshot: LanesSnapshot) => void,
    private readonly diagnostic: (record: object) => void = () => {}
  ) {
    this.publisher = new LanesPublisher(snapshot => {
      // 송신 직전 확인 — 늦게 완성된 옛 폴더 묶음은 화면을 되돌리지 않는다.
      if (this.disposed || snapshot.root !== this.viewRoot) return
      send(snapshot)
    })
  }

  /**
   * **화면이 보는 폴더**를 정한다(폴더를 열거나 바꿀 때만). 같은 값이면 아무것도 하지 않는다.
   * 이 값은 폴더 없는 변경으로 덮이지 않는다.
   */
  select(root: string | null): void {
    if (this.viewRoot === root) return
    this.viewRoot = root
    this.generation++
  }

  /** 지금 구독 중인 폴더 — 시험·진단용. */
  root(): string | null { return this.viewRoot }

  /**
   * 변경 하나가 왔다 — 보이는 폴더의 묶음을 다시 짓는다(폴더는 그대로). 저장소·러너의
   * `onChange` 가 이 자리에 붙는다([C1-14]).
   */
  nudge(): void { this.touch() }

  /**
   * 지금 보이는 폴더의 묶음을 다시 짓는다. `root` 를 주면 그 폴더가 "지금 보이는 폴더"가 된다.
   * 폴더를 모르는 변경(저장소 훅·전역 동의)은 **보이는 폴더를 바꾸지 않는다**.
   */
  touch(root?: string | null): void {
    if (this.disposed) return
    if (root !== undefined) this.select(root)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, COALESCE_MS)
  }

  /**
   * 즉시 짓는다 — `lanes:snapshot` 요청의 응답이자 화면이 처음 여는 순간.
   * 폴더를 바꾸는 요청은 여기서 화면의 폴더도 함께 정한다. 조립 도중 폴더가 바뀌었으면
   * 이 묶음은 **보내지 않는다**(발행기가 송신 직전에 거른다, [C1-17]).
   */
  async snapshot(root: string | null): Promise<LanesSnapshot> {
    this.select(root)
    const snapshots = this.publisher.publish(await laneInput(this.source, root))
    return snapshots
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private drain(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      try {
        // 폴더를 여기서 다시 정하지 않는다 — 보이는 폴더는 화면이 정한다.
        await this.publisher.publish(await laneInput(this.source, this.viewRoot))
      } catch (error) {
        // 묶음을 못 지어도 앱은 계속 돈다 — 화면은 마지막 묶음을 그대로 보여 준다.
        this.diagnostic({ type: 'lanes-snapshot', error: error instanceof Error ? error.message : String(error) })
      } finally {
        this.running = null
        if (this.again && !this.disposed) { this.again = false; void this.drain() }
      }
    })()
    return this.running
  }
}

/**
 * 저장소·러너의 실제 변경을 허브에 연결한다([C1-14]).
 *
 * 화면 묶음은 IPC 요청이 끝날 때만 다시 지어지고 있었다. 그래서 이어 하기·재시도 뒤에
 * **비동기로** 끝나는 주문 상태(완료·한도·전달·[이번만] 종료)가 화면에 저절로 반영되지 않았다.
 * 이 함수 하나가 그 연결의 정본이고, 시험은 이 함수를 직접 부른다(`ipc.ts` 는 호출만 한다).
 *
 * 돌려주는 함수는 연결 해제다.
 */
export function connectChanges(
  hub: Pick<LanesHub, 'nudge'>,
  sources: { onChange(listener: () => void): () => void }[]
): () => void {
  const offs = sources.map(source => source.onChange(() => hub.nudge()))
  return () => { for (const off of offs) off() }
}
