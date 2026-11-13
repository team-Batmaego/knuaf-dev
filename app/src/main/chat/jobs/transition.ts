import type { ConversationOwner } from './types'

/** Prepared activation is synchronous: ownership and visible conversation change without an await gap. */
export interface OwnerTransition {
  ready(): Promise<void>
  commit(owner: ConversationOwner, activate: () => void): boolean
  cancel(): void
  flush(): Promise<void>
}
