/**
 * WIN-ONEDRIVE 회귀 시험 — Node 단위(Electron 창 없이). `connect.spec.ts` 관례를 따른다.
 *
 * 윈도우에서 논문 폴더가 OneDrive 동기화 폴더면 `renameSync` 가 `EPERM` 으로 막히고, 그 예외가
 * main 의 이벤트 콜백에서 올라오면 Electron 오류 창("A JavaScript error occurred in the main
 * process")이 떴다(형님 실기). 여기서 고정하는 것은 **던지지 않는다**는 성질과 **완전한 기록 하나는
 * 언제나 남는다**는 보존 규칙이다(WIN-ONEDRIVE-R1-01): 대상은 이름 바꾸기로만 바뀌고(직접 덮어쓰지
 * 않는다), 이름 바꾸기가 막히면 최신본은 `.tmp` 에 남아 읽는 쪽이 되살린다.
 *
 * 실패는 폴더 권한(chmod)이 아니라 **fs 대역**으로 만든다 — 윈도우에서는 폴더 읽기 전용 속성이
 * 쓰기를 막지 않아 같은 시험이 다른 뜻이 된다(R1-03). 제품 경로 시험은 실제 파일시스템을 감싼
 * 대역을 `ChatService` 의 시험 이음매(`fs`)로 넣는다.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService, QUIT_FLUSH_DELAYS_MS } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { readRecoverable, renameWithRetry, writeFileAtomic, type SafeWriteFs, type WriteResult } from '../src/main/safeWrite'
import type { ChatSnapshot } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

/** 파일시스템 대역 — rename 을 정해진 횟수만큼 EPERM 으로 막는다. */
function stubFs(opts: { failRename?: number; failWrite?: boolean } = {}): {
  fs: SafeWriteFs
  files: Map<string, string>
  renames: () => number
} {
  const files = new Map<string, string>()
  let left = opts.failRename ?? 0
  let renames = 0
  const fs: SafeWriteFs = {
    writeFileSync: ((p: string, data: string) => {
      if (opts.failWrite) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      files.set(String(p), String(data))
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: ((from: string, to: string) => {
      renames++
      if (left > 0) { left--; throw eperm() }
      const v = files.get(String(from))
      if (v !== undefined) { files.set(String(to), v); files.delete(String(from)) }
    }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { files.delete(String(p)) }) as unknown as SafeWriteFs['unlinkSync'],
    readFileSync: (p: string) => { const v = files.get(String(p)); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v }
  }
  return { fs, files, renames: () => renames }
}

const NO_WAIT = [0, 0, 0, 0]

test('막힌 이름 바꾸기는 짧게 다시 시도하고, 풀리면 원자적으로 저장한다', () => {
  const { fs, files, renames } = stubFs({ failRename: 2 })
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT })
  expect(r).toEqual({ ok: true })                      // 폴백이 아니라 원자적 성공
  expect(files.get('/p/chat.json')).toBe('BODY')
  expect(files.has('/p/chat.json.tmp'), '.tmp 잔여물이 남았다').toBe(false)
  expect(renames(), '두 번 막힌 뒤 세 번째에 성공해야 한다').toBe(3)
})

test('계속 막히면 대상을 건드리지 않는다 — 최신본은 .tmp 에 남는다', () => {
  const { fs, files } = stubFs({ failRename: 99 })
  files.set('/p/chat.json', 'OLD')
  const logs: string[] = []
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT, log: (m) => logs.push(m) })
  expect(r.ok).toBe(false)
  expect(files.get('/p/chat.json'), '대상을 직접 덮었다').toBe('OLD')
  expect(files.get('/p/chat.json.tmp'), '최신본을 남기지 않았다').toBe('BODY')
  expect(logs.join('\n'), '남긴 자리를 알린다').toContain('남겼어요')
})

