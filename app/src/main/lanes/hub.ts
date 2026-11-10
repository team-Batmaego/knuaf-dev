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
  private lastRoot: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private disposed = false

  constructor(
    private readonly source: LaneSource,
    send: (snapshot: LanesSnapshot) => void,
    private readonly diagnostic: (record: object) => void = () => {}
  ) {
    this.publisher = new LanesPublisher(send)
  }

  /**
   * 지금 보이는 폴더의 묶음을 다시 짓는다. `root` 를 주면 그 폴더가 "지금 보이는 폴더"가 된다.
   * 폴더를 모르는 변경(저장소 훅)은 마지막으로 보여 준 폴더를 다시 짓는다.
   */
  touch(root?: string | null): void {
    if (this.disposed) return
    if (root !== undefined) this.lastRoot = root
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, COALESCE_MS)
  }

  /** 즉시 짓는다 — `lanes:snapshot` 요청의 응답이자 화면이 처음 여는 순간. */
  async snapshot(root: string | null): Promise<LanesSnapshot> {
    this.lastRoot = root
    return this.publisher.publish(await laneInput(this.source, root))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private drain(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      try {
        await this.snapshot(this.lastRoot)
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
