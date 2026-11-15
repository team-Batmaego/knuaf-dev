/**
 * §4.3 '무결성의 범위'·§16 '무결성 표식' — 지킴이 열쇠(`guard/key.ts`).
 *
 * OS 보관소(`safeStorage`)는 어댑터로 갈음한다 — 이 시험은 Electron 없이 돈다.
 * 닫는 쪽(열쇠 없음 → 지킴이 꺼짐)이 기본이고, 남의 열쇠를 덮어쓰지 않는다는 것이 핵심이다.
 */
import { test, expect, afterAll } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardKeyPath, loadGuardKey, type KeyVault } from '../src/main/guard/key'
import { loadState, saveState, defaultState } from '../src/main/guard/store'

const made: string[] = []
function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-key-'))
  made.push(dir)
  return dir
}
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** 되돌릴 수 있는 가짜 암호화 — 평문이 파일에 그대로 남지 않는다는 것까지 확인하려고 접두어를 붙인다. */
function vault(overrides: Partial<KeyVault> = {}): KeyVault {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.concat([Buffer.from('enc:', 'utf-8'), Buffer.from(plain, 'utf-8')]),
    decryptString: (encrypted) => {
      const head = encrypted.subarray(0, 4).toString('utf-8')
      if (head !== 'enc:') throw new Error('bad ciphertext')
      return encrypted.subarray(4).toString('utf-8')
    },
    ...overrides
  }
}

test('열쇠: OS 암호화를 못 쓰면 열쇠 없음이고 파일도 만들지 않는다', () => {
  const dir = userData()
  const key = loadGuardKey(dir, vault({ isEncryptionAvailable: () => false }))
  expect(key).toBeNull()
  expect(() => readFileSync(guardKeyPath(dir))).toThrow()
})

test('열쇠: 어댑터 자체가 없어도(맥 키체인 없는 환경) 열쇠 없음이다', () => {
  expect(loadGuardKey(userData(), undefined)).toBeNull()
})

test('열쇠: 첫 실행은 32바이트 열쇠를 만들어 저장하고, 다시 읽으면 같은 값이다', () => {
  const dir = userData()
  const first = loadGuardKey(dir, vault())
  expect(first).not.toBeNull()
  expect(first?.length).toBe(32)
  const onDisk = readFileSync(guardKeyPath(dir))
  // 암호문이 저장된다 — 평문(base64 열쇠)이 파일에 그대로 있으면 보관소를 쓰는 뜻이 없다.
  expect(onDisk.includes(first as Buffer)).toBe(false)
  const second = loadGuardKey(dir, vault())
  expect(second?.equals(first as Buffer)).toBe(true)
  // 매번 새 열쇠를 만들면 표식이 전부 불일치가 된다 — 파일 바이트도 그대로다.
  expect(readFileSync(guardKeyPath(dir)).equals(onDisk)).toBe(true)
})

test('열쇠: 파일이 보관본 폴더(`<userData>/guard/key.bin`)에 있다', () => {
  const dir = userData()
  loadGuardKey(dir, vault())
  expect(guardKeyPath(dir)).toBe(join(dir, 'guard', 'key.bin'))
  expect(readFileSync(join(dir, 'guard', 'key.bin')).length).toBeGreaterThan(0)
})

test('열쇠: 복호화가 안 되면 열쇠 없음이고 파일을 **덮어쓰지 않는다**', () => {
  const dir = userData()
  mkdirSync(join(dir, 'guard'), { recursive: true })
  writeFileSync(guardKeyPath(dir), Buffer.from('다른 컴퓨터의 열쇠', 'utf-8'))
  const before = readFileSync(guardKeyPath(dir))
  expect(loadGuardKey(dir, vault())).toBeNull()
  expect(readFileSync(guardKeyPath(dir)).equals(before)).toBe(true)
})

test('열쇠: 복호화된 값이 32바이트가 아니면 열쇠로 쓰지 않는다', () => {
  const dir = userData()
  mkdirSync(join(dir, 'guard'), { recursive: true })
  writeFileSync(guardKeyPath(dir), Buffer.from('enc:short', 'utf-8'))
  expect(loadGuardKey(dir, vault())).toBeNull()
})

test('열쇠: 만든 열쇠로 상태를 저장하면 표식이 맞고, 다른 열쇠로는 불일치다', () => {
  const dir = userData()
  const key = loadGuardKey(dir, vault())
  expect(key).not.toBeNull()
  const state = { ...defaultState(), rules: [] }
  expect(saveState(dir, 'folder-a', state, key)).toBe(true)
  expect(loadState(dir, 'folder-a', key).integrity).toBe('ok')
  expect(loadState(dir, 'folder-a', Buffer.alloc(32)).integrity).toBe('mismatch')
  expect(loadState(dir, 'folder-a', null).integrity).toBe('no-key')
})
