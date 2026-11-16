import type { ChatModelInfo, ConnectionStatus, FreeRelayErrorKind, Provider } from '../../shared/chat'
import { FREE_DS_MODEL, FREE_GLM_MODEL } from '../../shared/lanes'
import type { ExecutionAccount } from '../chat/jobs/types'
import { freeRelayToken } from './token'

export const FREE_RELAY_URL = 'https://free.168-107-60-66.sslip.io/v1'
export const FREE_MODELS: ChatModelInfo[] = [
  { model: FREE_DS_MODEL, name: 'DeepSeek', description: '', efforts: [], defaultEffort: null, isDefault: true },
  { model: FREE_GLM_MODEL, name: 'GLM', description: '', efforts: [], defaultEffort: null, isDefault: false }
]
export class FreeRelayError extends Error {
  constructor(readonly kind: FreeRelayErrorKind) { super(kind) }
}
export function freeStatus(): ConnectionStatus {
  const connected = Boolean(freeRelayToken())
  return { installed: true, connected, version: null, detail: connected ? '' : 'free-unavailable',
    ...(!connected ? { errorKind: 'free-unavailable' as const } : {}) }
}
export function providerEnv(provider: Provider, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.KNUAF_FREE_TOKEN
  delete env.KNUAF_FREE_RELAY
  if (provider !== 'free') return env
  const token = freeRelayToken()
  if (!token) throw new FreeRelayError('free-unavailable')
  env.KNUAF_FREE_TOKEN = token
  env.KNUAF_FREE_RELAY = '1'
  env.KNUAF_CODEX_MODEL = FREE_DS_MODEL
  delete env.KNUAF_CODEX_EFFORT
  return env
}
export function freeExecutionAccount(): ExecutionAccount {
  const connected = Boolean(freeRelayToken())
  return { accountId: 'knuaf-free', connected,
    account: { company: 'free', models: FREE_MODELS }, consented: true,
    usage: connected ? 'unknown' : 'auth' }
}
/** CLI wraps the relay JSON body in its error message; retain only known codes, never the body. */
export function freeRelayError(value: unknown): FreeRelayError {
  const text = value instanceof Error ? value.message : JSON.stringify(value) ?? ''
  const codes: [string, FreeRelayErrorKind][] = [
    ['free_model_off', 'free-off'], ['busy', 'free-busy'], ['slow_down', 'free-minute-limit'],
    ['daily_limit', 'free-daily-limit'], ['invalid_token', 'free-auth']
  ]
  for (const [code, kind] of codes) if (new RegExp(`\\b${code}\\b`).test(text)) return new FreeRelayError(kind)
  if (/\b401\b|unauthorized/.test(text)) return new FreeRelayError('free-auth')
  return new FreeRelayError('free-error')
}
