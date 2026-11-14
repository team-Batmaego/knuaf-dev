/**
 * figures/process.ts — 요청 하나를 검사 → 받기 → 판정 → 저장 → 결과로 닫는다 (설계 §3~§5, R4-1·R4-4·R4-5)
 *
 * 순서가 곧 안전장치다.
 * 1. 턴이 맞는가(R4-6) — 아니면 받지도 않는다.
 * 2. 같은 id를 이미 봤는가 — 한 번 처리한 id는 다시 처리하지 않는다.
 * 3. 페이지 URL이 규칙집의 **페이지 형식**에 맞는가 — 아니면 그림 URL도 안 받는다.
 * 4. 페이지 HTML을 받아 그림마다 ① 그 페이지에 실재 ② 공공누리 단일 유형 ③ 제3자 표기 없음
 *    ④ 1·2유형 — 전부 맞아야 승인.
 * 5. 승인된 것만 숨김 창에서 PNG로 다시 굽고(R4-5) `store/<sha256>.png`에 넣는다.
 *
 * 거절된 그림은 바이트를 저장하지 않는다. 저장한 것은 승인된 재인코딩 PNG뿐이다.
 */

import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  figureToken,
  type FigureReceipt,
  type FigureRequest,
  type FigureRes,
  type FigureResImage
} from './contract'
import { checkTurn, readTurn, type TurnRecord } from './turn'
import type { RulesLoad } from './rules'
import { isAllowedImage, matchImage, matchPage, parseHttpsUrl, type FigureRule } from './url-rules'
import { fetchLimited } from './fetch'
import { sniffImage } from './image-header'
import {
  appearsOnPage,
  creditFor,
  decide,
  findImageOccurrences,
  readKogl,
  type ImageOccurrence,
  type KoglReading,
  type KoglType
} from './verdict'
import { DECODE_TIMEOUT_MS, reencodeToPng, type ImageDecoder } from './reencode-window'
import {
  appendLine,
  chargeQuota,
  checkQuota,
  fileExists,
  folderHash,
  loadCounters,
  readJson,
  sha256Hex,
  writeAtomic,
  writeJson,
  writeJsonNew,
  type Counters,
  type FigurePaths
} from './storage'
import { choicePath, choiceQuestion, writeChoiceSheet, type ChoiceCandidate } from './choices'

export const PAGE_MAX_BYTES = 2 * 1024 * 1024
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const REQUEST_TOTAL_BYTES = 20 * 1024 * 1024
export const FILE_TIMEOUT_MS = 30_000
export const REQUEST_TIMEOUT_MS = 50_000

export type FetchFn = typeof fetchLimited

/**
 * 턴 세대값 (R-6). 요청은 시작 때 세대값을 **동기로** 잡고, 저장 쓰기를 시작하기 직전 같은 틱에 다시 본다.
 * `endTurn`이 세대값을 올린 뒤에는 이미 시작한 요청의 남은 쓰기가 전부 사라져야 한다 — 그래야
 * `endTurn()`이 돌려준 시점 이후에 저장소 PNG·증명·결과가 새로 생기지 않는다.
 */
export interface TurnLease {
  /**
   * 쓰기 구간 진입. 세대가 바뀌었으면 `null` — 쓰지 말고 `cancelled`로 닫는다.
   * 돌려주는 함수를 `finally`에서 부르면 `endTurn`이 그 구간이 끝난 것을 본다.
   */
  open(): (() => void) | null
  /** 지금도 이 요청의 턴인가(동기). 쓰기 없이 중간 점검만 할 때. */
  live(): boolean
}

export interface TurnGate {
  begin(): TurnLease
}

/** 저장 쓰기 대역(시험). 첫 호출에서 멈춰 `endTurn` 경계를 본다(R-6). 기본은 `storage` 구현. */
export interface WriteSeam {
  atomic(path: string, data: string | Uint8Array): Promise<void>
  json(path: string, value: unknown): Promise<void>
  /** 배타 생성 — 이미 있으면 `false`, 아무것도 쓰지 않는다(I-1). */
  jsonNew(path: string, value: unknown): Promise<boolean>
  line(path: string, value: unknown): Promise<void>
}

const defaultWrite: WriteSeam = {
  atomic: writeAtomic,
  json: writeJson,
  jsonNew: writeJsonNew,
  line: appendLine
}

