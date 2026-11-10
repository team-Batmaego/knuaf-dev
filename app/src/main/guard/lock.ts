/**
 * guard/lock.ts — 폴더별 비동기 뮤텍스(큐)
 *
 * 같은 폴더에 동시에 Claude·Codex 전송을 막기 위한 잠금 장치.
 * T0·T2는 물론 단추 저장(IPC)·규칙 삭제(IPC)·터미널 도우미 실행(`agent:launch`)
 * 등 모든 경로가 이 뮤텍스를 거쳐야 한다(§11.8 '지킴이와의 관계').
 *
 * 구현: Node 메모리 기반 큐. 실제 프로덕션에서는 service.ts의 전역 뮤텍스와 연동된다.
 * 각 root 폴더별로 잠금 상태와 대기자 큐를 관리한다.
 */

// root당 잠금 상태와 대기자 resolvers 관리
const lockHolders: Map<string, boolean> = new Map()
const waitQueue: Map<string, Array<{ resolve: () => void }>> = new Map()

/** 지정된 root 폴더에 대한 잠금 획득 */
export function acquireGuardLock(root: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const key = root

    // 대기자 큐 초기화
    if (!waitQueue.has(key)) {
      waitQueue.set(key, [])
    }

    const waiters = waitQueue.get(key)!

    // 이미 잠금이 잡혀 있으면 대기열에 추가
    if (lockHolders.has(key)) {
      // 대기자에게 resolve 호출될 때까지 대기
      waiters.push({ resolve })
      // 다음 순차 실행을 위해 즉시 재귀 확인
      attemptNext(key, waiters)
      return
    }

    // 잠금 획득
    lockHolders.set(key, true)
    resolve()
  })
}

/** 다음 대기자 실행 시도 */
function attemptNext(key: string, waiters: Array<{ resolve: () => void }>): void {
  if (waiters.length === 0) return

  const next = waiters.shift!

  // 현재 잠금이 해제되었는지 확인 후 다음 대기자에게 진행
  if (!lockHolders.has(key)) {
    // 잠금이 풀린 경우: 다음 대기자에게 resolve 호출
    next()
    attemptNext(key, waiters)
  } else {
    // 여전히 잠금 상태: 다음 사이클에 재시도
    setTimeout(() => attemptNext(key, waiters), 10)
  }
}

/** 잠금 해제 */
export function releaseGuardLock(root: string): void {
  lockHolders.delete(root)

  // 해당 root의 대기자들 중 첫 번째 resolve 호출
  const waiters = waitQueue.get(root)
  if (waiters && waiters.length > 0) {
    const next = waiters.shift()
    if (next) {
      next.resolve()
    }
  }
}