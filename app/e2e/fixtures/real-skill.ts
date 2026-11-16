import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CodexRelayConnection } from '../../src/main/chat/codex'
import type { JobEvents, RelayRequest } from '../../src/main/chat/jobs/types'

export interface RealSkill { source: string; python: string; version: string }

/** 지정한 실물만 쓴다. 옛 동봉본·PATH의 다른 Python으로 자동 대체하지 않는다. */
export function realSkill(): RealSkill {
  const sourcePath = process.env.KNUAF_REAL_SKILL
  const pythonPath = process.env.KNUAF_REAL_SKILL_PYTHON
  if (!sourcePath || !pythonPath || !isAbsolute(sourcePath) || !isAbsolute(pythonPath)) {
    throw new Error('KNUAF_REAL_SKILL·KNUAF_REAL_SKILL_PYTHON에 실물의 절대경로가 필요해요')
  }
  const source = realpathSync(sourcePath)
  if (!existsSync(pythonPath)) throw new Error('지정한 Python이 없어요')
  const python = pythonPath
  for (const file of ['SKILL.md', 'version.json', 'delegation.json', 'scripts/gg.py']) {
    if (!existsSync(join(source, file))) throw new Error(`진짜 스킬에 필요한 파일이 없어요: ${file}`)
  }
  const { version } = JSON.parse(readFileSync(join(source, 'version.json'), 'utf8')) as { version: string }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!parts || (Number(parts[1]) === 0 && (Number(parts[2]) < 5 || (Number(parts[2]) === 5 && Number(parts[3]) < 2)))) {
    throw new Error(`진짜 스킬은 0.5.2 이상이어야 해요: ${version}`)
  }
  const expected = process.env.KNUAF_REAL_SKILL_VERSION
  if (expected && version !== expected) throw new Error(`진짜 스킬 판이 달라요: expected ${expected}, got ${version}`)
  return { source, python, version }
}

/** gg.py subprocess만 실행한다. 모델·로그인·네트워크를 열지 않는다. */
export function runSkill(skill: RealSkill, from: string, root: string, command: 'delegate' | 'lanes-propose', args: string[]): Record<string, unknown> {
  const stdout = execFileSync(skill.python, ['-B', join(from, 'scripts', 'gg.py'), command, root, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 1024 * 1024
  })
  return JSON.parse(stdout) as Record<string, unknown>
}

export const RELAY_RESULT = '# 가짜 엔진 결과\n\n실제 AI 호출 없이 위임 왕복을 확인했어요.\n'

/** 기존 가짜 app-server는 파일을 쓰지 않는다. 완료 뒤에만 정해진 시험 결과를 만든다. */
export class FileProducingFakeRelay extends CodexRelayConnection {
  constructor(options: ConstructorParameters<typeof CodexRelayConnection>[0], private outputRequest: RelayRequest) {
    super(options, outputRequest)
  }

  override async runJob(text: string, events: JobEvents): Promise<void> {
    await super.runJob(text, events)
    writeFileSync(join(this.outputRequest.cwd, 'result.md'), RELAY_RESULT)
  }
}
