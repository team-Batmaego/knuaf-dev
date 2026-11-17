/**
 * 무료 중계(DS·GLM) 출입증 — **릴리스 빌드에서만** 값이 박힌다.
 *
 * 값의 출처는 빌드 시점 define(`electron.vite.config.ts` 의 `main.define`)이다. 그 값은
 * `process.env.KNUAF_FREE_RELAY_TOKEN` 이고, 저장소가 공개이므로 그 환경값은 태그 릴리스
 * 워크플로(`.github/workflows/release.yml`)에만 넘긴다 — 로컬·PR 빌드에는 없다.
 *
 * 왜 define 인가: 런타임에 `process.env` 를 읽으면 학생 PC의 환경값이 실행 경로를 바꿀 수 있고,
 * "릴리스 빌드에만 넣는다"는 조건이 코드 주석이 아니라 실제 산출물 차이가 아니게 된다. define 은
 * 메인 묶음에만 적용되므로 렌더러 번들에는 문자열조차 들어가지 않는다(워크플로가 산출물로 확인한다).
 *
 * 형식은 중계가 받는 모양 그대로다(`knuaf-free-relay/src/tokens.mjs` `parseTokenHeader`):
 * `kf1_` + base64url 43자. 어긋나면 null — 반쯤 맞는 값을 중계로 보내 401 을 받느니 닫는다.
 */
const PREFIX = 'kf1_'
/** 32바이트 base64url 의 길이. */
const BODY_LEN = 43
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** 빌드 define 이 넣는 값. define 이 없으면(단위 시험·스크립트) 바인딩 자체가 없다. */
declare const __KNUAF_FREE_TOKEN__: string | undefined

/**
 * 값 하나를 검사한다 — 맞으면 그대로, 아니면 null.
 *
 * `trim()` 은 앞뒤 공백만 지운다. 시크릿을 CLI 로 등록하면 끝에 개행이 붙는 일이 흔하고,
 * 그것 하나로 무료 회사가 통째로 막히면 원인이 화면에 안 보인다.
 */
export function freeTokenOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  if (token.length !== PREFIX.length + BODY_LEN || !token.startsWith(PREFIX)) return null
  return BASE64URL.test(token.slice(PREFIX.length)) ? token : null
}

/**
 * 빌드 define 에 넣을 **JS 식 문자열**. `electron.vite.config.ts` 가 `main.define` 에서 부른다.
 *
 * 여기 두는 이유: 빌드 시점 값과 실행 시점 검사가 같은 형식 규칙을 쓰게 하려고. 갈라지면
 * 모양이 틀린 값이 define 에는 실리고 런타임에는 null 이 되어 원인이 빌드 로그에 안 남는다.
 * 틀린 값은 **빈 문자열로 접어** define 에 넣는다 — 그 편이 앱이 그 값을 아예 모르게 한다.
 */
export function freeRelayTokenDefine(env: NodeJS.ProcessEnv = process.env): string {
  return JSON.stringify(freeTokenOf(env.KNUAF_FREE_RELAY_TOKEN) ?? '')
}

/**
 * 앱이 쓸 무료 중계 출입증. 없거나 모양이 틀리면 `null` — 부르는 쪽(메인 배선)은 그때 무료
 * 회사를 '쓸 수 없음'으로 닫고, 다른 회사로 조용히 바꾸지 않는다.
 */
export function freeRelayToken(): string | null {
  // `typeof` 로 읽는 이유: define 이 없는 실행(단위 시험·개발 스크립트)에서 bare 참조는
  // ReferenceError 다. define 이 있으면 이 식은 문자열 리터럴 검사로 접힌다.
  return freeTokenOf(typeof __KNUAF_FREE_TOKEN__ === 'string' ? __KNUAF_FREE_TOKEN__ : '')
}
