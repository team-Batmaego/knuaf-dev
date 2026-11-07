import { expect, test } from '@playwright/test'
import { useProject } from '../src/renderer/src/store/project'

test('느린 예전 목록이 새로 읽은 파일을 지우지 않는다', async () => {
  const oldWindow = globalThis.window
  let count = 0
  const old = Promise.withResolvers<unknown>()
  Object.assign(globalThis, { window: { knuaf: { call: async (method: string) => {
    if (method === 'artifact.list') return ++count === 1 ? old.promise : { result: { items: [{ path: '검토용_초안.docx', name: '검토용_초안.docx', kind: 'docx' }] } }
    return { result: null }
  } } } })
  try {
    useProject.setState({ root: '/paper', artifacts: null })
    const first = useProject.getState().loadLists()
    await useProject.getState().loadLists()
    old.resolve({ result: { items: [] } })
    await first
    expect(useProject.getState().artifacts?.map((item) => item.path)).toEqual(['검토용_초안.docx'])
  } finally {
    useProject.setState({ root: null, artifacts: null })
    Object.assign(globalThis, { window: oldWindow })
  }
})
