/**
 * 폴더별 kordoc MCP 수명(설계 §3.2 '언제'·'실패 시', §3.3 실패 처분).
 *
 * 규칙 네 가지가 이 파일의 전부다.
 * 1. 폴더의 **첫 `send()`**에서만 확인한다(`status()`·온보딩·`connect-probe`는 타지 않는다) — 호출자가 지킨다.
 * 2. 성공한 사양만 캐시한다. **실패는 캐시하지 않는다** — 다음 `send()`가 다시 시도한다.
 * 3. 실패 안내 줄은 폴더당 1회.
 * 4. 안전 검증에 실패한 폴더는 이 프로세스가 살아 있는 동안 다시 열지 않는다(`mcpDisabled`).
 *
 * `ensureKordoc`(③이 정한 런타임을 가져오는 함수)와 `note`(시스템 줄)는 주입된다 — 이 모듈은
 * 프로세스를 띄우지도, 화면을 알지도 않는다.
 */
import type { KordocFs, KordocMcpSpec, KordocRuntime, KordocAttachFailure } from './kordocMcp'
import { resolveKordocMcp, rootKey } from './kordocMcp'

export interface KordocMcpRegistryDeps {
  /** 폴더 → 런타임. 실패는 `null` 또는 예외(둘 다 "이번엔 못 붙었다"로 같다). */
  ensureKordoc: (root: string) => Promise<KordocRuntime | null>
  /** 앱이 학생에게 직접 하는 말 — 이번 판은 미부착 안내 한 줄뿐이다. */
  note?: (text: string) => void
  fs?: KordocFs
}

/** 미부착 이유 → 안내 문장 조각. 이유를 모르면 일반 문장으로 닫는다. */
const FAILURE_REASON: Record<KordocAttachFailure, string> = {
  'no-runtime': 'kordoc을 찾지 못했어요',
  'old-version': '깔린 kordoc 판이 오래됐어요',
  'no-node': 'kordoc을 실행할 프로그램을 정하지 못했어요',
  'shuttle': 'kordoc 실행 파일이 직접 실행할 수 있는 형태가 아니에요',
  'bad-root': '논문 폴더 경로를 확인하지 못했어요'
}

/** 설계 §3.2 '실패 시'의 문장 그대로. (이유)만 바뀐다. */
export function attachFailureNote(reason: KordocAttachFailure | null): string {
  const detail = reason ? FAILURE_REASON[reason] : 'kordoc을 확인하지 못했어요'
  return `한글 문서 읽기 도구를 붙이지 못했어요(${detail}). 문서 읽기는 스킬의 스크립트로만 돼요.`
}

export class KordocMcpRegistry {
  /** 성공만 담는다(폴더 키 = realpath). */
  private specs = new Map<string, KordocMcpSpec>()
  /** 실패 안내를 이미 말한 폴더. */
  private notified = new Set<string>()
  /** 안전 검증에 실패해 이 프로세스에서 닫아 둔 폴더(`mcpDisabled`). */
  private disabled = new Set<string>()

  constructor(private deps: KordocMcpRegistryDeps) {}

  private key(root: string): string {
    return rootKey(root, this.deps.fs)
  }

  /** 폴더의 MCP 사양. 붙일 수 없으면 `null` — 호출자는 MCP 없이 대화를 계속한다. */
  async acquire(root: string): Promise<KordocMcpSpec | null> {
    const key = this.key(root)
    if (this.disabled.has(key)) return null
    const cached = this.specs.get(key)
    if (cached) return cached

    let runtime: KordocRuntime | null
    try {
      runtime = await this.deps.ensureKordoc(root)
    } catch {
      this.reportOnce(key, null)
      return null
    }
    const resolution = resolveKordocMcp(runtime, root, this.deps.fs)
    if (!resolution.ok) {
      this.reportOnce(key, resolution.reason)
      return null
    }
    this.specs.set(key, resolution.spec)
    return resolution.spec
  }

  /**
   * 안전 검증 실패 처분(§3.3). 성공 캐시도 지운다 — 이 폴더는 이 프로세스에서 영원히 미부착이고,
   * 다시 켜는 시도는 다음 앱 실행 때다.
   */
  disable(root: string): void {
    const key = this.key(root)
    this.disabled.add(key)
    this.specs.delete(key)
  }

  isDisabled(root: string): boolean {
    return this.disabled.has(this.key(root))
  }

  private reportOnce(key: string, reason: KordocAttachFailure | null): void {
    if (this.notified.has(key)) return
    this.notified.add(key)
    this.deps.note?.(attachFailureNote(reason))
  }
}