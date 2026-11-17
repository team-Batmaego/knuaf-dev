export const MENUS = {
  materials: (count: number) => `자료 ${count}`,
  files: (count: number) => `파일 ${count}`,
  current: '현재 작성물',
  references: '참고자료',
  missing: '아직 없어요',
  attach: '답변에 첨부',
  addMaterial: '파일 고르기…',
  make: '만들기',
  madeFiles: '만든 파일 — 누르면 열려요',
  noFiles: '아직 만든 파일이 없어요.',
  retry: '다시 시도',
  reveal: '폴더에서 보기',
  report: '문제 신고',
  reportTitle: '도우미가 내용을 정리해 보여 드리고, 확인하면 개발자에게 보내요',
  reportInline: '신고',
  reportPrefill: '신고할래 — ',
  reportError: (title: string) => `신고할래 — '${title}'가 떴어요. `,
  reportGuide: '하고 싶은 말을 덧붙여 보내 주세요. 보내기 전에 도우미가 신고 내용을 보여 드려요. 확인해야만 보내져요.',
  reportPermission: '허락을 먼저 정해 주세요.',
  reportDisconnected: '신고는 도우미가 정리해서 보내요. 먼저 AI를 연결해 주세요.',
  reportOffline: '지금 인터넷이 끊겨 있어요. 연결되면 보내 주세요 — 신고는 인터넷으로 개발자에게 전해져요.',
  reportNoFolder: '신고는 논문을 연 뒤 대화에서 할 수 있어요.'
} as const

export type SettingsSection = 'helper' | 'lanes' | 'folder' | 'trouble' | 'tools' | 'python' | 'info'
export function settingsSectionForFocus(focus: string | null): SettingsSection {
  if (focus?.startsWith('lanes:')) return 'lanes'
  if (focus?.startsWith('tools:')) return 'tools'
  if (focus?.startsWith('fix:')) return 'trouble'
  if (focus?.startsWith('folder:')) return 'folder'
  if (focus?.startsWith('python:')) return 'python'
  if (focus?.startsWith('info:')) return 'info'
  return 'helper'
}
