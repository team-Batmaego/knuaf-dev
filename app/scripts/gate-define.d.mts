export const GATE_MARK: string
export const GATE_CHANNEL: RegExp
export function gateValue(env?: NodeJS.ProcessEnv): { mark: string; channel: string; key: string } | null
export function gateDefine(env?: NodeJS.ProcessEnv): string
