/**
 * figures/turn.ts — 지금 도는 메인 턴 하나를 파일로 고정한다 (설계 R4-6, I-01)
 *
 * 요청은 "앱이 지금 연 논문 폴더의 메인 대화 턴"에만 유효하다. 앱이 턴 시작에 `turn.json`을 쓰고
 * 끝에 지우므로, 스크립트는 그 `turnId`를 요청에 넣고 앱은 **같은 turnId + 같은 폴더**일 때만 받는다.
 * v0.7 담당(relay)에는 `KNUAF_FIGURE_HOME`을 주지 않으므로 그쪽 스크립트는 통로 없음으로 즉시 실패한다.
 *
 * 턴 중단·폴더 전환·앱 재시작에서 남은 요청은 `stale`이 된다 — 이 파일이 사라졌거나 turnId가 다르기
 * 때문이다. 그 판단이 디스크 상태 하나로 끝나는 게 이 설계의 요점이다.
 */

import { rm } from 'node:fs/promises'
import { readJson, writeJson } from './storage'

export interface TurnRecord {
  v: 1
  turnId: string
  folder: string
  startedAt: number
}

export function isTurnRecord(value: unknown): value is TurnRecord {
  if (!value || typeof value !== 'object') return false
  const turn = value as Partial<TurnRecord>
  return (
    turn.v === 1 &&
    typeof turn.turnId === 'string' &&
    turn.turnId.length > 0 &&
    typeof turn.folder === 'string' &&
    turn.folder.length > 0 &&
    typeof turn.startedAt === 'number'
  )
}

/** 턴 시작. `folder`는 논문 폴더 realpath. */
export async function beginTurn(path: string, turnId: string, folder: string, now = Date.now()): Promise<void> {
  await writeJson(path, { v: 1, turnId, folder, startedAt: now } satisfies TurnRecord)
}

/** 턴 끝·중단. 없는 파일을 지우는 것도 정상이다. */
export async function endTurn(path: string): Promise<void> {
  await rm(path, { force: true })
}

export async function readTurn(path: string): Promise<TurnRecord | null> {
  const value = await readJson<TurnRecord>(path)
  return isTurnRecord(value) ? value : null
}

export type TurnCheck =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'cancelled' }

/** 요청의 turnId가 지금 턴과 같은가. 턴이 없으면 stale이 아니라 cancelled(앱이 닫힌 상태). */
export function checkTurn(turn: TurnRecord | null, requestTurnId: string): TurnCheck {
  if (!turn) return { ok: false, reason: 'cancelled' }
  if (turn.turnId !== requestTurnId) return { ok: false, reason: 'stale' }
  return { ok: true }
}
