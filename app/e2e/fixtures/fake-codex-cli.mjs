#!/usr/bin/env node
/**
 * 가짜 `codex` CLI — `--version` 에는 즉시 답하고, 그 밖의 호출은 app-server 픽스처로 넘긴다.
 *
 * 상태 확인(`codex --version`)과 실제 실행(터미널 잠금 열거) 이 **같은 실행 파일**을 부르므로
 * 한쪽만 답하는 가짜를 두면 잠금 단계가 통째로 거부된다(§4.1-C — 목록을 못 읽으면 열지 않는다).
 * 인자 판정을 셸이 아니라 node 가 하므로 윈도우 `.cmd` 재파싱 문제가 없다
 * (`fake-codex.ts` 의 `writeStatefulClaude` 주석과 같은 이유).
 */
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.0.0-test')
  process.exit(0)
}
await import('./fake-codex-server.mjs')
