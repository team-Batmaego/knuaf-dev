/**
 * 진짜 스킬 CLI → 앱 설치·수집·러너 → 기존 가짜 app-server → 본대화 전달.
 * AI·로그인 호출 없음. 기본 CI 미선택은 skip(수락 증거 아님).
 * 수락 실행은 KNUAF_REAL_SKILL_REQUIRED=1: 경로 누락·옛 판도 실패한다.
 * KNUAF_REAL_SKILL=<skills/knuaf-doc> KNUAF_REAL_SKILL_PYTHON=<python 절대경로>
 * KNUAF_REAL_SKILL_VERSION=0.5.3 은 최종 핀 확인용(정확히 일치해야 함).
 * 기본 playwright.config.ts 사용. Electron·build 산출물에 의존하지 않는다.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { installSkill, skillVersion } from '../src/main/agent'
import { canonical, sha256 } from '../src/main/chat/jobs/isolation'
import { JobStore } from '../src/main/chat/jobs/store'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { ExecutionAccount, JobRecord, JobSpec, RelayRequest } from '../src/main/chat/jobs/types'
import { openCard } from '../src/main/lanes/cards'
import { checkLaneRequest, planFromRow, type LaneRequest } from '../src/shared/lanes'
import { codexRelayLauncher } from './fixtures/relay-launcher'
import { FileProducingFakeRelay, realSkill, RELAY_RESULT, runSkill } from './fixtures/real-skill'

const selected = process.env.KNUAF_REAL_SKILL !== undefined || process.env.KNUAF_REAL_SKILL_REQUIRED === '1'
  || process.env.KNUAF_REAL_SKILL_VERSION !== undefined || process.env.KNUAF_REAL_SKILL_PYTHON !== undefined

test.skip(!selected, '실 스킬 수락 실행이 아님 — KNUAF_REAL_SKILL_REQUIRED=1과 스킬·Python 절대경로를 지정해요')

function json<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T }

// 기존 fake-codex-relay.mjs가 실제로 돌려주는 가짜 계정·목록과 같아야 지문 대조를 통과한다.
const fakeAccount = (): ExecutionAccount => ({
  accountId: 'acct-1', connected: true,
  account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'gpt-5-codex', name: 'GPT-5 Codex', efforts: ['low', 'high'] }] },
  consented: false, usage: 'allowed'
})

for (const origin of ['source', 'installed'] as const) {
  test(`real delegate (${origin}) → app collection → fake engine → delivered completion`, async () => {
    const skill = realSkill()
    const base = canonical(mkdtempSync(join(tmpdir(), `kd-real-${origin}-`)))
    const root = join(base, '논문 폴더')
    const userData = join(base, 'app-data')
    mkdirSync(root)
    const original = '{"original":true}\n'
    writeFileSync(join(root, 'project.json'), original)
    const id = `real-${origin}`
    const logFile = join(base, 'fake-relay.jsonl')
    const wrapper = codexRelayLauncher(base, resolve(__dirname, 'fixtures', 'fake-codex-relay.mjs'))
    const mainRuns: string[] = []
    const requests: RelayRequest[] = []
    const diagnostics: string[] = []
    const errors = console.error
    console.error = (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); errors(...args) }
    let produced: JobSpec | undefined
    let installedSkill = ''
    const service = new ChatService({
      skillSource: () => skill.source, userData, emit: () => {}, openExternal: async () => {},
      connectionFactory: (_provider, options): AgentConnection => {
        installedSkill = options.skill
        return {
          status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
          login: async () => { throw new Error('이 시험은 로그인하지 않아요') },
          respond: () => {}, stop: async () => {},
          run: async (text, _sessionId, events) => {
            mainRuns.push(text)
            events.session('main-real-skill')
            if (mainRuns.length !== 1) return
            // 앱 send()가 설치한 사본을 그대로 사용한다. delegation.json을 수동으로 보충하지 않는다.
            expect(installedSkill).not.toBe(skill.source)
            expect(existsSync(join(installedSkill, 'delegation.json'))).toBe(true)
            expect(readFileSync(join(installedSkill, 'delegation.json'), 'utf8'))
              .toBe(readFileSync(join(skill.source, 'delegation.json'), 'utf8'))
            const result = runSkill(skill, origin === 'installed' ? installedSkill : skill.source, root, 'delegate', [
              '--lane', 'writing', '--task', '입력 정본을 읽고 result.md에 짧게 정리해 줘',
              '--input-ref', 'project|project.json|원본', '--output', 'result.md',
              '--company', 'codex', '--model', 'gpt-5-codex', '--effort', 'high', '--job-id', id
            ])
            expect(result).toMatchObject({ status: 'created', job_id: id, schema: 1, contractVersion: 'role-v1' })
            produced = json<JobSpec>(join(root, '.knuaf-gui', 'jobs', `${id}.json`))
            expect(produced).toMatchObject({ schema: 1, id, lane: 'writing', outputs: ['result.md'],
              contractVersion: 'role-v1', company: 'codex', model: 'gpt-5-codex', effort: 'high',
              inputs: [{ sourceId: 'project', path: join(root, 'project.json'), hash: sha256(original), section: '원본' }] })
            expect(produced).not.toHaveProperty('status')
          }
        }
      },
      jobConnectionFactory: request => {
        requests.push(request)
        if (request.company !== 'codex') throw new Error('가짜 Codex 외의 연결은 금지해요')
        return new FileProducingFakeRelay({
          binary: wrapper, root: request.cwd, skill: request.skill, openExternal: async () => {},
          // 실제 자격증명 환경을 넘기지 않는다. binary는 위에서 만든 기존 가짜 전용 래퍼다.
          env: { PATH: process.env.PATH, KD_FAKE_CODEX_LOG: logFile,
            KD_FAKE_SKILL_ROOT: dirname(request.skill), KD_FAKE_ALLOWED: 'true' }
        }, request)
      },
      jobAccount: async company => company === 'codex' ? fakeAccount() : null,
      jobShellSandboxAvailable: true
    })
    try {
      const plan = planFromRow('both-high')
      plan.writing = { company: 'codex', model: 'gpt-5-codex', effort: 'high', how: 'relay' }
      service.approvePlan(root, plan)
      service.setConsent('codex', 'acct-1', true)
      await service.send(root, 'codex', '진짜 스킬로 글쓰기 위임을 만들어 줘', `request-${id}`)
      const manifestFile = join(root, '.knuaf-gui', 'jobs', `${id}.json`)
      const deliveries = () => service.snapshot(root, 'codex').messages.filter(message => message.text.startsWith('자료 담당('))
      await expect.poll(() => ({ status: existsSync(manifestFile) ? json<JobRecord>(manifestFile).status : null,
        deliveries: deliveries().length, busy: service.busy(root) }), { timeout: 30_000 })
        .toEqual({ status: 'completed', deliveries: 1, busy: false })
      expect(produced).toBeDefined()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ jobId: id, company: 'codex', skill: installedSkill,
        cwd: join(root, '.knuaf-gui', 'jobs', id, 'out'), model: 'gpt-5-codex', effort: 'high' })
      const record = json<JobRecord>(manifestFile)
      expect(record.sessionId).toBe('thread-fake')
      expect(record.sessionId).not.toBe(record.owner.sessionId)
      expect(record.outputs).toEqual(['result.md']) // 공개 manifest는 spec.outputs를 유지한다.
      expect(json<{ outputRefs: string[] }>(manifestFile).outputRefs).toEqual([join(requests[0].cwd, 'result.md')])
      expect(readFileSync(join(requests[0].cwd, 'result.md'), 'utf8')).toBe(RELAY_RESULT)
      expect(mainRuns).toHaveLength(2)
      expect(mainRuns[1]).toContain('작업 끝')
      expect(mainRuns[1]).toContain(`jobs/${id}/out/result.md`)
      expect(deliveries()[0].role).toBe('system')
      expect(diagnostics.filter(line => line.includes('collect-disabled'))).toEqual([])
      expect(readFileSync(join(root, 'project.json'), 'utf8')).toBe(original)
      const journal = json<{ deliveries: Record<string, { state: string }> }>(join(userData, 'jobs', 'store.json'))
      expect(journal.deliveries[id].state).toBe('done')
      const log = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(log.filter(entry => entry.method === 'turn/start')).toHaveLength(1)
      expect(log.find(entry => entry.method === 'thread/start').params.cwd).toBe(requests[0].cwd)
      // 다음 학생 차례가 같은 실제 주문을 다시 실행·전달하지 않는다.
      await service.send(root, 'codex', '결과 확인했어', `next-${id}`)
      await expect.poll(() => service.busy(root)).toBe(false)
      expect(requests).toHaveLength(1)
      expect(deliveries()).toHaveLength(1)
    } finally {
      try { await service.close() } finally { console.error = errors }
    }
  })
}

test('real installed lanes-propose → checkLaneRequest and openCard preserve rows and quote (contract only)', async () => {
  const skill = realSkill()
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-real-lanes-')))
  const root = join(base, '논문 폴더')
  mkdirSync(root)
  const target = join(root, '.agents', 'skills', 'knuaf-dev')
  installSkill(skill.source, target, skillVersion(skill.source), skill.source)
  const quote = '  글쓰기는 Sonnet으로, 반복 작업은 직접 맡아 줘.\n검토는 Astra 높음으로 해 줘.  '
  const result = runSkill(skill, target, root, 'lanes-propose', [
    '--lane-scope', 'continue', '--quote', quote,
    '--lane-request', 'writing=claude:sonnet', '--lane-request', 'repeat=main',
    '--lane-request', 'review=codex:gpt-6.1-astra:high'
  ])
  expect(result).toMatchObject({ status: 'proposed', schema: 1, lanes: 3 })
  const request = json<LaneRequest & { schema: number }>(join(root, '.knuaf-gui', 'lanes-request.json'))
  expect(request).toEqual({ schema: 1, scope: 'continue', quote,
    lanes: { writing: { company: 'claude', model: 'sonnet' }, repeat: { main: true },
      review: { company: 'codex', model: 'gpt-6.1-astra', effort: 'high' } } })
  const claude: ExecutionAccount = {
    accountId: 'fake-claude', connected: true, consented: false, usage: 'allowed',
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max',
      models: ['opus', 'sonnet', 'haiku'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
  }
  const codex: ExecutionAccount = {
    accountId: 'fake-codex', connected: true, consented: false, usage: 'allowed',
    account: { company: 'codex', accountType: 'chatgpt',
      models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']
        .map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
  }
  const checked = checkLaneRequest(request, [claude.account, codex.account])
  expect(checked.rejected).toEqual([])
  expect(checked.accepted).toEqual([
    { lane: 'writing', main: false, company: 'claude', model: 'sonnet', effort: null },
    { lane: 'repeat', main: true, company: null, model: null, effort: null },
    { lane: 'review', main: false, company: 'codex', model: 'gpt-6.1-astra', effort: 'high' }
  ])
  const store = new JobStore(join(base, 'app-jobs'))
  const card = await openCard({ store, mainCompany: 'claude',
    account: async company => company === 'claude' ? claude : codex }, root, request)
  expect(card.quote).toBe(quote)
  expect(card.state).toEqual({ kind: 'open' })
  expect(card.rows.map(row => row.lane)).toEqual(['writing', 'repeat', 'review'])
  expect(card.rows.every(row => row.rejected === null)).toBe(true)
  expect(card.rows.find(row => row.lane === 'writing')?.after)
    .toEqual({ company: 'claude', model: 'sonnet', effort: null, how: 'relay' })
  expect(card.rows.find(row => row.lane === 'repeat')?.after)
    .toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  expect(card.rows.find(row => row.lane === 'review')?.after)
    .toEqual({ company: 'codex', model: 'gpt-6.1-astra', effort: 'high', how: 'relay' })
  // v0.7에는 이 파일 감시·자동 카드 진입이 없다. 직접 계약 함수에 넘긴 결과만 검증한다.
})
