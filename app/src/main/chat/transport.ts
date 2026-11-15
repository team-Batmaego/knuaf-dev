import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { winSpawn, killTree } from '../win'

/** killTree의 시그니처 — 시험 주입을 위한 이름이다. */
type KillFn = (child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal?: NodeJS.Signals) => void

/** stdio JSON-RPC. stderr stays out of the student transcript and credentials never enter logs. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  closed = false
  /** 자식 pid — 종료 마감 뒤 회수 대상 목록에 넣기 위한 읽기 전용 값(동작 불변). */
  get pid(): number | undefined { return this.child.pid }
  /** 자식이 왜 죽었는지는 stderr 에만 남는다. 진단용으로 꼬리만 보관한다(무한 증가 금지). */
  lastStderr = ''
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (id: number | string, method: string, params: any) => void = () => {}
  onClose: () => void = () => {}
  /** killTree 주입 — 시험이 kill 실패·exit 미발생을 결정적으로 만들 때만 쓴다. 기본값은 종전 그대로. */
  private readonly killFn: KillFn
  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: { killFn?: KillFn } = {}) {
    this.killFn = opts.killFn ?? killTree
    // 윈도우에서 npm 이 깐 codex 는 `.cmd` 다 — Node 가 직접 띄우지 못하므로 cmd.exe 로 감싼다
    // (맥·리눅스와 `.exe` 는 그대로 — winSpawn 이 빈 옵션을 돌려준다).
    const spec = winSpawn(binary, args)
    this.child = spawn(spec.command, spec.args, { cwd, env, stdio: 'pipe', ...spec.options })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let m: any
      try { m = JSON.parse(line) } catch { return }
      if (m.method) {
        if (m.id !== undefined) this.onRequest(m.id, m.method, m.params)
        else this.onNotification(m.method, m.params)
      } else if (this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!; clearTimeout(p.timer); this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message ?? 'AI 요청 실패')) : p.resolve(m.result)
      }
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.lastStderr = (this.lastStderr + d.toString()).slice(-2000).trim()
    })
    this.child.on('error', () => this.finish())
    // 'exit'로 끝낸다 — 'close'는 stdio 파이프가 다 닫혀야 오는데, 에이전트가 띄운
    // 손자 프로세스가 파이프를 물고 있으면 부모가 죽어도 오지 않는다(앱 종료가 멈춤).
    this.child.on('exit', () => this.finish())
    this.child.stdin.on('error', () => this.finish())
  }
  private finish() {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('AI 연결이 종료됐어요. 전송 중이던 답변은 자동으로 다시 보내지 않아요.')) }
    this.pending.clear()
    // 대기 타이머가 메인을 최대 45s까지 살리지 않게 stdio를 끊고 완료를 알린다.
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    // stdio destroy는 자식 핸들(widget) 참조까지 끊지 못한다. 부모가 종료할 수 있게 힌들만 해제한다.
    // unref는 종료되지 않은 자식을 죽이지 않으므로, 고아로 남을 수 있다는 기록을 남긴다.
    this.detach()
    this.onClose()
  }
  /** 살아 있는 자식 핸들을 이벤트루프에서 떼어 부모(Electron main)가 종료할 수 있게 한다. 자식은 죽이지 않는다. */
  private detach() {
    const pid = this.child.pid
    const alive = this.child.exitCode === null && this.child.signalCode === null
    if (alive && pid) {
      try { this.child.kill('SIGKILL') } catch { /* 이미 죽음 */ }
      console.error(`[transport] 자식이 종료되지 않아 핸들을 떠났습니다 pid=${pid} (고아일 수 있음)`)
    }
    try { this.child.unref() } catch { /* 이미 해제됨 */ }
  }
  send(value: unknown) {
    if (this.closed) throw new Error('AI 연결이 종료됐어요.')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  request(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('AI 응답 시간이 초과됐어요. 전송 상태를 확인해 주세요.')) }, 45_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  async stop() {
    if (this.closed) return
    await new Promise<void>(resolve => {
      // 죽는 것('exit')만 기다린다. 'close'는 파이프 점유자 때문에 안 올 수 있다.
      const done = () => { clearTimeout(t1); clearTimeout(t2); resolve() }
      const t1 = setTimeout(() => this.killFn(this.child, 'SIGKILL'), 3000)
      // 'exit'가 안 와도 finish로 닫는다 — pending 45s 타이머가 메인을 살리지 않게.
      const t2 = setTimeout(() => { this.finish(); done() }, 3500)
      this.child.once('exit', done)
      // 윈도우에서 `cmd.exe` 로 감싼 자식은 **트리째** 끝낸다 — cmd.exe 만 죽이면 손자
      // (실제 codex·claude/node)가 고아로 남는다(윈도우 CI 4차). 맥은 종전 그대로다.
      this.killFn(this.child, 'SIGTERM')
    })
  }
}