test('대상 없이 .tmp 만 완성본이면, 다시 쓰기 전에 먼저 대상으로 올린다 (rename 막히면 복사)', () => {
  const { fs, files } = stubFs({ failRename: 99 })
  files.set('/p/chat.json.tmp', 'KEPT')
  const r = writeFileAtomic('/p/chat.json', 'NEW', { fs, delaysMs: NO_WAIT, log: () => {} })
  expect(r.ok).toBe(false)                              // rename 은 끝내 막혔다
  expect(files.get('/p/chat.json'), '유일한 완성본을 대상으로 올리지 않았다').toBe('KEPT')
  expect(files.get('/p/chat.json.tmp')).toBe('NEW')
})

test('유일한 완성본을 올리지 못하면 이번 저장은 건너뛴다 — .tmp 는 그대로', () => {
  const files = new Map<string, string>([['/p/chat.json.tmp', 'KEPT']])
  const fs: SafeWriteFs = {
    writeFileSync: (() => { throw eperm() }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: (() => { throw eperm() }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: (() => { throw new Error('지우면 안 된다') }) as unknown as SafeWriteFs['unlinkSync'],
    readFileSync: (p: string) => { const v = files.get(String(p)); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v }
  }
  const logs: string[] = []
  const r = writeFileAtomic('/p/chat.json', 'NEW', { fs, delaysMs: NO_WAIT, log: (m) => logs.push(m) })
  expect(r.ok).toBe(false)
  expect(files.get('/p/chat.json.tmp'), '유일한 완성본을 건드렸다').toBe('KEPT')
  expect(logs.join('\n')).toContain('건너뛰었어요')
})

test('쓰기가 막히면 던지지 않고 실패를 돌려준다', () => {
  const { fs, files } = stubFs({ failRename: 99, failWrite: true })
  const logs: string[] = []
  let r: WriteResult | undefined
  expect(() => { r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: [0], log: (m) => logs.push(m) }) }).not.toThrow()
  expect(r?.ok).toBe(false)
  expect(files.size, '실패했는데 무언가 남겼다').toBe(0)
  expect(logs.join('\n'), '실패 사실을 남긴다').toContain('저장하지 못했어요')
})

test('.tmp 를 만들지 못하면 대상을 덮지 않는다 — 그때 완전한 기록은 대상뿐이다', () => {
  const files = new Map<string, string>([['/p/chat.json', 'OLD']])
  const fs: SafeWriteFs = {
    writeFileSync: ((p: string, d: string) => {
      if (String(p).endsWith('.tmp')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      files.set(String(p), String(d))
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: (() => { throw new Error('rename 까지 오면 안 된다') }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { files.delete(String(p)) }) as unknown as SafeWriteFs['unlinkSync']
  }
  const r = writeFileAtomic('/p/chat.json', 'NEW', { fs, delaysMs: NO_WAIT, log: () => {} })
  expect(r.ok).toBe(false)
  expect(files.get('/p/chat.json'), '완성본 없이 대상을 덮었다').toBe('OLD')
})

test('다시 시도해 볼 만한 오류가 아니면 곧바로 멈춘다', () => {
  // ENOENT(폴더 없음)는 잠깐 막힌 것이 아니다 — 재시도하면 main 을 300ms 붙잡는다.
  let writes = 0
  let renames = 0
  const fs: SafeWriteFs = {
    writeFileSync: (() => { writes++ }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: (() => { renames++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: (() => {}) as unknown as SafeWriteFs['unlinkSync']
  }
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT, log: () => {} })
  expect(r.ok).toBe(false)
  expect([writes, renames]).toEqual([1, 1])
})

test('폴더 이동(이름 바꾸기 전용)은 재시도하고, 끝까지 막히면 던진다', () => {
  const ok = stubFs({ failRename: 2 })
  expect(() => renameWithRetry('/a/skills/old', '/b/old', { fs: ok.fs, delaysMs: [0, 0, 0] })).not.toThrow()
  expect(ok.renames()).toBe(3)

  const stuck = stubFs({ failRename: 99 })
  expect(() => renameWithRetry('/a/old', '/b/old', { fs: stuck.fs, delaysMs: [0] })).toThrow(/EPERM/)
})

// ---------------------------------------------------------------- 읽는 쪽 (readRecoverable)

const json = (t: string): { v: number } => { const v = JSON.parse(t) as { v: number }; if (typeof v.v !== 'number') throw new Error('모양이 다르다'); return v }

test('온전한 .tmp 가 있으면 그것이 최신 완성본이다 — 대상이 반쪽이든 옛것이든', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-recover-'))
  const file = join(dir, 'chat.json')
  writeFileSync(file + '.tmp', '{"v":2}')
  writeFileSync(file, '{"v":')                 // 직접 쓰기가 중간에 멈춘 반쪽 — 수정 시각은 .tmp 보다 나중이다
  expect(readRecoverable(file, json)).toEqual({ value: { v: 2 }, from: 'tmp' })
  writeFileSync(file, '{"v":1}')               // 직접 쓰기가 대상을 건드리기 전에 막힘
  expect(readRecoverable(file, json)).toEqual({ value: { v: 2 }, from: 'tmp' })
  unlinkSync(file + '.tmp')
  expect(readRecoverable(file, json)).toEqual({ value: { v: 1 }, from: 'file' })
})

test('되살릴 것이 없으면 망가진 대상은 오류로 거절하고, 처음부터 없으면 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-recover-'))
  const file = join(dir, 'chat.json')
  expect(readRecoverable(file, json)).toBeNull()
  writeFileSync(file + '.tmp', '{"v":')        // 반쪽 .tmp 만 있다 — 기록이 아니다
  expect(readRecoverable(file, json)).toBeNull()
  writeFileSync(file, '{"v":')
  expect(() => readRecoverable(file, json), '망가진 기록을 빈 것으로 바꿨다').toThrow()
})

