/**
 * figures/storage.ts — 앱 전용 저장소(`KNUAF_FIGURE_HOME`)의 경로·원자적 쓰기·계수 (R4-1, 계약 §2)
 *
 * 앱은 **논문 폴더에 아무것도 쓰지 않는다**. 받은 원본·다시 구운 PNG·결과·증명·후보표·계수가 모두
 * 여기에만 있다. 파이썬은 여기를 읽기만 한다.
 *
 * 쓰기는 전부 `tmp/… → rename`이다: 파이썬이 반쯤 쓴 JSON을 읽으면 "형식이 깨졌다"로 요청이
 * 사라진다. 이름 바꾸기는 같은 파일시스템 안에서 원자적이다.
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface FigurePaths {
  home: string
  channel: string
  turn: string
  res: string
  store: string
  receipts: string
  choices: string
  tmp: string
  counters: string
}

export function figurePaths(home: string): FigurePaths {
  return {
    home,
    channel: join(home, 'figure-channel.json'),
    turn: join(home, 'turn.json'),
    res: join(home, 'res'),
    store: join(home, 'store'),
    receipts: join(home, 'receipts.jsonl'),
    choices: join(home, 'choices'),
    tmp: join(home, 'tmp'),
    counters: join(home, 'counters.json')
  }
}

/** 폴더 realpath의 sha256 **앞 16자**(hex). 계약 §2. */
export function folderHash(folderRealpath: string): string {
  return createHash('sha256').update(folderRealpath, 'utf8').digest('hex').slice(0, 16)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 앱 시작 때 디렉터리를 만들고 tmp를 비운다(§4-4: 남은 원본은 버린다). */
export async function prepareHome(paths: FigurePaths): Promise<void> {
  for (const dir of [paths.res, paths.store, paths.choices, paths.tmp]) {
    await mkdir(dir, { recursive: true })
  }
  await rm(paths.tmp, { recursive: true, force: true })
  await mkdir(paths.tmp, { recursive: true })
}

/**
 * 원자적 쓰기: 같은 디렉터리의 임시 이름에 쓰고 rename. 실패하면 임시 파일을 지운다.
 * **목적지가 있으면 덮는다** — "먼저 남긴 것이 정본"인 자리는 `writeNew`를 쓴다.
 */
export async function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value)}\n`)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * 배타 생성: 없을 때만 쓰고 `true`, 이미 있으면 **아무것도 하지 않고** `false` (I-1).
 *
 * `writeAtomic`은 임시 이름에 `wx`를 쓴 뒤 `rename`하므로, 목적지가 있으면 조용히 덮는다. 결과
 * 파일처럼 "먼저 남긴 것이 정본"인 자리는 이 함수를 쓴다 — 검사와 생성을 한 syscall로 묶는다.
 */
export async function writeNew(path: string, data: string | Uint8Array, mode = 0o600): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  let handle: FileHandle
  try {
    handle = await open(path, 'wx', mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/** `writeNew`의 JSON 판. 이미 있으면 `false`. */
export async function writeJsonNew(path: string, value: unknown): Promise<boolean> {
  return writeNew(path, `${JSON.stringify(value)}\n`)
}

/** 덧붙이기만 하는 증명 한 줄. 개행까지 같이 써서 반쪽 줄이 섞이지 않게 한다. */
export async function appendLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 저장소 PNG 크기(바이트). 없으면 0. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export interface Counters {
  v: 1
  /** UTC 날짜 `YYYY-MM-DD`. 하루 파일 수는 이 값이 바뀌면 0으로 시작한다. */
  day: string
  filesToday: number
  /** 폴더해시 → 이 폴더 때문에 저장된 바이트 합계. */
  folders: Record<string, number>
}

export const DAILY_FILE_LIMIT = 200
export const FOLDER_BYTE_LIMIT = 200 * 1024 * 1024

export function emptyCounters(day: string): Counters {
  return { v: 1, day, filesToday: 0, folders: {} }
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export async function loadCounters(path: string, now: number): Promise<Counters> {
  const raw = await readJson<Counters>(path)
  const day = utcDay(now)
  if (!raw || raw.v !== 1 || typeof raw.day !== 'string') return emptyCounters(day)
  const folders: Record<string, number> = {}
  if (raw.folders && typeof raw.folders === 'object') {
    for (const [key, value] of Object.entries(raw.folders)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) folders[key] = value
    }
  }
  return {
    v: 1,
    day,
    filesToday: raw.day === day && Number.isFinite(raw.filesToday) ? Math.max(0, raw.filesToday) : 0,
    folders
  }
}

export type QuotaProblem = 'daily_files' | 'folder_bytes'

/** 저장 하나를 허용할지. 계수는 저장이 성공한 뒤에 올린다(실패한 시도가 하루치를 먹지 않게). */
export function checkQuota(counters: Counters, hash: string, addBytes: number): QuotaProblem | null {
  if (counters.filesToday >= DAILY_FILE_LIMIT) return 'daily_files'
  if ((counters.folders[hash] ?? 0) + addBytes > FOLDER_BYTE_LIMIT) return 'folder_bytes'
  return null
}

export function chargeQuota(counters: Counters, hash: string, addBytes: number): Counters {
  return {
    ...counters,
    filesToday: counters.filesToday + 1,
    folders: { ...counters.folders, [hash]: (counters.folders[hash] ?? 0) + addBytes }
  }
}
