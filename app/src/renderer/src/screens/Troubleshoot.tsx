import { useCallback, useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { preparationFailureTitle, usePrep } from '../store/prep'
import { rpc } from '../rpc'
import { Disclosure } from '../components/Disclosure'
import { Feedback } from '../components/Feedback'
import { Confirm } from '../components/Confirm'
import { Badge, StatusBadge } from '../components/Badge'
import { ProgressPanel } from '../components/ProgressPanel'
import { useRunner } from '../components/useRunner'
import { Icon } from '../components/Icon'
import { COMPLETION, EMPTY, KORDOC_SENTENCE, LOCK_COPY, STATUS_LABEL, describeError, type DescribedError } from '../copy'
import type { HistoryRow, LockInfo } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/**
 * The five troubleshooting 펼침들, embedded in 설정 > 문제 해결 (03-화면/08).
 * Failure feedback deep-links land on `data-preset="fix:<id>"`.
 */
export function TroubleshootSections() {
  const { root, hasProject, status, refresh, refreshSidecar, sidecar } = useProject(useShallow((s) => ({ root: s.root, hasProject: s.hasProject, status: s.status, refresh: s.refresh, refreshSidecar: s.refreshSidecar, sidecar: s.sidecar })))
  const preparation = usePrep(s => root ? s.dependencies[root] : undefined)
  const [diagnosis, setDiagnosis] = useState<{ root: string; data: Record<string, any> } | null>(null)
  const doc = diagnosis?.root === root ? diagnosis.data : null
  const requestSeq = useRef(0)
  const lockRequestSeq = useRef(0)
  const [lockObservation, setLockObservation] = useState<{ root: string; data: LockInfo } | null>(null)
  const [lockErr, setLockErr] = useState<DescribedError | null>(null)
  const [lockBusy, setLockBusy] = useState(false)
  const [err, setErr] = useState<DescribedError | null>(null)
  const [msg, setMsg] = useState<{ title: string; body?: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'unlock' | 'restore' | 'init'; rev?: number } | null>(null)
  const deps = useRunner()
  const kordoc = useRunner()
  const load = useCallback(async () => {
    if (!root) return
    const seq = ++requestSeq.current
    const lockSeq = ++lockRequestSeq.current
    setErr(null); setDiagnosis(null); setLockObservation(null); setLockErr(null); setLockBusy(true)
    // Lock inspection must not wait for dependency imports or the aggregate folder scan.
    const inspected = rpc.lockInfo(root).then((data) => {
      if (lockSeq === lockRequestSeq.current) setLockObservation({ root, data })
    }).catch((e: unknown) => {
      if (lockSeq === lockRequestSeq.current) setLockErr(describeError(e))
    }).finally(() => {
      if (lockSeq === lockRequestSeq.current) setLockBusy(false)
    })
    const checked = useProject.getState().prepareDeps(root, { install: false })
    const diagnosed = rpc.doctor(root).then((data) => {
      if (seq === requestSeq.current) setDiagnosis({ root, data })
    }).catch((e: unknown) => {
      if (seq === requestSeq.current) setErr(describeError(e))
    })
    await Promise.all([inspected, checked, diagnosed])
  }, [root])
  useEffect(() => {
    setErr(null); setMsg(null); setConfirm(null)
    void load(); void refreshSidecar()
    return () => { ++requestSeq.current; ++lockRequestSeq.current }
  }, [load, status?.revision])
  if (!root) return <div className="caption">먼저 "내 논문"에서 폴더를 여세요.</div>
  const lock = lockObservation?.root === root ? lockObservation.data : undefined
  const hist: HistoryRow[] = Array.isArray(doc?.snapshots) ? doc!.snapshots : []
  const depsInfo = preparation?.report
  const act = async () => {
    if (!confirm) return
    const c = confirm; setConfirm(null); setErr(null); setMsg(null); setLockBusy(true)
    const seq = requestSeq.current
    const visit = preparation?.visit
    const mine = (): boolean => seq === requestSeq.current && useProject.getState().root === root && usePrep.getState().dependencies[root]?.visit === visit
    try {
      if (c.kind === 'unlock') {
        const r = await rpc.unlock(root)
        if (mine()) setMsg({ title: r.owner_cleaned ? LOCK_COPY.cleaned : LOCK_COPY.nothingCleaned })
      }
      if (c.kind === 'restore' && c.rev != null && status) {
        const r = await rpc.restore(root, c.rev, status.revision)
        if (mine()) setMsg({ title: COMPLETION.restored, body: `${r.restored_from}번째 기록의 정본을 ${r.revision}번째 기록으로 되돌렸어요. 복원 직전 상태는 ${r.pre_restore_snapshot}에 남아 있어요.` })
      }
      if (c.kind === 'init') { await rpc.init(root); if (mine()) setMsg({ title: COMPLETION.init_done }) }
      if (!mine()) return
      await refresh()
      if (mine()) await load()
    } catch (e) { if (mine()) setErr(describeError(e)) }
    finally { if (mine()) setLockBusy(false) }
  }
  const ensureDeps = async () => {
    const seq = requestSeq.current
    const visit = preparation?.visit
    setErr(null); setMsg(null)
    const result = await deps.runDeps(root)
    if (seq !== requestSeq.current || useProject.getState().root !== root || usePrep.getState().dependencies[root]?.visit !== visit) return
    if (result?.phase === 'ready') { setMsg({ title: COMPLETION.deps_ready, body: '프로젝트 .venv의 import·버전을 확인했어요.' }); await refreshSidecar(); await load() }
  }
  const prepareKordoc = async () => {
    setErr(null); setMsg(null)
    const env = await kordoc.run('kordoc.ensure', { root })
    if (env?.ok) { setMsg({ title: COMPLETION.kordoc_ready }); await load() }
    else if (env) setErr(describeError({ code: 'business_rule', message: env.block_reason ?? env.stderr.slice(-300) }))
  }
  const probe = async () => {
    const seq = ++lockRequestSeq.current
    setLockBusy(true); setLockErr(null); setMsg(null)
    try {
      const observed = await rpc.lockInfo(root, true)
      if (seq === lockRequestSeq.current) setLockObservation({ root, data: observed })
    } catch (e) { if (seq === lockRequestSeq.current) setLockErr(describeError(e)) }
    finally { if (seq === lockRequestSeq.current) setLockBusy(false) }
  }
  const canCleanup = lock?.structure === 'ready' && lock.lock_state === 'free' && !!lock.owner
  const orphans: string[] = doc?.gg?.orphan_files ?? []
  return (
    <div>
      <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
        <button className="quiet" disabled={lockBusy} onClick={load}><Icon name="refresh" size={16} /> 다시 진단</button>
      </div>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      {msg && <Feedback kind="completion" title={msg.title} body={msg.body} />}
      {!hasProject && <Feedback kind="warning" title="이 폴더에는 아직 정본(project.json)이 없어요" body="보통 도우미가 '시작하기'로 만들어요. 새 빈 폴더가 확실하면 여기서 만들 수도 있어요." actions={<button onClick={() => setConfirm({ kind: 'init' })}>빈 정본 만들기</button>} />}

      <Disclosure label="준비 상태" preset="fix:deps">
        <div className="card-head"><h2>준비 상태</h2><StatusBadge status={preparation?.phase === 'ready' ? 'pass' : 'blocked'} label={preparation?.phase === 'ready' ? '준비됨' : preparation?.phase === 'blocked' ? '준비 중단' : '확인·준비 중'} /></div>
        <div className="caption">실행기 <code>{sidecar?.python}</code> <Badge label={sidecar?.kind ?? ''} /> {sidecar?.running ? <Badge tone="pass" label="실행 중" /> : <Badge tone="fail" label="꺼짐" />}</div>
        {depsInfo && (
          <table style={{ marginTop: 'var(--sp-3)' }}>
            <thead><tr><th>패키지</th><th>용도</th><th>상태</th></tr></thead>
            <tbody>{(depsInfo.dependencies ?? []).map((d: any) => <tr key={d.dist}><td><code>{d.dist}</code></td><td>{d.purpose}</td><td><StatusBadge status={d.status} /></td></tr>)}</tbody>
          </table>
        )}
        {preparation?.phase === 'blocked' && <Feedback kind="warning" title={preparationFailureTitle(preparation.error)}
          body="쓴 글은 그대로 남아 있어요. 원인을 확인하고 다시 준비해 주세요." details={<code>{preparation.error?.message}</code>} />}
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <button className="primary" disabled={deps.busy} onClick={ensureDeps}>{deps.busy ? '준비 중…' : '패키지 준비'}</button>
          <span className="caption">프로젝트 폴더 안 <code>.venv</code>에만 설치해요. 전역 Python은 건드리지 않아요.</span>
        </div>
        <ProgressPanel busy={deps.busy} phase={deps.phase} elapsedMs={deps.elapsedMs} lines={deps.lines} onCancel={deps.clientId ? deps.cancel : undefined} />
      </Disclosure>

      <Disclosure label={LOCK_COPY.label} preset="fix:lock">
        <div className="card-head">
          <h2>{LOCK_COPY.label}</h2>
          {lock && <StatusBadge status={lock.structure === 'ready' ? 'pass' : 'blocked'} label={LOCK_COPY.structure[lock.structure] ?? lock.structure} />}
        </div>
        {lockBusy && !lock && <div className="caption" role="status" aria-busy="true"><span className="spin" /> {LOCK_COPY.probing}</div>}
        {lockErr && <Feedback kind={lockErr.kind} title={lockErr.title} body={lockErr.action} details={<code>{lockErr.raw}</code>} />}
        {lock && (
          <div>
            <StatusBadge status={lock.lock_state === 'free' ? 'pass' : lock.lock_state === 'busy' ? 'blocked' : 'pending'} label={LOCK_COPY.state[lock.lock_state] ?? lock.lock_state} />
            <p className="caption">{LOCK_COPY.observation}</p>
            <div className="caption">{LOCK_COPY.observedAt}: <time>{lock.observed_at}</time></div>
            {lock.owner && <p><strong>{LOCK_COPY.owner}</strong><br />{LOCK_COPY.ownerBody}</p>}
            {lock.structure !== 'ready' && <Feedback kind="warning" title={LOCK_COPY.structure[lock.structure] ?? LOCK_COPY.unavailable} body={LOCK_COPY.recovery} />}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <button disabled={lockBusy || lock.structure !== 'ready'} onClick={probe}>{lockBusy ? LOCK_COPY.probing : LOCK_COPY.probe}</button>
              <button className="danger" disabled={lockBusy || !canCleanup} onClick={() => setConfirm({ kind: 'unlock' })}>{LOCK_COPY.cleanup}</button>
            </div>
            <p className="caption">{LOCK_COPY.cleanupBody}</p>
            <details><summary>{LOCK_COPY.details}</summary><pre>{JSON.stringify(lock, null, 2)}</pre></details>
          </div>
        )}
      </Disclosure>

      <Disclosure label="이전 원고 스냅샷" preset="fix:snapshots">
        <div className="card-head"><h2>이전 원고 스냅샷</h2><Badge label={`${Math.max(hist.length - 1, 0)}개`} /></div>
        <p className="caption">저장할 때마다 직전 정본이 <code>migration/revision-N.json</code>에 남아요. 복원은 새 개정으로 기록되고 장 파일·원문·build 폴더는 그대로예요.</p>
        {hist.length <= 1 ? <div className="caption">{EMPTY.snapshots.title}</div> : (
          <div className="list">
            {hist.map((h) => (
              <div key={h.revision} className="item">
                <div className="head"><span><strong>{h.revision}번째 기록</strong>{h.current ? <span className="caption"> · 현재</span> : null} <code className="muted">{h.request_id ?? ''}</code></span>
                  <span className="row">{h.current ? null : h.snapshot_ok ? <StatusBadge status="pass" label="해시 일치" /> : <StatusBadge status="fail" label="없음/불일치" />}{!h.current && h.snapshot_ok && <button onClick={() => setConfirm({ kind: 'restore', rev: h.revision })}>이 기록으로 복원</button>}</span></div>
              </div>
            ))}
          </div>
        )}
      </Disclosure>

      <Disclosure label="남은 임시 파일" preset="fix:orphans">
        <div className="card-head"><h2>남은 임시 파일</h2><Badge label={`${orphans.length}개`} /></div>
        {orphans.length === 0 ? <div className="caption">{EMPTY.orphans.title}</div> : orphans.map((p) => <div key={p} className="row"><code>{p}</code><button className="quiet" onClick={() => window.knuaf.reveal(p)}>보기</button></div>)}
        <div className="caption" style={{ marginTop: 'var(--sp-2)' }}>다른 작성자의 것일 수 있어 앱이 지우지 않아요.</div>
      </Disclosure>

      <Disclosure label="문서 읽기 도구" preset="fix:kordoc">
        <div className="card-head"><h2>문서 읽기 도구</h2>{doc?.kordoc && !doc.kordoc.error && <StatusBadge status={doc.kordoc.capability_verified ? 'pass' : 'pending'} label={doc.kordoc.installed ? STATUS_LABEL.installed : STATUS_LABEL.missing} />}</div>
        {doc?.kordoc && !doc.kordoc.error && <div className="caption">{doc.kordoc.cli_path ? <code>{doc.kordoc.cli_path}</code> : '아직 없어요.'} · 캐시 {doc.kordoc.candidates?.some((c: { installed: boolean }) => c.installed) ? '있음' : '없음'}</div>}
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <button disabled={kordoc.busy || !!doc?.kordoc?.cli_path} onClick={prepareKordoc}>{kordoc.busy ? '준비 중…' : '도구 준비'}</button>
          <span className="caption">{KORDOC_SENTENCE}</span>
        </div>
        <ProgressPanel busy={kordoc.busy} phase={kordoc.phase} elapsedMs={kordoc.elapsedMs} lines={kordoc.lines} onCancel={kordoc.cancel} />
      </Disclosure>

      <Confirm open={confirm?.kind === 'unlock'} title={LOCK_COPY.cleanup} body={<p>{LOCK_COPY.cleanupBody}</p>} confirmLabel={LOCK_COPY.cleanup} danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'restore'} title={`${confirm?.rev}번째 기록으로 복원`} body={<p><b>현재 상태를 먼저 저장해요.</b> 그다음 정본만 {confirm?.rev}번째 기록 시점으로 되돌리고 새 기록 번호를 붙여요. 장 파일과 발행물은 그대로예요.</p>} confirmLabel="복원" danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'init'} title="빈 정본 만들기" body={<p>이 폴더에 새 정본을 만들어요. 기존 정본이 있으면 만들지 않아요.</p>} onConfirm={act} onCancel={() => setConfirm(null)} />
    </div>
  )
}