// ---------------------------------------------------------------- 제품 경로 (publish·flushDrafts)

const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
const eacces = (): Error => Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })

/**
 * 실제 파일시스템을 감싸 정해진 자리만 실패시키는 대역. 실패는 플랫폼과 무관하게 같은 뜻이다.
 * `partial` 은 대상에 앞부분만 실제로 쓰고 ENOSPC 로 멈춘다 — 판정 R1-01 의 반례 그대로.
 */
function faultyFs(rule: { rename?: () => Error | null; write?: (path: string) => Error | 'partial' | null; unlink?: (path: string) => Error | null; read?: (path: string) => Error | null }): SafeWriteFs {
  return {
    writeFileSync: ((p: string, d: string, o?: object) => {
      const f = rule.write?.(String(p)) ?? null
      if (f === 'partial') { writeFileSync(p, String(d).slice(0, 20)); throw enospc() }
      if (f) throw f
      writeFileSync(p, d, o as never)
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: ((a: string, b: string) => { const f = rule.rename?.() ?? null; if (f) throw f; renameSync(a, b) }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { const f = rule.unlink?.(String(p)) ?? null; if (f) throw f; unlinkSync(p) }) as unknown as SafeWriteFs['unlinkSync'],
    readFileSync: (p: string) => { const f = rule.read?.(String(p)) ?? null; if (f) throw f; return readFileSync(p, 'utf8') }
  }
}

function project(): { root: string; dir: string; file: string; draft: string } {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-drive-'))
  const dir = join(root, '.knuaf-gui')
  mkdirSync(dir, { recursive: true })
  return { root, dir, file: join(dir, 'chat-codex.json'), draft: join(dir, 'draft.txt') }
}

const service = (emit: (s: ChatSnapshot) => void, fs?: SafeWriteFs): ChatService =>
  new ChatService({ skillSource: () => source, userData: mkdtempSync(join(tmpdir(), 'kd-win-ud-')), emit, openExternal: async () => {}, fs })

/** 앱이 작업 중 종료된 기록 — snapshot() 이 복구 상태를 곧바로 publish 한다(실제 호출 경로). */
const RUNNING = (root: string): string => JSON.stringify({ root, provider: 'codex', state: 'running', messages: [
  { id: 'u0', role: 'user', text: '앞서 나눈 긴 대화', at: '2026-10-18T00:00:00Z', delivery: 'sent' },
  { id: 'u1', role: 'user', text: '안녕', at: '2026-10-19T00:00:00Z', delivery: 'pending' }
] })

test('rename 이 막히면 대상은 그대로, 다시 띄우면 .tmp 의 최신 기록을 읽고 제자리로 옮긴다', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s), faultyFs({
    rename: eperm,                                          // OneDrive 가 교체를 계속 막는다
    write: (p) => (p === file ? 'partial' : null)           // 대상을 직접 쓰면 반쪽이 된다 — 쓰지 않아야 한다
  }))
  let s: ChatSnapshot | undefined
  expect(() => { s = svc.snapshot(root, 'codex') }).not.toThrow()   // main 이벤트 콜백에서 올라가던 예외
  expect(s?.state).toBe('interrupted')
  expect(emitted, '저장 실패가 화면 흐름을 막았다').toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).state, '대상을 직접 덮었다').toBe('running')
  expect(JSON.parse(readFileSync(file + '.tmp', 'utf8')).state, '최신본을 .tmp 에 남기지 않았다').toBe('interrupted')

  // 앱을 다시 띄운다(실제 fs) — .tmp 의 최신본을 읽고, 막힘이 풀렸으니 제자리로 옮긴다.
  const again = service(() => {}).snapshot(root, 'codex')
  expect(again.state).toBe('interrupted')
  expect(again.messages.map((m) => m.text), '저장했던 대화를 잃었다').toEqual(['앞서 나눈 긴 대화', '안녕'])
  expect(JSON.parse(readFileSync(file, 'utf8')).state, '되살린 기록이 제자리로 돌아가지 않았다').toBe('interrupted')
  expect(existsSync(file + '.tmp')).toBe(false)
})

