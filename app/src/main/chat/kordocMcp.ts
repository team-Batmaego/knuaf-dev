/**
 * kordoc MCP의 **명세·정책 순수 모듈**. 이 파일은 프로세스를 띄우지 않고 네트워크도 쓰지 않는다 —
 * 연결 단계(v0.6.0 뒤)가 여기 값을 그대로 꽂는다.
 *
 * 정본: `2026-11-03-kordoc-mcp-design/DESIGN.md` r3b §3.2(실행 사양)·§3.3(공급자 설정)·§3.4(도구 정책).
 *
 * 두 겹의 울타리 중 **앱 쪽**(`mcpPolicy`)만 여기 있다. 서버 쪽 울타리는 `KORDOC_ROOT` 환경변수이며
 * `resolveKordocMcp`가 `realpathSync(root)`로 만든다 — 앱과 서버의 선을 같게 유지해야
 * "학생이 허용했는데 서버가 거절"하는 모순이 생기지 않는다.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** 이 단계(S1)에서 여는 순수 읽기 도구 10개. 파일을 만들거나 바꾸지 않는다. */
export const READ_TOOLS = [
  'parse_document', 'detect_format', 'parse_metadata', 'parse_pages', 'parse_table',
  'compare_documents', 'parse_chunks', 'parse_form', 'lint_document', 'agency_pack_info'
] as const

/**
 * 닫아 두는 도구 12개(선택 쓰기 `fill_form`·`extract_tables` 포함).
 * 이름이 붙은 이유: Claude는 `disallowedTools`, 앱 정책은 허용 목록으로 같은 집합을 막는다.
 */
export const WRITE_TOOLS = [
  'fill_form', 'extract_tables', 'place_seal', 'add_memo', 'patch_document', 'redact_document',
  'render_document', 'crop_regions', 'extract_profile', 'generate_document', 'build_agency_pack', 'convert_to_hwpx'
] as const

export type ReadTool = (typeof READ_TOOLS)[number]

/**
 * 읽기 도구의 경로 인자(4.24.x 실측, §3.4 표). `lint_document`는 경로 없이 `text`/`blocks`만으로도
 * 호출될 수 있어 `file_path`가 선택이다. 표에 없는 도구는 정책이 거절한다 — 새 도구는 여기 추가 없이는 열리지 않는다.
 */
export const READ_TOOL_PATHS: Record<ReadTool, { required: readonly string[]; optional: readonly string[] }> = {
  parse_document: { required: ['file_path'], optional: [] },
  detect_format: { required: ['file_path'], optional: [] },
  parse_metadata: { required: ['file_path'], optional: [] },
  parse_pages: { required: ['file_path'], optional: [] },
  parse_table: { required: ['file_path'], optional: [] },
  compare_documents: { required: ['file_path_a', 'file_path_b'], optional: [] },
  parse_chunks: { required: ['file_path'], optional: [] },
  parse_form: { required: ['file_path'], optional: [] },
  lint_document: { required: [], optional: ['file_path'] },
  agency_pack_info: { required: ['pack_path'], optional: [] }
}

/** `KORDOC_ROOT` 울타리와 읽기 8개를 실측으로 확인한 최저판(§3.2 판 하한). */
export const MIN_KORDOC_VERSION = '4.17.1'

/** 서버 이름 — 도구 접두(`mcp__kordoc__`)·Codex 설정 키(`mcp_servers.kordoc`)와 같은 값이어야 한다. */
export const MCP_SERVER_NAME = 'kordoc'
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** Claude SDK `timeout`(ms) — §3.2 시간 상한. */
export const CLAUDE_MCP_TIMEOUT_MS = 120_000
/** Codex `startup_timeout_sec`·`tool_timeout_sec` — §3.2 시간 상한. */
export const CODEX_STARTUP_TIMEOUT_SEC = 20
export const CODEX_TOOL_TIMEOUT_SEC = 120

