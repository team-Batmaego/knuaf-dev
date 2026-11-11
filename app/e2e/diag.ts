import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ElectronApplication } from '@playwright/test'

/**
 * 시험 쪽 종료 관측 — 앱이 스스로 남기는 진단(`KNUAF_APP_LOG`)과 **같은 파일**에 덧붙인다.
 *
 * 왜 시험 쪽도 필요한가: `electronApp.close()` 가 안 돌아오면 finally 는 영영 실행되지 않는다.
 * 그러면 "닫기 시작했다"는 사실조차 기록되지 않는다(PR #102 윈도우 CI 가 그랬다). 그래서 닫기
 * **직전**에 mark 를 남기고, 앱의 stdout/stderr 사본도 즉시 파일로 흘려보낸다 — 메모리에 모았다가
 * finally 에 쓰면 그 값은 사라진다.
 *
 * 닫기가 안 끝나도 증거가 남는다: 닫기 시작 뒤로는 5초마다 앱 프로세스가 살아 있는지 덧붙인다.
 * 시험 프로세스는 `close()` 를 기다리는 동안에도 이벤트 루프가 살아 있으므로 이 줄은 계속 쌓인다.
 *
 * 로그가 본체를 방해하지 않는다: 쓰기 실패는 삼키고, 리스너는 데이터를 읽기만 한다.
 */
export function captureAppLog(app: ElectronApplication, file: string): { path: string; mark: (stage: string) => void } {
  try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 append 가 같은 이유로 실패한다 */ }
  const write = (tag: string, chunk: string): void => {
    try { appendFileSync(file, `${Date.now()} [test:${tag}] ${chunk.replace(/\n$/, '')}\n`) } catch { /* 진단이 시험을 깨지 않는다 */ }
  }
  const proc = app.process()
  const pid = proc.pid
  const snapshot = (stage: string): void => {
    let alive = 'unknown'
    if (typeof pid === 'number') {
      try { process.kill(pid, 0); alive = 'alive' } catch (e) { alive = `gone(${(e as NodeJS.ErrnoException).code ?? e})` }
    }
    write('mark', `${stage} pid=${pid ?? '없음'} ${alive} 시험경과=${process.uptime().toFixed(1)}s`)
  }
  proc.stdout?.on('data', (chunk: Buffer | string) => write('out', String(chunk).trimEnd()))
  proc.stderr?.on('data', (chunk: Buffer | string) => write('err', String(chunk).trimEnd()))
  proc.once('exit', (code, signal) => write('exit', `code=${code ?? 'null'} signal=${signal ?? 'null'}`))
  let beat: NodeJS.Timeout | undefined
  return {
    path: file,
    mark: (stage) => {
      snapshot(stage)
      if (stage === 'close:start') {
        const startedAt = Date.now()
        beat = setInterval(() => {
          const before = Date.now() - startedAt
          snapshot(`close:pending ${before}ms`)
        }, 5_000)
        // 이 타이머가 워커를 붙잡지 않는다 — 남의 시험 시간까지 늘리지 않기 위해서다.
        beat.unref?.()
      }
      if (stage === 'close:end' && beat) { clearInterval(beat); beat = undefined }
    }
  }
}