test('.tmp 에만 최신본이 있을 때 다음 .tmp 쓰기가 중간에 멈춰도 대화는 남는다 (R1-01 확인 반례)', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  // 판정 반례 순서 그대로: ① rename 막힘(+ 대상을 직접 쓰면 반쪽) → ② 다음 실행이 되살린 뒤 다시 저장하다 .tmp 반쪽.
  service(() => {}, faultyFs({ rename: eperm, write: (p) => (p === file ? 'partial' : null) })).snapshot(root, 'codex')
  const emitted: ChatSnapshot[] = []
  const second = service((s) => emitted.push(s), faultyFs({ rename: eperm, write: (p) => (p === file || p.endsWith('.tmp') ? 'partial' : null) }))
  expect(() => second.snapshot(root, 'codex')).not.toThrow()                        // 되살린 뒤 다시 저장 → .tmp 반쪽
  expect(emitted).toHaveLength(1)
  expect(() => JSON.parse(readFileSync(file + '.tmp', 'utf8')), '반례가 .tmp 를 반쪽으로 만들지 못했다(시험 전제)').toThrow()
  const third = service(() => {}).snapshot(root, 'codex')
  expect(third.messages.map((m) => m.text), '완전한 기록이 하나도 남지 않았다').toEqual(['앞서 나눈 긴 대화', '안녕'])
})

/** 대화를 처음 저장하는 자리(send·이벤트의 publish)를 로그인·AI 호출 없이 부른다. */
const publish = (svc: ChatService, s: ChatSnapshot): void => { (svc as unknown as { publish(s: ChatSnapshot): void }).publish(s) }
const TWO = (root: string): ChatSnapshot => ({ ...(JSON.parse(RUNNING(root)) as ChatSnapshot), state: 'idle' })

