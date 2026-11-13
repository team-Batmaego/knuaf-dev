import type { Provider } from '../../../shared/chat'

/** Job ids make role connections unique even for consecutive jobs in the same lane. */
export function chatConnectionKey(root: string, provider: Provider, role = 'main'): string {
  return `${root}\0${provider}\0${role}`
}