/** 거절 문구(모델에게 돌아간다). 문장을 바꾸면 모델이 "복사해 넣으라"는 안내를 잃는다. */
export const DENY_FOREIGN_MCP = '허용되지 않은 외부 도구예요'
export const DENY_NOT_READ = '이 단계에서는 한글 문서 읽기 도구만 쓸 수 있어요'
export const DENY_OUTSIDE_ROOT = '한글 문서 도구는 논문 폴더 안의 파일만 읽어요. 파일을 논문 폴더 안으로 복사해 주세요'

/**
 * §3.6 지시문. `mcpSpec`이 붙은 세션에서만 기존 문장(엑셀·문서 읽기 = 스킬 스크립트)을 이 문장으로 바꾼다.
 * 미부착 세션에 이 문장을 넣으면 없는 도구를 찾게 된다.
 * 끝의 OCR 문장은 설계 §3.6 밖의 추가다(책임자 결정): `ocr` 생략 호출이 PDF마다 ~1 GiB·30초를 쓰므로
 * 미요청 호출에 `ocr:false`를 명시하고, "텍스트 0자" 경고 때만 `ocr:true`로 1회 재시도하게 한다.
 */
export const LEGACY_DOC_READ_INSTRUCTION = '엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요.'
export const MCP_DOC_READ_INSTRUCTION = '한글 문서(HWP·HWPX)·PDF 읽기는 kordoc 도구(`parse_document`·`parse_table`·`compare_documents` 등)를 먼저 쓰고, 엑셀 읽기와 논문 HWPX 산출(`build_hwpx.py`)은 스킬의 스크립트를 쓰세요. 폴더 밖 파일은 도구가 거절해요. `parse_document`는 `ocr:false`를 꼭 넣어 부르고, 결과 글자가 0자라는 경고가 나올 때만 `ocr:true`로 한 번 더 부르세요.'

/**
 * kordoc 실행 환경 — **값은 v0.6.0 ③이 정한다**(Node 미동봉 유력안: kordoc 빌드 동봉 + Electron을
 * `ELECTRON_RUN_AS_NODE=1`로 실행). 이 모듈은 그 결과를 입력으로 받을 뿐 고르지 않는다.
 */
export interface KordocRuntime {
  /** kordoc을 돌릴 Node 실행 파일(또는 Electron을 Node로 쓰는 그 실행 파일). */
  node: string
  /** `…/dist/cli.js`. 셔틀(`.cmd`·셸 래퍼)이면 미부착이다. */
  cliJs: string
  /** `actual_version` 같은 판 문자열. */
  version: string
  /** ③이 요구하는 추가 환경변수(예: `ELECTRON_RUN_AS_NODE`). 울타리 두 키는 덮지 못한다. */
  extraEnv?: Record<string, string>
}

/** CLI에 넘기는 MCP 서버 실행 사양. */
export interface KordocMcpSpec {
  command: string
  args: string[]
  /** `KORDOC_ROOT`·`KORDOC_OFFLINE` + `extraEnv`. 비밀값 없음. */
  env: Record<string, string>
  /** 우리가 띄운 그 서버인지 기동 뒤 검증에서 대조하는 값. */
  version: string
}

/** 미부착 이유 — 실패 안내 문장을 고르는 데 쓴다. `provider` 는 사양은 만들었지만 공급자가 받지 못한 경우다. */
export type KordocAttachFailure = 'no-runtime' | 'old-version' | 'no-node' | 'shuttle' | 'bad-root' | 'provider'

export type KordocMcpResolution =
  | { ok: true; spec: KordocMcpSpec; reason: null }
  | { ok: false; spec: null; reason: KordocAttachFailure }

/** 파일시스템 이음매 — 시험이 임시 폴더를 직접 보게 하고, 실제 실행은 node:fs를 쓴다. */
export interface KordocFs {
  existsSync: (p: string) => boolean
  realpathSync: (p: string) => string
}

const NODE_FS: KordocFs = {
  existsSync: (p) => {
    try { return existsSync(p) } catch { return false }
  },
  realpathSync: (p) => realpathSync(p)
}