test('대상 없이 .tmp 만 완성본일 때 복구 재저장이 .tmp 를 반쪽으로 만들어도 대화는 남는다 (확인 2회째 반례)', () => {
  const { root, file } = project()
  publish(service(() => {}, faultyFs({ rename: eperm })), TWO(root))              // 첫 저장부터 rename 막힘
  expect(existsSync(file), '시험 전제: 대상이 생기지 않아야 한다').toBe(false)
  const emitted: ChatSnapshot[] = []
  const second = service((s) => emitted.push(s), faultyFs({ rename: eperm, write: (p) => (p.endsWith('.tmp') ? 'partial' : null) }))
  expect(second.snapshot(root, 'codex').messages).toHaveLength(2)                  // .tmp 에서 되살려 곧바로 다시 저장
  expect(emitted).toHaveLength(1)
  expect(() => JSON.parse(readFileSync(file + '.tmp', 'utf8')), '시험 전제: .tmp 가 반쪽이 돼야 한다').toThrow()
  expect(JSON.parse(readFileSync(file, 'utf8')).messages, '다시 쓰기 전에 완성본을 대상으로 올리지 않았다').toHaveLength(2)
  expect(service(() => {}).snapshot(root, 'codex').messages, '완전한 기록이 하나도 남지 않았다').toHaveLength(2)
})

test('대상 없이 .tmp 만 완성본이고 대상으로 올리지도 못하면, 그 .tmp 를 건드리지 않는다', () => {
  const { root, file } = project()
  publish(service(() => {}, faultyFs({ rename: eperm })), TWO(root))
  const kept = readFileSync(file + '.tmp', 'utf8')
  const second = service(() => {}, faultyFs({ rename: eperm, write: () => 'partial' }))   // 복사도 .tmp 쓰기도 반쪽
  expect(() => second.snapshot(root, 'codex')).not.toThrow()
  expect(readFileSync(file + '.tmp', 'utf8'), '유일한 완성본(.tmp)을 건드렸다').toBe(kept)
  const third = service(() => {}).snapshot(root, 'codex')                          // 막힘이 풀린 실행
  expect(third.messages, '완전한 기록이 하나도 남지 않았다').toHaveLength(2)
  expect(JSON.parse(readFileSync(file, 'utf8')).messages).toHaveLength(2)
})

test('유일한 .tmp 를 확인하는 읽기가 잠깐 막혀도 그 .tmp 를 다시 쓰지 않는다 (확인 3회째 반례)', () => {
  const { root, file } = project()
  publish(service(() => {}, faultyFs({ rename: eperm })), TWO(root))              // 대화는 .tmp 에만
  let blockedReads = 0
  const second = service(() => {}, faultyFs({
    rename: eperm,
    read: (p) => (p.endsWith('.tmp') && blockedReads++ === 0 ? eacces() : null),   // 완성 여부 확인 읽기 1회 거부
    write: (p) => (p.endsWith('.tmp') ? 'partial' : null)
  }))
  expect(second.snapshot(root, 'codex').messages).toHaveLength(2)
  expect(blockedReads, '시험 전제: 확인 읽기가 막혀야 한다').toBeGreaterThan(0)
  expect(service(() => {}).snapshot(root, 'codex').messages, '완전한 기록이 하나도 남지 않았다').toHaveLength(2)
})

test('초안도 대상 없이 .tmp 만 있으면 다시 쓰기 전에 대상으로 올린다', () => {
  const { root, draft } = project()
  const first = service(() => {}, faultyFs({ rename: eperm }))
  first.setDraft(root, '처음 쓴 글'); first.flushDrafts()
  expect(existsSync(draft), '시험 전제: 대상이 생기지 않아야 한다').toBe(false)
  const second = service(() => {}, faultyFs({ rename: eperm, write: (p) => (p.endsWith('.tmp') ? 'partial' : null) }))
  second.setDraft(root, '이어서 고친 글'); second.flushDrafts()
  expect(readFileSync(draft, 'utf8'), '다시 쓰기 전에 완성본을 대상으로 올리지 않았다').toBe('처음 쓴 글')
})

