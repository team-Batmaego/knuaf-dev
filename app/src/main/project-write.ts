import { randomUUID } from 'node:crypto'
import { open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Prove a directory can create a file. Cleanup owns only a file created by this call. */
export async function probeProjectWritable(root: string, uuid: () => string = randomUUID): Promise<void> {
  let ownedProbe: string | null = null
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('선택한 위치가 폴더가 아닙니다.')
    const probePath = join(root, `.knuaf-write-test-${uuid()}`)
    const file = await open(probePath, 'wx')
    ownedProbe = probePath
    await file.close()
    await unlink(probePath)
    ownedProbe = null
  } catch (error) {
    if (ownedProbe) try { await unlink(ownedProbe) } catch { /* best-effort cleanup of this call's file only */ }
    throw error
  }
}
