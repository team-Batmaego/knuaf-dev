import type { Provider } from '../../../shared/chat'

export interface TokenCounts {
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  totalTokens?: number
}
export type TokenEvent =
  | { company: 'claude'; requestSequence: number; notificationSequence: number; usage: TokenCounts }
  | { company: 'codex'; requestSequence: number; notificationSequence: number; last: TokenCounts; total: TokenCounts }
export interface TokenContext {
  conversationId: string
  jobId: string
  company: Provider
  model: string
  effort: string | null
  role: string
}
function counts(value: TokenCounts): TokenCounts {
  const out: TokenCounts = {}
  for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'totalTokens'] as const) {
    const n = value[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[key] = n
  }
  return out
}
/** Whitelist projection, not a spread of SDK payloads. No sums or cache-hit arithmetic. */
export function tokenRecord(context: TokenContext, event: TokenEvent, at: string): object | null {
  if (event.company !== context.company || !Number.isInteger(event.requestSequence) || event.requestSequence < 1
    || !Number.isInteger(event.notificationSequence) || event.notificationSequence < 1) return null
  const base = {
    conversationId: context.conversationId, jobId: context.jobId, company: context.company,
    model: context.model, effort: context.effort, role: context.role,
    firstRequest: event.requestSequence === 1, requestSequence: event.requestSequence,
    notificationSequence: event.notificationSequence, at
  }
  return event.company === 'codex'
    ? { ...base, last: counts(event.last), total: counts(event.total) }
    : { ...base, usage: counts(event.usage) }
}
/** SDK result.usage field names from bundled 0.3.275; conversion does not retain the source. */
export function claudeTokens(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }, requestSequence: number, notificationSequence: number): TokenEvent {
  return { company: 'claude', requestSequence, notificationSequence, usage: {
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens, cacheWriteInputTokens: usage.cache_creation_input_tokens
  } }
}
/** app-server thread/tokenUsage/updated: preserve last and total separately, never accumulate total. */
export function codexTokens(tokenUsage: { last: TokenCounts; total: TokenCounts }, requestSequence: number, notificationSequence: number): TokenEvent {
  return { company: 'codex', requestSequence, notificationSequence, last: counts(tokenUsage.last), total: counts(tokenUsage.total) }
}