test('.tmp 에만 최신본이 있을 때 다음 .tmp 쓰기가 열기에서 막히면 그 최신본은 그대로다', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  service(() => {}, faultyFs({ rename: eperm })).snapshot(root, 'codex')
  const kept = readFileSync(file + '.tmp', 'utf8')
  const emitted: ChatSnapshot[] = []
  const second = service((s) => emitted.push(s), faultyFs({ write: (p) => (p.endsWith('.tmp') ? eperm() : null) }))
  expect(() => second.snapshot(root, 'codex')).not.toThrow()
  expect(emitted).toHaveLength(1)
  expect(readFileSync(file + '.tmp', 'utf8'), '유일한 최신본(.tmp)을 건드렸다').toBe(kept)
  expect(service(() => {}).snapshot(root, 'codex').state).toBe('interrupted')
})

test('.tmp 를 만들 수 없으면(EACCES) 던지지 않고, 기존 기록은 손대지 않는다', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s), faultyFs({ write: (p) => (p.endsWith('.tmp') ? eacces() : null) }))
  expect(() => svc.snapshot(root, 'codex')).not.toThrow()
  expect(emitted, '저장이 실패해도 화면으로는 나가야 한다').toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).state, '완성본 없이 대상을 덮었다').toBe('running')
  expect(existsSync(file + '.tmp')).toBe(false)
})

test('초안 저장이 막히면 값을 지우지 않는다 — 풀린 뒤 다음 flush 가 남긴다', () => {
  const { root, draft } = project()
  let blocked = true
  const svc = service(() => {}, faultyFs({ write: (p) => (blocked && p.startsWith(draft) ? eacces() : null) }))
  svc.setDraft(root, '쓰다 만 글')
  expect(() => svc.flushDrafts()).not.toThrow()
  expect(svc.draft(root), '저장에 실패했는데 메모리 값까지 잃었다').toBe('쓰다 만 글')
  expect(existsSync(draft)).toBe(false)
  blocked = false
  svc.flushDrafts()
  expect(readFileSync(draft, 'utf8')).toBe('쓰다 만 글')
  expect(svc.draft(root)).toBe('쓰다 만 글')
})

test('빈 초안의 삭제가 막혀도 보낸 글이 되살아나지 않는다 (R1-02)', () => {
  const { root, draft } = project()
  writeFileSync(draft, '이미 전송한 글')
  let blocked = true
  const svc = service(() => {}, faultyFs({ unlink: (p) => (blocked && p === draft ? eperm() : null) }))
  svc.setDraft(root, '')                                  // 전송 성공 뒤 화면이 초안을 비운다
  expect(() => svc.flushDrafts()).not.toThrow()
  expect(svc.draft(root), '삭제가 막혔는데 보낸 글이 되살아났다').toBe('')
  expect(existsSync(draft)).toBe(true)
  blocked = false
  svc.flushDrafts()                                       // 대기가 남아 있어 다시 지운다
  expect(existsSync(draft), '잠금이 풀린 뒤에도 지우지 않았다').toBe(false)
  expect(svc.draft(root)).toBe('')
})

