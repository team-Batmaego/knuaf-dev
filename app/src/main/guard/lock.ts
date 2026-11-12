/**
 * guard/lock.ts — 폴더별 **기다리는** 비동기 큐
 *
 * 보관본을 만지는 다섯 호출자(T0, T2, [규칙으로 기억] 저장, [지우기], 터미널 도우미 띄우기)가
 * 이 큐에서 차례를 기다린다(§11.8 '지킴이와의 관계', 정제 R6).
 * - 던지는 잠금이면 T0·T2가 실패한다 — **기다린다**.
 * - 같은 비동기 문맥 안에서 다시 부르면 그대로 이어서 돈다(교착 방지).
 * - 이 잠금은 도우미의 파일 쓰기까지 막지는 못한다. 그래서 앱이 쓰는 순서는 디스크를 믿지 않는다.
 *
 * 전송의 폴더 잠금(`service.ts`의 `acquire(root)`)과는 **별개**다 — 단추는 질의가 도는 중에도
 * 눌려야 한다.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'

interface Slot {
  tail: Promise<void>
  pending: number
}

const slots = new Map<string, Slot>()
const held = new AsyncLocalStorage<string>()

function slotFor(key: string): Slot {
  const existing = slots.get(key)
  if (existing) return existing
  const created: Slot = { tail: Promise.resolve(), pending: 0 }
  slots.set(key, created)
  return created
}

/** 이 폴더에 지금 줄이 서 있는가(대기자 포함). 단추는 이것만 확인하고 큐에 들어간다. */
export function busy(root: string): boolean {
  return (slots.get(resolve(root))?.pending ?? 0) > 0
}

/** 대기 중인 호출자 수(시험·진단용). */
export function pendingCount(root: string): number {
  return slots.get(resolve(root))?.pending ?? 0
}

/**
 * 폴더 잠금을 잡고 `fn`을 돈다. 앞선 호출자가 끝나야 시작한다.
 * `fn`이 던지면 잠금은 풀리고 그대로 던진다.
 */
export async function withGuardLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const key = resolve(root)
  if (held.getStore() === key) return await fn()

  const slot = slotFor(key)
  slot.pending += 1
  const previous = slot.tail
  const gate = Promise.withResolvers<void>()
  slot.tail = previous.then(() => gate.promise).then(() => undefined)
  try {
    await previous
    return await held.run(key, async () => await fn())
  } finally {
    gate.resolve()
    slot.pending -= 1
    if (slot.pending === 0 && slots.get(key) === slot) slots.delete(key)
  }
}

/** 시험 사이 상태를 비운다. 실행 중인 호출자가 있으면 쓰지 않는다. */
export function resetGuardLocks(): void {
  slots.clear()
}
