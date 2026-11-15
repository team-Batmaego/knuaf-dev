import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { scrub } from '../src/main/diagLog'

/**
 * 시험 쪽 종료 관측 — 앱이 스스로 남기는 진단(`KNUAF_APP_LOG`)과 **같은 파일**에 덧붙인다.
 *
 * 왜 시험 쪽도 필요한가: `electronApp.close()` 가 안 돌아오면 finally 는 영영 실행되지 않는다.
 * 그러면 "닫기 시작했다"는 사실조차 기록되지 않았다(PR #102 윈도우 CI 가 그랬다). 그래서 닫기
 * **직전**에 mark 를 남기고, 앱의 stdout/stderr 사본도 즉시 파일로 흘려보낸다 — 메모리에 모았다가
 * finally 에 쓰면 그 값은 사라진다.
 *
 * 닫기가 안 끝나도 증거가 남는다: 닫기 시작 뒤로는 5초마다 앱 프로세스가 살아 있는지 덧붙인다.
 * 시험 프로세스는 `close()` 를 기다리는 동안에도 이벤트 루프가 살아 있으므로 이 줄은 계속 쌓인다.
 *
 * **원문을 그대로 옮기지 않는다**(검토 RT3 중요). 이 파일은 Playwright 산출물로 CI 에 올라가는데,
 * stderr 에는 앱이 아닌 것(Chromium 잡음, 스택 트레이스)과 값(토큰·`Authorization`·절대 경로)이
 * 섞여 있었다. 남기는 것은 **허용된 모양**뿐이다: 앱이 스스로 붙인 태그(`[shutdown]`·`[knuaf]`…)로
 * 시작하는 줄, 그리고 그 줄에서 `scrub` 을 통과한 내용. 나머지는 버리되 **버린 줄 수**는 남긴다 —
 * 조용히 버리면 "원래 그게 전부"로 읽힌다.
 *
 * 로그가 본체를 방해하지 않는다: 쓰기 실패는 삼키고, 리스너는 데이터를 읽기만 한다.
 */

/** 앱이 스스로 붙이는 태그. 이 접두로 시작하지 않는 줄은 산출물에 넣지 않는다. */
const APP_TAGS = ['[shutdown]', '[knuaf]', '[transport]', '[sidecar]', '[chat]', '[update]']

/**
 * stdout/stderr 한 덩어리를 산출물에 넣을 줄들로 바꾼다. 순수 함수 — 시험이 직접 고정한다.
 * `now` 를 받는 이유도 같다(시각을 단언에 쓰지 않게).
 */
export function witnessLines(tag: string, chunk: string, now = Date.now()): string[] {
  const lines = chunk.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '')
  const kept: string[] = []
  let dropped = 0
  for (const line of lines) {
    if (!APP_TAGS.some((prefix) => line.trimStart().startsWith(prefix))) { dropped++; continue }
    kept.push(`${now} [test:${tag}] ${scrub(line)}`)
  }
  if (dropped) kept.push(`${now} [test:${tag}] (앱 태그 없는 줄 ${dropped}개 생략 — 토큰·경로·스택이 섞일 수 있어 원문을 옮기지 않는다)`)
  return kept
}

export function captureAppLog(app: ElectronApplication, file: string): { path: string; mark: (stage: string) => void } {
  try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 append 가 같은 이유로 실패한다 */ }
  const write = (tag: string, lines: string[]): void => {
    if (!lines.length) return
    try { appendFileSync(file, `${lines.join('\n')}\n`) } catch { /* 진단이 시험을 깨지 않는다 */ }
  }
  const writeAll = (tag: string, chunk: string): void => write(tag, witnessLines(tag, chunk))
  const proc = app.process()
  const pid = proc.pid
  const snapshot = (stage: string): void => {
    let alive = 'unknown'
    if (typeof pid === 'number') {
      try { process.kill(pid, 0); alive = 'alive' } catch (e) { alive = `gone(${(e as NodeJS.ErrnoException).code ?? e})` }
    }
    write('mark', [`${Date.now()} [test:mark] ${stage} pid=${pid ?? '없음'} ${alive} 시험경과=${process.uptime().toFixed(1)}s`])
  }
  proc.stdout?.on('data', (chunk: Buffer | string) => writeAll('out', String(chunk)))
  proc.stderr?.on('data', (chunk: Buffer | string) => writeAll('err', String(chunk)))
  proc.once('exit', (code, signal) => write('exit', [`${Date.now()} [test:exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`]))
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