export interface ProcessDeps {
  paths: FigurePaths
  /** 규칙집 로더 — 호출 시점에 다시 읽는다(스킬 판이 바뀔 수 있다). */
  loadRules: () => Promise<RulesLoad>
  /** 디코더 대역(시험). 없으면 Electron 숨김 창. */
  decode?: ImageDecoder
  /** 받기 대역(시험). */
  fetchFn?: FetchFn
  /** 턴 세대값(앱 경로). 없으면 디스크 `turn.json`을 매번 다시 읽는다(직접 호출). */
  gate?: TurnGate
  /** 저장 쓰기 대역(시험). */
  write?: WriteSeam
  now?: () => number
}

export interface ProcessInput {
  request: FigureRequest
  /** 요청 파일이 있던 논문 폴더(realpath). */
  folder: string
}

interface ImageJob {
  n: number
  raw: string
  pageUrl: URL
  pageHtml: string
  pageSha: string
  pageUrlHref: string
  /** 페이지 HTML 안 그림 태그 전부(자리 포함) — 실재 대조와 제3자 표기 기준점. */
  occurrences: readonly ImageOccurrence[]
  rules: readonly FigureRule[]
  pageRuleId: string
  fetch: FetchFn
  deps: ProcessDeps
  deadline: number
  /** 지금까지 요청 전체에서 받은 바이트(합계 상한용). */
  spent: number
  counters: Counters
  hash: string
  slot: string
  reqId: string
  now: () => number
  /** 턴이 아직 살아 있는가 — 저장 직전마다 확인한다(R-6). */
  live: () => Promise<boolean>
  /** 쓰기 구간 하나를 이 턴의 것으로 연다 — `endTurn`이 이 구간이 끝날 때까지 기다린다(R-6). */
  guard: (run: () => Promise<void>) => Promise<boolean>
  /** 저장 쓰기 대역(기본은 `storage`). */
  write: WriteSeam
}