/** 판 비교용 3중 숫자. 접두 `v`·뒤 prerelease/build는 버린다 — 못 읽으면 null(하한 미달로 취급). */
export function parseVersion(version: unknown): [number, number, number] | null {
  if (typeof version !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** `version >= min`. 못 읽는 판은 **미달**이다 — 확인 못 한 판을 열지 않는다. */
export function versionAtLeast(version: unknown, min: string = MIN_KORDOC_VERSION): boolean {
  const a = parseVersion(version)
  const b = parseVersion(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/**
 * 그 판이 광고하는 읽기 도구(§3.3-3 기대 집합). 표에 없는 판은 `null` → 부분집합 조건만 쓴다.
 * 4.17.1 실측 17개 중 읽기 8개(`lint_document`·`agency_pack_info` 없음), 4.24.x 실측 22개 중 읽기 10개.
 */
export function advertisedReadTools(version: unknown): readonly ReadTool[] | null {
  const v = parseVersion(version)
  if (!v) return null
  if (v[0] === 4 && v[1] === 17 && v[2] === 1) return READ_TOOLS.filter((t) => t !== 'lint_document' && t !== 'agency_pack_info')
  if (v[0] === 4 && v[1] === 24) return [...READ_TOOLS]
  return null
}

/** 폴더를 가리키는 키. 존재하면 realpath, 아니면 해석한 그대로(시험·로그 키의 안정성). */
export function rootKey(root: string, fs: Pick<KordocFs, 'realpathSync'> = NODE_FS): string {
  try { return fs.realpathSync(root) } catch { return resolve(root) }
}

/**
 * `runtime`(③이 정한 값)과 논문 폴더에서 MCP 실행 사양을 만든다. 여기서 결정하는 것은 **형식**뿐이고
 * 실행 파일은 고르지 않는다.
 *
 * - 판 < 4.17.1 → 미부착(울타리·읽기 8개를 확인한 최저판).
 * - `cliJs`가 `.js`가 아니면(셔틀·셸 래퍼) 미부착 — 셔틀을 command로 넘기지 않는다.
 * - `dirname(cliJs)/mcp.js`가 있으면 그것을, 없으면 `[cliJs, 'mcp']` 부명령을 쓴다.
 * - `root`의 realpath를 못 구하면 미부착 — 울타리를 정확히 그을 수 없으면 열지 않는다.
 * - `extraEnv`를 먼저 깔고 `KORDOC_ROOT`·`KORDOC_OFFLINE`을 **덮어쓴다**(울타리가 extraEnv로 흔들리지 않게).
 */
export function resolveKordocMcp(
  runtime: KordocRuntime | null | undefined,
  root: string,
  fs: KordocFs = NODE_FS
): KordocMcpResolution {
  const fail = (reason: KordocAttachFailure): KordocMcpResolution => ({ ok: false, spec: null, reason })
  if (!runtime) return fail('no-runtime')
  if (!versionAtLeast(runtime.version)) return fail('old-version')
  if (typeof runtime.node !== 'string' || !runtime.node.trim()) return fail('no-node')
  if (typeof runtime.cliJs !== 'string' || !/\.js$/i.test(runtime.cliJs)) return fail('shuttle')
  let rootReal: string
  try { rootReal = fs.realpathSync(root) } catch { return fail('bad-root') }
  const sibling = join(dirname(runtime.cliJs), 'mcp.js')
  const args = fs.existsSync(sibling) ? [sibling] : [runtime.cliJs, 'mcp']
  return {
    ok: true,
    spec: {
      command: runtime.node,
      args,
      env: { ...(runtime.extraEnv ?? {}), KORDOC_ROOT: rootReal, KORDOC_OFFLINE: '1' },
      version: runtime.version
    },
    reason: null
  }
}

/** 계획서가 지정한 얇은 별칭 — 사양만 필요하고 이유는 필요 없는 호출자용. */
export function resolveKordocMcpSpec(
  runtime: KordocRuntime | null | undefined,
  root: string,
  fs: KordocFs = NODE_FS
): KordocMcpSpec | null {
  return resolveKordocMcp(runtime, root, fs).spec
}

/**
 * **(선택 도우미, 아무 데서도 부르지 않는다)** 사이드카 `kordoc.ensure` 봉투 → 런타임.
 *
 * v0.6.0 ③이 `kordoc.ensure`를 거치기로 확정할 때만 연결 단계가 쓴다 — 이 모듈은 실행 파일을
 * 고르지 않는다(WORK-PLAN §3). 규칙은 설계 §3.2 그대로:
 * `ok && data.status === 'ready'`일 때 `cliJs = data.shim_cli_js ?? (data.cli_path가 .js면 그 값)`,
 * `version = data.actual_version`. `node`와 `extraEnv`는 ③이 정한 값을 그대로 받는다
 * (사이드카 PATH에 홈브루가 없어 ③이 `--node`를 넘기는 쪽이 자연스럽다).
 * 봉투가 ready 가 아니거나 두 경로가 모두 쓸 수 없으면 `null` — 붙이지 않는다.
 */
export function runtimeFromEnsureEnvelope(
  envelope: unknown,
  node: string,
  extraEnv: Record<string, string> = {}
): KordocRuntime | null {
  if (!envelope || typeof envelope !== 'object') return null
  const env = envelope as { ok?: unknown; data?: unknown }
  if (env.ok !== true) return null
  if (!env.data || typeof env.data !== 'object') return null
  const data = env.data as { status?: unknown; shim_cli_js?: unknown; cli_path?: unknown; actual_version?: unknown }
  if (data.status !== 'ready') return null
  const shim = typeof data.shim_cli_js === 'string' && data.shim_cli_js ? data.shim_cli_js : null
  const cli = typeof data.cli_path === 'string' && /\.js$/i.test(data.cli_path) ? data.cli_path : null
  const cliJs = shim ?? cli
  if (!cliJs || typeof data.actual_version !== 'string' || !data.actual_version) return null
  return { node, cliJs, version: data.actual_version, extraEnv }
}

/**
 * `realpath` 기준 폴더 안 판정 — **기존 `outsideRoot`(문자열 비교)를 쓰지 않는 이유**는 폴더 안의
 * 심볼릭 링크가 밖을 가리켜도 "안"으로 읽히기 때문이다(claude.ts 실측).
 *
 * 규칙: `rootReal = realpath(root)`, `fileReal = realpath(resolve(root, v))`.
 * **해석 실패(ENOENT·EACCES·루프)는 거짓** — 읽기 도구는 존재하는 파일만 뜻이 있다.
 * 두 값을 각각 NFC로 정규화한 뒤 `같음 || rootReal + sep 로 시작` — macOS의 NFD 파일명 차이를 흡수한다.
 */
export function insideRootReal(
  root: string,
  value: unknown,
  fs: Pick<KordocFs, 'realpathSync'> = NODE_FS
): boolean {
  if (typeof value !== 'string' || !value) return false
  let rootReal: string
  let fileReal: string
  try { rootReal = fs.realpathSync(root) } catch { return false }
  try { fileReal = fs.realpathSync(resolve(root, value)) } catch { return false }
  const a = rootReal.normalize('NFC')
  const b = fileReal.normalize('NFC')
  const prefix = a.endsWith(sep) ? a : a + sep
  return b === a || b.startsWith(prefix)
}

export type McpPolicyVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string }

/**
 * Claude `canUseTool` 앞단 판정(§3.4). **`autoAllowed`·`trusted()`보다 앞에** 두어야 한다 —
 * `trust` 폴더에서 `false`만 돌려주면 다음 분기로 넘어가 전부 허용된다(설계 §1-B).
 *
 * 1. `mcp__`가 아니면 `null`(기존 흐름 그대로).
 * 2. `mcp__kordoc__`가 아닌 MCP 도구는 거절(허용 목록이 원칙 — `strictMcpConfig`는 두 번째 겹).
 * 3. `READ_TOOL_PATHS`에 없는 이름은 거절(쓰기 12개 + 미래의 새 도구).
 * 4. 필수 경로가 비었거나 문자열이 아니면 거절. 필수·(값이 있는) 선택 경로를 `insideRootReal`로 검사.
 */
export function mcpPolicy(
  root: string,
  name: string,
  input: unknown,
  fs: Pick<KordocFs, 'realpathSync'> = NODE_FS
): McpPolicyVerdict | null {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
  if (!name.startsWith(MCP_TOOL_PREFIX)) return { behavior: 'deny', message: DENY_FOREIGN_MCP }
  const tool = name.slice(MCP_TOOL_PREFIX.length)
  if (!Object.prototype.hasOwnProperty.call(READ_TOOL_PATHS, tool)) return { behavior: 'deny', message: DENY_NOT_READ }
  const paths = READ_TOOL_PATHS[tool as ReadTool]
  const args = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {}
  const deny = (): McpPolicyVerdict => ({ behavior: 'deny', message: DENY_OUTSIDE_ROOT })
  for (const key of paths.required) {
    const v = args[key]
    if (typeof v !== 'string' || !v) return deny()
    if (!insideRootReal(root, v, fs)) return deny()
  }
  for (const key of paths.optional) {
    const v = args[key]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || !insideRootReal(root, v, fs)) return deny()
  }
  return { behavior: 'allow' }
}

/**
 * Claude SDK 세션 옵션 세 키(§3.3). `strictMcpConfig`가 학생 `~/.claude`·`.mcp.json`·플러그인 MCP를
 * 전부 무시하고, `disallowedTools`가 쓰기 12개를 모델 눈에서도 지운다.
 */
export function claudeMcpOptions(spec: KordocMcpSpec): {
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; timeout: number }>
  strictMcpConfig: true
  disallowedTools: string[]
} {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'stdio', command: spec.command, args: [...spec.args], env: { ...spec.env }, timeout: CLAUDE_MCP_TIMEOUT_MS }
    },
    strictMcpConfig: true,
    disallowedTools: WRITE_TOOLS.map((t) => `${MCP_TOOL_PREFIX}${t}`)
  }
}

