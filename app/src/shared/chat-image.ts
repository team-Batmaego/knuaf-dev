/** Direct chat attachments; provisional limits until both installed engines are measured. */
export const CHAT_IMAGE_LIMITS = { bytes: 5 * 1024 * 1024, count: 4, edge: 8000, idleMs: 10 * 60_000 } as const
export type ChatImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export type ImageScope = { readonly root: string; readonly visit: number }
export type ChatImageReceipt = {
  readonly name: string
  readonly mime: ChatImageMime
  readonly size: number
  readonly sha256: string
}
export type ChatImageChip = { readonly id: string; readonly name: string; readonly preview: string; readonly expiresAt: number }
export type ChatImageReply =
  | { readonly kind: 'image'; readonly chip: ChatImageChip }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'error'; readonly message: string }

export const CHAT_IMAGE_COPY = {
  reattach: '이 그림을 보낼 수 없어요. 그림을 다시 붙여 주세요.',
  changed: '논문 폴더가 바뀌었어요. 그림을 다시 붙여 주세요.',
  file: '그림만 바로 보여 줄 수 있어요. 이 파일은 경로만 입력했어요.',
  format: 'PNG, JPG, GIF, WebP 그림만 붙일 수 있어요.',
  size: '그림은 한 장에 5MB, 가로·세로 8,000픽셀까지 붙일 수 있어요.',
  count: '그림은 한 번에 4장까지 보낼 수 있어요.',
  read: '파일을 읽지 못했어요. 파일을 확인한 뒤 다시 붙여 주세요.',
  busy: '그림을 확인 중이에요. 잠시 뒤 다시 붙여 주세요.',
  provider: '그림 첨부는 ChatGPT(Codex) 또는 Claude에서 보낼 수 있어요.',
  resend: '그림을 다시 붙인 뒤 보내 주세요.',
  ask: '이 그림을 봐 주세요.'
} as const