export async function processRequest(input: ProcessInput, deps: ProcessDeps): Promise<FigureRes> {
  const now = deps.now ?? Date.now
  const { request } = input
  // 세대값은 **동기로** 여기서 잡는다 — 아래 첫 await 뒤에 잡으면 그 사이 `endTurn`을 놓친다(R-6).
  const lease = deps.gate?.begin()
  const write = deps.write ?? defaultWrite
  /**
   * 쓰기 구간 하나. 게이트가 있으면 진입을 같은 틱에 확인하고, 끝나면 `endTurn`에 알린다.
   * 세대가 바뀌었으면 `false` — 그 쓰기는 시작조차 하지 않는다.
   */
  const guarded = async (run: () => Promise<void>): Promise<boolean> => {
    if (!lease) {
      await run()
      return true
    }
    const release = lease.open()
    if (!release) return false
    try {
      await run()
      return true
    } finally {
      release()
    }
  }
  const hash = folderHash(await realpath(input.folder).catch(() => input.folder))
  // 거절도 결과 파일로 남긴다 — 안 남기면 도우미가 60초를 다 기다린 뒤 실패한다.
  // 단 중복은 기존 기록을 덮어쓰지 않는다(같은 id의 첫 결과가 정본이다). 거절 결과도 **배타 생성**이다:
  // 재시작 뒤 턴 없이 다시 집은 옛 요청이 지난 실행의 `done`을 `cancelled`로 덮으면 학생은 결과를 잃는다(I-1).
  const reject = async (reason: string): Promise<FigureRes> => {
    const res: FigureRes = {
      v: 1,
      id: request.id,
      status: 'rejected',
      reason,
      slot: request.slot,
      needsChoice: false,
      images: []
    }
    if (reason !== 'duplicate') await write.jsonNew(join(deps.paths.res, `${request.id}.res.json`), res)
    return res
  }

  const turn = await readTurn(deps.paths.turn)
  const turnCheck = checkTurn(turn, request.turnId)
  if (!turnCheck.ok) return reject(turnCheck.reason)
  const turnFolder = await realpath((turn as TurnRecord).folder).catch(() => (turn as TurnRecord).folder)
  if (turnFolder !== (await realpath(input.folder).catch(() => input.folder))) return reject('stale')
  // 턴이 아직 이 요청의 것인가 — 받기·굽기 도중 `endTurn`이 지나갔으면 결과를 저장하지 않는다(R-6).
  // 게이트가 있으면 세대값을 메모리에서 동기로 본다(디스크를 다시 읽지 않는다).
  const live = async (): Promise<boolean> =>
    lease ? lease.live() : checkTurn(await readTurn(deps.paths.turn), request.turnId).ok
  if (await seenRequestId(deps.paths, request.id)) return reject('duplicate')

  const rules = await deps.loadRules()
  if (!rules.ok) return reject('no_channel')
  const pageParsed = parseHttpsUrl(request.page)
  if (!pageParsed.ok) return reject('invalid')
  const pageMatch = matchPage(pageParsed.url, rules.rules)
  if (!pageMatch) return reject('rule_missing')

  const fetchOne = deps.fetchFn ?? fetchLimited
  const deadline = now() + REQUEST_TIMEOUT_MS
  const page = await fetchOne(request.page, {
    validate: (url) => validateForHop(url, rules.rules, 'page', pageMatch.rule.id),
    maxBytes: PAGE_MAX_BYTES,
    timeoutMs: Math.min(FILE_TIMEOUT_MS, Math.max(1, deadline - now())),
    headers: { accept: 'text/html,application/xhtml+xml' }
  })
  if (!page.ok) return reject(page.reason === 'limit' || page.reason === 'timeout' ? page.reason : 'page_fetch')

  const html = decodeBody(page.body, page.contentType)
  const pageSha = sha256Hex(page.body)
  const kogl = readKogl(html)
  const occurrences = findImageOccurrences(html, page.finalUrl)
  let counters = await loadCounters(deps.paths.counters, now())

  let spent = page.body.length
  const images: FigureResImage[] = []
  const receipts: FigureReceipt[] = []
  for (const [index, raw] of request.images.entries()) {
    const job: ImageJob = {
      n: index + 1,
      raw,
      pageUrl: page.finalUrl,
      pageHtml: html,
      pageSha,
      pageUrlHref: page.finalUrl.href,
      occurrences,
      rules: rules.rules,
      pageRuleId: pageMatch.rule.id,
      fetch: fetchOne,
      deps,
      deadline,
      spent,
      counters,
      hash,
      slot: request.slot,
      reqId: request.id,
      now,
      live,
      guard: guarded,
      write
    }
    // 승인될 때만 재인코딩·저장하고, 그때만 증명을 남긴다(거절은 결과에만).
    const result = await processImage(job, kogl)
    // 그림 사이에도 턴이 끝날 수 있다 — 끝났으면 남은 그림은 받지 않고 결과를 `cancelled`로 닫는다.
    if (!(await job.live())) return reject('cancelled')
    counters = result.counters
    spent += result.bytes
    images.push(result.image)
    if (result.receipt) receipts.push(result.receipt)
  }

  const approved = images.filter((image) => image.verdict === 'approved')
  const needsChoice = approved.length >= 2
  if (needsChoice) {
    const labels = ['A', 'B', 'C'] as const
    const candidates: ChoiceCandidate[] = approved.map((image, index) => {
      const label = labels[index] as ChoiceCandidate['label']
      image.label = label
      return { label, sha256: image.sha256 as string, desc: `${image.org ?? '기관 미상'} · ${image.url}` }
    })
    // 선택지 표도 이 턴의 산출물이다 — `endTurn`이 지나갔으면 쓰지 않는다(R-6).
    const wrote = await guarded(() =>
      writeChoiceSheet(choicePath(deps.paths.choices, hash, request.slot), {
        v: 1,
        reqId: request.id,
        slot: request.slot,
        question: choiceQuestion(candidates),
        candidates,
        studentMessage: null
      })
    )
    if (!wrote) return reject('cancelled')
  }

  // 마지막 쓰기 구간 — 증명 줄과 결과 파일. `endTurn`은 이 구간이 끝난 뒤에 돌아간다(R-6).
  const res: FigureRes = {
    v: 1,
    id: request.id,
    status: 'done',
    slot: request.slot,
    needsChoice,
    images
  }
  let created = false
  const wrote = await guarded(async () => {
    for (const receipt of receipts) await write.line(deps.paths.receipts, receipt)
    // 첫 결과가 정본이다 — 이미 있으면 덮지 않는다(재시작·동시 처리에서 옛 `done` 보존, I-1).
    created = await write.jsonNew(join(deps.paths.res, `${request.id}.res.json`), res)
  })
  if (!wrote) return reject('cancelled')
  if (!created) return (await readJson<FigureRes>(join(deps.paths.res, `${request.id}.res.json`))) ?? res
  return res
}

/** 그림 하나. 승인이면 재인코딩·저장·증명까지. */
interface ImageResult {
  image: FigureResImage
  receipt: FigureReceipt | null
  /** 이 그림 때문에 받은 + 저장한 바이트(합계 상한 계산용). */
  bytes: number
  /** 갱신된 계수(승인 저장이 있었으면 새 값). */
  counters: Counters
}

