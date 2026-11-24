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
import { extractCandidates } from './candidates'
import { orgReading } from './org-check'
import {
  figureToken,
  type FigureReceipt,
  type FigureRequest,
  type FigureRes,
  type FigureResImage
} from './contract'
import { checkTurn, readTurn, type TurnRecord } from './turn'
import type { RulesLoad } from './rules'
import {
  imageAllowedByRule,
  isAllowedImage,
  pageHopAllowed,
  parseHttpsUrl,
  isQueryRule,
  RULE_PAGE_QUERY_ORG,
  selectPageRule,
  type FigureRule
} from './url-rules'
import { fetchLimited } from './fetch'
import { sniffImage } from './image-header'
import {
  appearsOnPage,
  creditFor,
  decide,
  findImageOccurrences,
  readKogl,
  hasCreditMark,
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
  /** 첫 페이지 GET 직전 동기 예약. 실패해도 돌려주지 않는다(P1.1). */
  reserve(): boolean
  /** 거절 결과 파일 예약. 세대당 최대 24개(P1.1). */
  noteReject(): boolean
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
  pageHtml: string
  pageSha: string
  pageUrlHref: string
  /** 페이지 HTML 안 그림 태그 전부(자리 포함) — 실재 대조와 제3자 표기 기준점. */
  occurrences: readonly ImageOccurrence[]
  rules: readonly FigureRule[]
  pageRule: FigureRule
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
  const listing = request.images.length === 0
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
  const rejected = (reason: string): FigureRes => ({
    v: 1, id: request.id, status: 'rejected', reason,
    slot: request.slot, needsChoice: false, images: []
  })
  const quietCancelled = (): FigureRes => rejected('cancelled')
  // 모든 목록 await 뒤와 settle 진입에서 같은 취소 우선순위를 적용한다.
  const listDead = (): boolean => listing && !!lease && !lease.live()
  // 목록의 성공·거절 모두 한 출구. open()이 생존 확인과 쓰기 등록을 같은 틱에 한다(I-06).
  const settle = async (res: FigureRes): Promise<FigureRes> => {
    if (listDead()) return quietCancelled()
    let result = res
    const wrote = await guarded(async () => {
      if (res.status === 'rejected' && lease && !lease.noteReject()) return
      const path = join(deps.paths.res, `${request.id}.res.json`)
      const created = await write.jsonNew(path, res)
      if (!created) result = (await readJson<FigureRes>(path)) ?? res
    })
    if (listDead()) return quietCancelled()
    return wrote ? result : quietCancelled()
  }
  const inputFolder = await realpath(input.folder).catch(() => input.folder)
  if (listDead()) return settle(quietCancelled())
  const hash = folderHash(inputFolder)
  // 거절도 결과 파일로 남긴다 — 안 남기면 도우미가 60초를 다 기다린 뒤 실패한다.
  // 단 중복은 기존 기록을 덮어쓰지 않는다(같은 id의 첫 결과가 정본이다). 거절 결과도 **배타 생성**이다:
  // 재시작 뒤 턴 없이 다시 집은 옛 요청이 지난 실행의 `done`을 `cancelled`로 덮으면 학생은 결과를 잃는다(I-1).
  const reject = async (reason: string): Promise<FigureRes> => {
    const res = rejected(reason)
    if (listing) return settle(res)
    if (reason !== 'duplicate' && (!lease || lease.noteReject())) {
      await write.jsonNew(join(deps.paths.res, `${request.id}.res.json`), res)
    }
    return res
  }

  const turn = await readTurn(deps.paths.turn)
  if (listDead()) return settle(quietCancelled())
  const turnCheck = checkTurn(turn, request.turnId)
  if (!turnCheck.ok) return reject(turnCheck.reason)
  const turnFolder = await realpath((turn as TurnRecord).folder).catch(() => (turn as TurnRecord).folder)
  if (listDead()) return settle(quietCancelled())
  if (turnFolder !== inputFolder) return reject('stale')
  if (listing && !lease) return reject('no_channel')
  // 턴이 아직 이 요청의 것인가 — 받기·굽기 도중 `endTurn`이 지나갔으면 결과를 저장하지 않는다(R-6).
  // 게이트가 있으면 세대값을 메모리에서 동기로 본다(디스크를 다시 읽지 않는다).
  const live = async (): Promise<boolean> =>
    lease ? lease.live() : checkTurn(await readTurn(deps.paths.turn), request.turnId).ok
  const seen = await seenRequestId(deps.paths, request.id)
  if (listDead()) return settle(quietCancelled())
  if (seen) return reject('duplicate')

  const rules = await deps.loadRules()
  if (listDead()) return settle(quietCancelled())
  if (!rules.ok) return reject('no_channel')
  const pageRule = selectPageRule(request.page, rules.rules)
  if (!pageRule) return reject('rule_missing')
  if (listDead()) return settle(quietCancelled())
  if (lease && !lease.reserve()) return reject('limit_turn')

  const fetchOne = deps.fetchFn ?? fetchLimited
  const deadline = now() + REQUEST_TIMEOUT_MS
  const page = await fetchOne(request.page, {
    validate: (url) => {
      if (isQueryRule(pageRule.rule)) {
        return url.href === request.page ? { ok: true } : { ok: false, reason: 'outside_rules' }
      }
      const parsed = parseHttpsUrl(url.href)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }
      return pageHopAllowed(pageRule, parsed.url) ? { ok: true } : { ok: false, reason: 'outside_rules' }
    },
    ...(isQueryRule(pageRule.rule) ? { maxRedirects: 0 } : {}),
    maxBytes: PAGE_MAX_BYTES,
    timeoutMs: Math.min(FILE_TIMEOUT_MS, Math.max(1, deadline - now())),
    headers: { accept: 'text/html,application/xhtml+xml' }
  })
  if (listDead()) return settle(quietCancelled())
  if (!page.ok) return reject(page.reason === 'limit' || page.reason === 'timeout' ? page.reason : 'page_fetch')

  const html = decodeBody(page.body, page.contentType)
  // 목록은 페이지 해시·계수·그림별 판정 및 저장 경로를 건너뛴다.
  const kogl = readKogl(html)
  if (listing) {
    const found = extractCandidates(html, page.finalUrl, pageRule)
    return settle({
      v: 1, id: request.id, status: 'done', slot: request.slot,
      needsChoice: false, images: [], kogl: kogl.type, org: pageRule.org,
      ...found
    })
  }
  const pageSha = sha256Hex(page.body)
  const occurrences = findImageOccurrences(html, page.finalUrl)
  let counters = await loadCounters(deps.paths.counters, now())

  let spent = page.body.length
  const images: FigureResImage[] = []
  const receipts: FigureReceipt[] = []
  for (const [index, raw] of request.images.entries()) {
    const job: ImageJob = {
      n: index + 1,
      raw,
      pageHtml: html,
      pageSha,
      pageUrlHref: page.finalUrl.href,
      occurrences,
      rules: rules.rules,
      pageRule,
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

  // 처음 페이지에서 고른 객체의 imagePath만 쓴다. 규칙집의 첫 그림 일치로 다시 고르지 않는다(PQ-8).
  const allowed = isAllowedImage(job.raw, job.pageRule, job.rules)
  if (!allowed.ok) return refuse(allowed.reason)

  const remaining = job.deadline - job.now()
  if (remaining <= 0) return refuse('timeout')
  const budget = Math.min(IMAGE_MAX_BYTES, REQUEST_TOTAL_BYTES - job.spent)
  if (budget <= 0) return refuse('limit')

  const fetched = await job.fetch(job.raw, {
    // 처음·중간·마지막 홉 모두 처음 고른 항목 하나만 허용한다(PQ-9).
    validate: (url) => {
      const parsed = parseHttpsUrl(url.href)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }
      return imageAllowedByRule(job.pageRule, parsed.url) ? { ok: true } : { ok: false, reason: 'outside_rules' }
    },
    maxBytes: budget,
    timeoutMs: Math.min(FILE_TIMEOUT_MS, remaining),
    headers: { accept: 'image/jpeg,image/png,image/gif' }
  })
  if (!fetched.ok) return refuse(fetched.reason)
  const bytes = fetched.body.length
  const finalUrl = fetched.finalUrl.href
  // 받기 홉 검사와 **따로** 최종 URL을 규칙에 다시 물린다 — 판정 입력을 상수로 두지 않는다(B-3).
  const finalParsed = parseHttpsUrl(finalUrl)
  const finalAllowed = finalParsed.ok && imageAllowedByRule(job.pageRule, finalParsed.url)

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
  let credit = creditFor(job.pageHtml, job.occurrences, [finalUrl])
  const org = job.pageRule.rule === RULE_PAGE_QUERY_ORG
    ? orgReading(job.pageHtml, finalUrl, new URL(job.pageUrlHref), job.pageRule)
    : { reading: 'skip' as const, text: null }
  // 설계 §3-3 순서: 근처 권리 표기 → 구역 unknown → 구역 전체 권리 표기.
  // 구역을 못 정했으면(unknown) 그 구역 글의 표기는 순서상 뒤라 여기서 합치지 않는다.
  if (org.reading !== 'unknown' && org.text !== null && hasCreditMark(org.text)) credit = 'credit'
  const verdict = decide({
    rule: { ok: true, ruleId: allowed.rule.id, org: allowed.org },
    present,
    thirdPartyCredit: credit,
    thirdPartyOrg: org.reading,
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
