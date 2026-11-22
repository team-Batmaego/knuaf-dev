import { useEffect, useId, useRef, useState } from 'react'
import { CLOSE_LABEL } from '../copy'
import { SUPPORT } from '../copy-support'
import { Icon } from './Icon'

const images = import.meta.glob<string>('../assets/support/{toss,kakaopay}.png', { eager: true, query: '?url', import: 'default' })
const methods = [
  { name: '토스', image: images['../assets/support/toss.png'] },
  { name: '카카오페이', image: images['../assets/support/kakaopay.png'] }
]

export function SupportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return <dialog ref={ref} className="sheet support-dialog" aria-labelledby={titleId}
    onClose={(event) => { if (event.target === ref.current) { setSelected(null); onClose() } }}
    onClick={(event) => { if (event.target === ref.current) onClose() }}>
    <div className="sheet-head"><h2 id={titleId}>{SUPPORT.title}</h2>
      <button className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" /></button>
    </div>
    <div className="sheet-body">
      <p className="support-message"><span>{SUPPORT.label}</span><br /><strong>{SUPPORT.first}<br />{SUPPORT.second}</strong></p>
      <div className="support-methods">
        {methods.map(method => <div className="support-method" key={method.name}>
          <strong>{method.name}</strong>
          {method.image ? <button className="support-qr-button" onClick={() => setSelected(selected === method.name ? null : method.name)} aria-label={`${method.name} QR 크게 보기`}>
            <img src={method.image} alt={`${method.name} 후원 QR`} />
          </button> : <p>{SUPPORT.unavailable}</p>}
        </div>)}
      </div>
      {selected && <div className="support-expanded">
        <button onClick={() => setSelected(null)} aria-label="큰 QR 닫기">×</button>
        <img src={methods.find(method => method.name === selected)?.image} alt={`${selected} 후원 QR 크게 보기`} />
      </div>}
    </div>
  </dialog>
}
