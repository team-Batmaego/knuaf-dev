import { Sheet } from './Sheet'

export function Confirm({ open, title, body, confirmLabel = '진행', danger, confirmDisabled, onConfirm, onCancel }: {
  open: boolean; title: string; body: React.ReactNode; confirmLabel?: string; danger?: boolean
  /** 본문의 확인 칸을 채우기 전까지 진행 단추를 막는다. */
  confirmDisabled?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  return (
    <Sheet open={open} title={title} onClose={onCancel} foot={<><button onClick={onCancel}>취소</button><button className={danger ? 'danger' : 'primary'} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button></>}>
      {body}
    </Sheet>
  )
}