/**
 * Codex `app-server` 앞 `-c` 6쌍(§3.3). **학생 논문 폴더 경로는 명령줄에 넣지 않는다** — env로 넘기고
 * `env_vars`에는 이름만 적는다. 값 직렬화는 `JSON.stringify`(TOML 문자열·배열과 같은 문법).
 */
export function codexMcpArgs(spec: KordocMcpSpec): string[] {
  const base = `mcp_servers.${MCP_SERVER_NAME}`
  const extraNames = Object.keys(spec.env).filter((k) => k !== 'KORDOC_ROOT' && k !== 'KORDOC_OFFLINE')
  return [
    '-c', `${base}.command=${JSON.stringify(spec.command)}`,
    '-c', `${base}.args=${JSON.stringify(spec.args)}`,
    '-c', `${base}.env_vars=${JSON.stringify(['KORDOC_ROOT', 'KORDOC_OFFLINE', ...extraNames])}`,
    '-c', `${base}.enabled_tools=${JSON.stringify([...READ_TOOLS])}`,
    '-c', `${base}.startup_timeout_sec=${CODEX_STARTUP_TIMEOUT_SEC}`,
    '-c', `${base}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`
  ]
}

/**
 * `env_vars`는 codex 자식에게 **부모 환경에서 이름으로** 전달된다 — 그래서 app-server 프로세스 env에
 * 이 값을 합쳐야 한다. `root×provider`당 하나이므로 폴더가 섞이지 않는다(설계 §1-L).
 */
export function codexMcpEnv(spec: KordocMcpSpec): Record<string, string> {
  return { ...spec.env }
}