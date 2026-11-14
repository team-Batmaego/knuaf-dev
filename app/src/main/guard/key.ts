/**
 * guard/key.ts — 지킴이 무결성 열쇠(HMAC)를 OS 보관소(Electron `safeStorage`)에 두고 꺼낸다.
 *
 * 설계 §4.3 '무결성의 범위'·§16 '무결성 표식': 열쇠는 OS 보관소에 있고, **열쇠를 못 쓰면
 * 표식 없이 가지 않는다** — 상태 파일의 유무와 무관하게 지킴이는 꺼짐이 기본이다(C4).
 *
 * 이 모듈은 Electron 을 import 하지 않는다. `safeStorage` 는 어댑터로 받는다 —
 * 단위 시험이 Electron 없이 돌고, 실패 갈래(암호화 불가·복호화 실패·모양 이상)를 전부
 * 같은 자리에서 닫기 위해서다. 어댑터를 넘기는 곳은 `ipc.ts` 하나뿐이다.
 *
 * 열쇠 파일: `<userData>/guard/key.bin`, 내용은 `safeStorage.encryptString(<base64 열쇠>)`.
 * 32바이트 난수 → base64(문자) → 암호화(바이트) 순서라 `encryptString` 계약(문자열 입력)을 지킨다.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardStoreDir } from './scope'
import type { GuardKey } from './store'

/** 열쇠 길이(바이트). HMAC-SHA256 의 권장 최소 길이를 넘긴다. */
const KEY_BYTES = 32

/** Electron `safeStorage` 중 이 모듈이 쓰는 세 메서드만. */
export interface KeyVault {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 열쇠 파일 자리. 보관본 폴더 안이라 §11.8 의 쓰기 금지 대상과 같은 곳이다. */
export function guardKeyPath(userData: string): string {
  return join(guardStoreDir(userData), 'key.bin')
}

/**
 * 열쇠를 꺼낸다. 없으면 새로 만들어 저장한다.
 *
 * 돌려주는 `null` 은 **'열쇠 없음'** 하나뜻이고, 부르는 쪽은 그대로 지킴이를 끈다:
 * ① OS 암호화를 못 쓴다(`isEncryptionAvailable()` false — 맥 키체인 잠김·윈도우 DPAPI 불가)
 * ② 열쇠 파일이 있는데 복호화가 안 된다(다른 계정·다른 컴퓨터·손상) ③ 파일을 쓸 수 없다.
 *
 * ②에서 **새 열쇠로 덮어쓰지 않는다.** 덮어쓰면 그 컴퓨터의 보관본·전송 장부 표식이 전부
 * 불일치가 되어 지킴이가 조용히 꺼지고, 학생 파일을 되돌릴 근거도 사라진다. 이 실행만
 * 메모리 장부로 이어지고 다음 실행이 다시 시도한다.
 */
export function loadGuardKey(userData: string, vault: KeyVault | undefined): GuardKey {
  if (!vault) return null
  let available = false
  try {
    available = vault.isEncryptionAvailable()
  } catch {
    return null
  }
  if (!available) return null

  const path = guardKeyPath(userData)
  let stored: Buffer | null = null
  try {
    stored = readFileSync(path)
  } catch (e) {
    // 파일이 없는 것만 '첫 실행'이다. 그 밖(권한·폴더 자리)은 열쇠를 새로 만들면 안 된다.
    if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }

  if (stored) {
    try {
      const text = vault.decryptString(stored)
      return decodeKey(text)
    } catch {
      return null
    }
  }
  return createKey(userData, vault)
}

/** base64 → 32바이트. 길이가 다르면 열쇠로 쓰지 않는다(모양이 깨진 값으로 서명하지 않는다). */
function decodeKey(text: string): GuardKey {
  const buf = Buffer.from(text, 'base64')
  return buf.length === KEY_BYTES ? buf : null
}

/** 새 열쇠를 만들어 저장한다. 저장에 실패하면 이 실행도 열쇠 없이 간다(표식 없이 가지 않는다). */
function createKey(userData: string, vault: KeyVault): GuardKey {
  const key = randomBytes(KEY_BYTES)
  const path = guardKeyPath(userData)
  try {
    mkdirSync(guardStoreDir(userData), { recursive: true, mode: 0o700 })
    // `wx` — 이미 있으면 덮어쓰지 않고 실패한다. 경합으로 방금 생긴 남의 열쇠를 우리 것으로
    // 바꾸면 그 컴퓨터의 표식이 전부 불일치가 되므로, 그럴 때는 이 실행만 열쇠 없이 간다.
    writeFileSync(path, vault.encryptString(key.toString('base64')), { mode: 0o600, flag: 'wx' })
    return key
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return null
    // 쓰다 만 파일이 남으면 다음 실행이 '복호화 실패'로 열쇠를 영영 못 얻는다 — 지운다.
    try { rmSync(path, { force: true }) } catch { /* 남아도 위 '복호화 실패' 갈래가 닫는다 */ }
    return null
  }
}