test('종료 경로의 초안 flush 는 막힌 쓰기에서도 짧게 끝난다 — 재시도 예산이 줄어 있다 (RT3)', () => {
  // 멈춤 후보 1a: `flushDrafts()` 는 **동기**다. 재시도 대기(Atomics.wait)를 안고 돌면 그 시간만큼
  // main 스레드가 서고, 그동안 종료 마감 타이머도 서 있다. 그래서 종료 경로는 `QUIT_FLUSH_DELAYS_MS`
  // 로 부르고, 기본 예산(300ms)은 타이머 flush 에만 쓴다.
  // 20+30=50ms 는 **파일 하나**의 상한이다(검토 RT3 정정) — 초안이 N개면 50×N ms 까지 늘어난다.
  // 이 시험은 파일 하나만 두므로 그 합이 그대로 상한이 된다.
  // ⓐ 예산값 자체를 잠근다. 시도 횟수만으로는 지연이 [200,200] 으로 늘어도 3회라 통과한다(검토 I-01).
  expect(QUIT_FLUSH_DELAYS_MS, '종료 예산이 [20,30] 에서 벗어났다').toEqual([20, 30])
  expect(QUIT_FLUSH_DELAYS_MS.reduce((a, b) => a + b, 0), '파일 하나 상한 50ms 를 넘었다').toBeLessThanOrEqual(50)
  const { root, draft } = project()
  let blocked = true
  // 판별값은 **시도 횟수**다(러너 속도와 무관). 종료 예산 [20,30] 이면 초기 1 + 재시도 2 = 3회,
  // 기본 예산 [20,40,80,160] 이면 5회 — 이 시험이 가르려는 것이 정확히 그 차이다.
  // 시도 사이 간격도 함께 잰다(hrtime — 단조 증가라 벽시계 조정에 안 흔들린다). 하한이므로
  // 예산을 키운 쪽은 못 잡고(그건 ⓐ 가 값으로 잡는다) **대기를 건너뛴 쪽**을 잡는다 — [0,0] 처럼
  // 횟수만 3회로 맞춘 경우가 여기서 걸린다(ⓑ).
  let attempts = 0
  let writes = 0
  const attemptAt: bigint[] = []
  const svc = service(() => {}, faultyFs({ write: (p) => {
    if (!p.startsWith(draft)) return null
    writes++
    if (!blocked) return null
    attempts++
    attemptAt.push(process.hrtime.bigint())
    return eacces()
  } }))
  svc.setDraft(root, '쓰다 만 글')
  const started = Date.now()
  expect(() => svc.flushDrafts({ delaysMs: QUIT_FLUSH_DELAYS_MS })).not.toThrow()
  const elapsed = Date.now() - started
  // 시도 횟수가 먼저다 — 벽시계보다 흔들리지 않는 판별값이라, 예산이 새면 이 줄이 먼저 짚는다.
  expect(attempts, '종료 예산인데 재시도가 기본 예산(5회)만큼 돌았다').toBe(3)
  // ⓑ 하한 — 재시도 i 는 `delays[i-1]` 만큼 동기로 기다린 뒤에야 다음 시도를 한다.
  // 상한이 아니라 하한이라 러너가 느린 것은 걸리지 않는다(1ms 는 시계 눈금 여유).
  for (let i = 1; i < attemptAt.length; i++) {
    const wait = QUIT_FLUSH_DELAYS_MS[i - 1]
    const gap = Number(attemptAt[i] - attemptAt[i - 1]) / 1e6
    expect(gap, `${i}번째 재시도가 예산 ${wait}ms 를 기다리지 않았다`).toBeGreaterThanOrEqual(wait - 1)
  }
  // 벽시계는 **멈춤 방지** 상한일 뿐이다(판별은 위 시도 횟수). 50ms 예산에 러너 스케줄링 지연이 얹혀
  // 맥 CI 에서 290ms 까지 나왔다 — 그 사례에 경계가 붙지 않도록 넉넉히 둔다. 1초를 넘으면 그건
  // 지연이 아니라 동기 대기(Atomics.wait)가 예산 밖에서 돌았다는 뜻이다.
  expect(elapsed, '종료 경로가 1초 넘게 main 스레드를 세웠다 — 재시도 대기가 예산 밖에서 돌았다').toBeLessThan(1000)
  expect(svc.draft(root), '저장에 실패했는데 메모리 값까지 잃었다').toBe('쓰다 만 글')
  expect(existsSync(draft)).toBe(false)
  // 잠금이 풀리면 다음 flush 가 남긴다 — 예산을 줄인 것이 "덜 남긴다"는 뜻은 아니다.
  blocked = false
  svc.flushDrafts({ delaysMs: QUIT_FLUSH_DELAYS_MS })
  expect(readFileSync(draft, 'utf8')).toBe('쓰다 만 글')
  const again = Date.now()
  const writesBefore = writes
  svc.flushDrafts({ delaysMs: QUIT_FLUSH_DELAYS_MS })      // 남은 대기 없음 — 쓰기 시도 자체가 없다
  expect(writes - writesBefore, '남은 대기가 없는데 쓰기를 또 시도했다').toBe(0)
  expect(Date.now() - again).toBeLessThan(1000)            // 같은 이유 — 판별은 위 쓰기 시도 0회
})

