/**
 * figures/contract.ts — 앱 ↔ 규칙집 그림 요청/결과의 **모양**만 정의한다.
 *
 * 정본은 `CONTRACT.md`(두 워커 공용 형식)다. 여기서는 그 형식을 타입과 검사 함수로 옮기고,
 * 판정·수신 같은 동작은 다른 모듈이 맡는다. 요청에 모르는 필드가 하나라도 있으면 거절한다
 * (계약 §3) — 나중에 형식이 늘어날 때 옛 앱이 새 필드를 조용히 무시하지 않게 하려는 것이다.
 */

/** 요청 id. 파일 이름에도 그대로 쓰이므로 경로 문자(`/`, `..`)를 허용하지 않는다. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
/** 절 id. 후보표 파일 이름이 되므로 같은 이유로 경로 문자를 막는다. */
export const SLOT_RE = /^[A-Za-z0-9_.-]{1,64}$/
/** 요청 파일 상한. 계약상 요청은 URL 4개짜리 작은 JSON이다. */
export const REQUEST_MAX_BYTES = 64 * 1024

export interface FigureRequest {
  v: 1
  id: string
  turnId: string
  slot: string
  page: string
  images: string[]
}

export type RequestProblem =
  | 'json' | 'shape' | 'version' | 'id' | 'turnId' | 'slot' | 'page' | 'images'

export type RequestParse =
  | { ok: true; request: FigureRequest }
  | { ok: false; reason: RequestProblem }

const REQUEST_KEYS = 'id,images,page,slot,turnId,v'

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** 요청 JSON 본문 하나를 계약 §3 모양으로 좁힌다. */
export function parseFigureRequest(body: string): RequestParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' }
  const obj = raw as Record<string, unknown>
  if (Object.keys(obj).sort().join(',') !== REQUEST_KEYS) return { ok: false, reason: 'shape' }
  if (obj.v !== 1) return { ok: false, reason: 'version' }
  if (typeof obj.id !== 'string' || !REQUEST_ID_RE.test(obj.id)) return { ok: false, reason: 'id' }
  if (!text(obj.turnId, 200)) return { ok: false, reason: 'turnId' }
  if (typeof obj.slot !== 'string' || !SLOT_RE.test(obj.slot) || obj.slot === '.' || obj.slot === '..') {
    return { ok: false, reason: 'slot' }
  }
  if (!text(obj.page, 2048)) return { ok: false, reason: 'page' }
  if (!Array.isArray(obj.images) || obj.images.length < 1 || obj.images.length > 3) {
    return { ok: false, reason: 'images' }
  }
  if (!obj.images.every((url) => text(url, 2048))) return { ok: false, reason: 'images' }
  return {
    ok: true,
    request: {
      v: 1,
      id: obj.id,
      turnId: obj.turnId,
      slot: obj.slot,
      page: obj.page,
      images: obj.images as string[]
    }
  }
}

export type ImageVerdict = 'approved' | 'ambiguous' | 'rejected'

export interface FigureResImage {
  n: number
  url: string
  finalUrl: string | null
  verdict: ImageVerdict
  reason: string
  /** 승인 그림이면 `store/<sha256>.png`의 sha256. 그 밖에는 null. */
  sha256: string | null
  /** 승인 그림이면 `app-figure:<sha256>`. */
  token: string | null
  kogl: number | null
  org: string | null
  /** 승인 그림이 둘 이상일 때만 A·B·C. */
  label: string | null
}

export interface FigureRes {
  v: 1
  id: string
  status: 'done' | 'rejected'
  reason?: string
  slot: string
  needsChoice: boolean
  images: FigureResImage[]
}

/** 승인 그림의 원고 토큰 — build_docx가 `store/<sha256>.png`로 푼다. */
export function figureToken(sha256: string): string {
  return `app-figure:${sha256}`
}

export interface FigureReceipt {
  v: 1
  at: number
  reqId: string
  folderHash: string
  slot: string
  page: { url: string; sha256: string; marks: string[] }
  image: {
    url: string
    finalUrl: string
    origSha256: string
    sha256: string | null
    verdict: ImageVerdict
    reason: string
    kogl: number | null
    org: string | null
    ruleId: string | null
  }
}

/** 증명 한 줄이 승인인가 — build_docx 검사의 앱 쪽 대응물. */
export function isApprovedReceipt(value: unknown): value is FigureReceipt {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<FigureReceipt>
  return r.v === 1 && typeof r.reqId === 'string' && !!r.image && r.image.verdict === 'approved'
}