async function processImage(job: ImageJob, kogl: KoglReading): Promise<ImageResult> {
  const base: FigureResImage = {
    n: job.n,
    url: job.raw,
    finalUrl: null,
    verdict: 'rejected',
    reason: '',
    sha256: null,
    token: null,
    kogl: null,
    org: null,
    label: null
  }
  // 사유로 승인/애매를 가르는 지점은 verdict.decide 한 곳뿐이다. 받기 단계 거절은 전부 rejected.
  const refuse = (reason: string): ImageResult => ({
    image: { ...base, reason },
    receipt: null,
    bytes: 0,
    counters: job.counters
  })
  const judged = (extra: {
    verdict: FigureResImage['verdict']
    reason: string
    finalUrl: string | null
    kogl: KoglType | null
    org: string | null
  }, bytes: number): ImageResult => ({
    image: { ...base, ...extra },
    receipt: null,
    bytes,
    counters: job.counters
  })

  // 승인 후보 판정: 페이지·그림이 **같은 규칙 항목**에 걸려야 한다(R4-4).
  const allowed = isAllowedImage(job.raw, job.pageUrl, job.rules)
  if (!allowed.ok) return refuse(allowed.reason)
  if (allowed.rule.id !== job.pageRuleId) return refuse('rule_mismatch')

  const remaining = job.deadline - job.now()
  if (remaining <= 0) return refuse('timeout')
  const budget = Math.min(IMAGE_MAX_BYTES, REQUEST_TOTAL_BYTES - job.spent)
  if (budget <= 0) return refuse('limit')

  const fetched = await job.fetch(job.raw, {
    // 홉마다 **페이지와 같은 규칙 id**의 imagePath를 요구한다(B-3). 다른 기관 규칙으로 넘어가면 거절.
    validate: (url) => validateForHop(url, job.rules, 'image', job.pageRuleId),
    maxBytes: budget,
    timeoutMs: Math.min(FILE_TIMEOUT_MS, remaining),
    headers: { accept: 'image/jpeg,image/png,image/gif' }
  })
  if (!fetched.ok) return refuse(fetched.reason)
  const bytes = fetched.body.length
  const finalUrl = fetched.finalUrl.href
  // 받기 홉 검사와 **따로** 최종 URL을 규칙에 다시 물린다 — 판정 입력을 상수로 두지 않는다(B-3).
  const finalParsed = parseHttpsUrl(finalUrl)
  const finalMatch = finalParsed.ok ? matchImage(finalParsed.url, job.rules) : null
  const finalAllowed = finalMatch !== null && finalMatch.rule.id === job.pageRuleId

  const shippedType = (fetched.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  // Content-Type은 참고만 한다 — 판정은 매직 바이트로 한다(헤더 주장은 위조 가능).
  if (shippedType && shippedType !== 'application/octet-stream' && !shippedType.startsWith('image/')) {
    return judged({ verdict: 'rejected', reason: 'format', finalUrl, kogl: null, org: null }, bytes)
  }
  const sniffed = sniffImage(fetched.body)
  if (!sniffed.ok) {
    return judged({ verdict: 'rejected', reason: sniffed.reason, finalUrl, kogl: null, org: null }, bytes)
  }

  // 설계 §5-1: 페이지에 실재해야 하는 것은 **최종 URL**이다. 리다이렉트 전 URL은 인정하지 않는다(B-3).
  const present = appearsOnPage(job.occurrences, [finalUrl])
  const credit = creditFor(job.pageHtml, job.occurrences, [finalUrl])
  const verdict = decide({
    rule: { ok: true, ruleId: allowed.rule.id, org: allowed.org },
    present,
    thirdPartyCredit: credit,
    kogl,
    finalUrlAllowed: finalAllowed
  })
  const judgedImage: FigureResImage = {
    ...base,
    finalUrl,
    verdict: verdict.verdict,
    reason: verdict.reason,
    kogl: verdict.kogl,
    org: verdict.org
  }

  const receiptBase = {
    v: 1 as const,
    at: job.now(),
    reqId: job.reqId,
    folderHash: job.hash,
    slot: job.slot,
    page: { url: job.pageUrlHref, sha256: job.pageSha, marks: verdict.marks }
  }

  if (verdict.verdict !== 'approved') {
    return {
      image: judgedImage,
      receipt: {
        ...receiptBase,
        image: {
          url: job.raw,
          finalUrl,
          origSha256: sha256Hex(fetched.body),
          sha256: null,
          verdict: verdict.verdict,
          reason: verdict.reason,
          kogl: verdict.kogl,
          org: verdict.org,
          ruleId: verdict.ruleId
        }
      },
      bytes,
      counters: job.counters
    }
  }

  const quota = checkQuota(job.counters, job.hash, bytes)
  if (quota) {
    return judged({ verdict: 'rejected', reason: `limit_${quota}`, finalUrl, kogl: verdict.kogl, org: verdict.org }, bytes)
  }
  const decodeLeft = job.deadline - job.now()
  if (decodeLeft <= 0) return refuse('timeout')
  const decoded = await reencodeToPng(fetched.body, {
    decode: job.deps.decode,
    // 요청 50초 안에 끝나야 한다 — 디코드 자체 상한(10초)과 남은 시간 중 작은 쪽(R-1).
    timeoutMs: Math.min(DECODE_TIMEOUT_MS, decodeLeft)
  })
  if (!decoded.ok) {
    return judged(
      { verdict: 'rejected', reason: `decode_${decoded.reason}`, finalUrl, kogl: verdict.kogl, org: verdict.org },
      bytes
    )
  }
  const pngSha = sha256Hex(decoded.png)
  const counters = chargeQuota(job.counters, job.hash, decoded.png.length)
  // 굽기 직전 마지막 확인 겸 쓰기 구간 — 끝난 턴의 그림은 저장소에도 계수에도 남기지 않는다(R-6).
  // PNG·계수를 한 구간으로 묶어 `endTurn`이 둘 다 끝난 뒤에 돌아가게 한다(반쪽 저장 방지).
  const stored = await job.guard(async () => {
    await job.write.atomic(join(job.deps.paths.store, `${pngSha}.png`), decoded.png)
    await job.write.json(job.deps.paths.counters, counters)
  })
  if (!stored) return refuse('cancelled')

  return {
    image: { ...judgedImage, sha256: pngSha, token: figureToken(pngSha) },
    receipt: {
      ...receiptBase,
      image: {
        url: job.raw,
        finalUrl,
        origSha256: sha256Hex(fetched.body),
        sha256: pngSha,
        verdict: verdict.verdict,
        reason: verdict.reason,
        kogl: verdict.kogl,
        org: verdict.org,
        ruleId: verdict.ruleId
      }
    },
    bytes: bytes + decoded.png.length,
    counters
  }
}

/**
 * 페이지 본문을 글자로 푼다 (R-3).
 *
 * `toString('utf8')`만 쓰면 EUC-KR 페이지의 공공누리 표시가 깨져 `readKogl`이 못 읽고, 마크 없는
 * 페이지 = 승인 없음으로 흘러간다. 순서는 ① `content-type` charset ② 본문 앞부분의 `<meta charset>`
 * ③ utf-8. 모르는 이름은 utf-8로 떨어진다 — `TextDecoder`가 던지면 그때 utf-8.
 */
export function decodeBody(body: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType ?? '')
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(decodeAscii(body.subarray(0, 2048)))
  const label = fromHeader?.[1] ?? fromMeta?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(label.toLowerCase()).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

/** charset 이름을 읽기 위한 1바이트 해석 — 본문 앞부분만 본다. */
function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

/**
 * 받기 홉마다 규칙을 다시 본다 — 리다이렉트가 규칙 밖 호스트·경로로 나가면 거절.
 *
 * 이미 페이지가 걸린 규칙(`ruleId`)의 **같은 항목**만 허용한다. 다른 기관 규칙의 그림 경로로
 * 넘어가면 그 기관 그림에 이 페이지의 공공누리를 붙이게 되므로, 홉 단계에서 끊는다(B-3).
 */
function validateForHop(
  url: URL,
  rules: readonly FigureRule[],
  kind: 'page' | 'image',
  ruleId: string
): { ok: true } | { ok: false; reason: string } {
  const parsed = parseHttpsUrl(url.href)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const match = kind === 'page' ? matchPage(parsed.url, rules) : matchImage(parsed.url, rules)
  if (!match) return { ok: false, reason: 'outside_rules' }
  if (match.rule.id !== ruleId) return { ok: false, reason: 'outside_rules' }
  return { ok: true }
}

/** 이미 처리한 id인가 — 결과 파일 또는 증명 줄. 계약 §3: 같은 id 재사용 거절. */
export async function seenRequestId(paths: FigurePaths, id: string): Promise<boolean> {
  if (await fileExists(join(paths.res, `${id}.res.json`))) return true
  let text: string
  try {
    text = await readFile(paths.receipts, 'utf8')
  } catch {
    return false
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && 'reqId' in parsed && parsed.reqId === id) return true
  }
  return false
}