test('저장 실패 진단에는 절대 경로·오류 본문이 아니라 이름과 코드만 남는다 (RT3 중요)', () => {
  // 검토 RT3 중요: 진단 파일은 Playwright 산출물로 CI 에 올라간다. `SafeWriteFs` 오류의
  // `message` 에는 논문 폴더 절대 경로와 토큰이 실릴 수 있었고, 예전 `fail()` 은 그 문자열과
  // `${file}`(절대 경로)을 그대로 남겼다 — 실제로 마커가 파일에 닿는 것을 검토가 관측했다.
  const dir = mkdtempSync(join(tmpdir(), 'kd-safe-diag-'))
  const log = join(dir, 'app-log.txt')
  const before = process.env.KNUAF_APP_LOG
  process.env.KNUAF_APP_LOG = log
  try {
    const marker = 'MARKER-papers-9c1f'
    const file = `/Users/${marker}/논문/chat.json`
    const fs: SafeWriteFs = {
      writeFileSync: (() => { throw Object.assign(new Error(`EACCES: denied /Users/${marker} token=sk-MARKERTOKEN000000000000000000000000`), { code: 'EACCES' }) }) as unknown as SafeWriteFs['writeFileSync'],
      renameSync: (() => {}) as unknown as SafeWriteFs['renameSync'],
      unlinkSync: (() => {}) as unknown as SafeWriteFs['unlinkSync'],
      readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    }
    const shown: string[] = []
    const r = writeFileAtomic(file, 'BODY', { fs, delaysMs: NO_WAIT, log: (m) => shown.push(m) })
    expect(r.ok).toBe(false)
    const text = readFileSync(log, 'utf8')
    expect(text, '진단이 아예 기록되지 않았다').toContain('safeWrite:')
    expect(text, '절대 경로가 진단 파일에 닿았다').not.toContain(marker)
    expect(text, '오류 본문의 토큰이 진단 파일에 닿았다').not.toContain('MARKERTOKEN')
    // 남아야 하는 것: 파일 이름과 오류 코드(그게 진단의 목적이다).
    expect(text).toContain('chat.json')
    expect(text).toContain('code=EACCES')
    // 화면 로그(stderr)도 같은 규칙이다 — 여기는 `scrub` 이 아니라 **경로를 넣지 않는 것**으로 막는다.
    expect(shown.join('\n'), '화면 로그가 절대 경로를 그대로 읽었다').not.toContain(marker)
    expect(shown.join('\n'), '화면 로그가 오류 본문을 그대로 읽었다').not.toContain('MARKERTOKEN')
    expect(shown.join('\n')).toContain('chat.json')
  } finally {
    if (before === undefined) delete process.env.KNUAF_APP_LOG
    else process.env.KNUAF_APP_LOG = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('초안 rename 이 막히면 .tmp 에 남고, 다음 실행이 되살려 제자리로 옮긴다', () => {
  const { root, draft } = project()
  writeFileSync(draft, '예전 글')
  const svc = service(() => {}, faultyFs({ rename: eperm, write: (p) => (p === draft ? 'partial' : null) }))
  svc.setDraft(root, '새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  svc.flushDrafts()
  expect(readFileSync(draft, 'utf8'), '대상을 직접 덮었다').toBe('예전 글')
  expect(existsSync(draft + '.tmp'), '최신 글을 남기지 않았다').toBe(true)

  const again = service(() => {})
  expect(again.draft(root)).toBe('새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  again.flushDrafts()                                     // 되살린 값을 제자리로
  expect(readFileSync(draft, 'utf8')).toBe('새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  expect(existsSync(draft + '.tmp')).toBe(false)
})
