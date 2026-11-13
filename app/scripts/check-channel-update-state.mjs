import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const APP_BRANCH = /^app-channel-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const CHANNEL_HEADS = name => name === 'skill-channel-update' || name.startsWith('app-channel-')

const COMMIT = /^[a-f0-9]{40}$/

// The archive tag carries the branch head SHA: a fixed name collides on the second cleanup of
// the same channel, and a failed `git tag` used to fall through to the delete anyway.
export function archiveTag(name, sha) {
  if (!COMMIT.test(sha ?? '')) throw new Error('A full branch head commit SHA is required to name the archive tag')
  return `archive/${name}-${sha.slice(0, 7)}`
}

// Every command is chained with && so a failed step stops the run before the branch is deleted.
// The tag target is the FULL SHA read from the remote in this check, fetched by value: the local
// `origin/<name>` tracking ref can still point at an older proposal, and tagging it would archive
// the wrong commit while the branch is deleted anyway. The tag is lightweight on purpose so the
// push and the origin read-back both show that commit's own SHA. Re-running on a different head
// names a different tag, so the older archive is never overwritten.
export function cleanupCommands(name, sha) {
  const tag = archiveTag(name, sha)
  return [
    `  git fetch origin ${sha} \\`,
    `    && test "$(git rev-parse FETCH_HEAD)" = ${sha} \\`,
    `    && git tag ${tag} ${sha} \\`,
    `    && git push origin refs/tags/${tag} \\`,
    `    && test "$(git ls-remote origin refs/tags/${tag} | cut -f1)" = ${sha} \\`,
    `    && git push origin --delete ${name}`
  ].join('\n')
}

export function channelConflicts(openPullRequests, branchComparisons) {
  const blocking = []
  const invalid = []
  const open = [...new Set(openPullRequests.filter(name => CHANNEL_HEADS(name)))].sort()
  if (open.length) {
    blocking.push(`Open channel PR blocks this run: ${open.join(', ')}. Merge or close it before running again.`)
  }

  for (const { name, status, sha } of branchComparisons) {
    if (!CHANNEL_HEADS(name)) continue
    if (name !== 'skill-channel-update' && !APP_BRANCH.test(name)) {
      invalid.push(`Unexpected app channel branch name '${name}'; stop for review.`)
      continue
    }
    if (status === 'ahead' || status === 'identical') continue
    blocking.push([
      `Channel branch ${name} contains commits not on main (${status}); it still holds an unmerged channel proposal.`,
      'If that proposal was merged as squash/rebase or closed without merging, archive the exact head commit and delete only after the tag is on origin:',
      cleanupCommands(name, sha)
    ].join('\n'))
  }
  return { blocking, invalid }
}

// pendingNewRelease is whether this run has something to publish. Without work to publish a
// conflict is only a warning: a daily schedule must stay green when the channel is idle.
// A branch name the guard does not recognise is never a warning; it means the state changed
// in a way nobody reviewed.
export function assertNoPendingChannelUpdates(openPullRequests, branchComparisons, { pendingNewRelease = true } = {}) {
  const { blocking, invalid } = channelConflicts(openPullRequests, branchComparisons)
  if (invalid.length) throw new Error(invalid.join('\n\n'))
  if (blocking.length && pendingNewRelease) {
    throw new Error(`${blocking.join('\n\n')}\n\nThis run has work to publish, so it must fail instead of reporting success.`)
  }
  return { conflicts: blocking }
}

// execFileSync's default ceiling is 1 MB and it kills the child with ENOBUFS past that. The
// compare payload is the whole diff between a channel head and main: `app-channel-v0.6.1` came
// back at 1.5 MB, so the guard died before it judged anything. Only two fields are read here —
// the open PR head refs and each compare status — so gh narrows the response with --jq, and the
// ceiling stays far above any reply that survives that narrowing.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export function runCommand(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES }).trim()
}

// `run` is injected so tests can drive the whole read without a live GitHub or a stubbed PATH.
export function readChannelState({ repository, pendingNewRelease = true, run = runCommand }) {
  const heads = run('gh', ['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`, '--jq', '.[] | .head.ref // empty'])
  const pullRequests = heads ? heads.split('\n').map(line => line.trim()).filter(Boolean) : []

  const mainRef = run('git', ['ls-remote', 'origin', 'refs/heads/main'])
  const mainSha = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(mainRef)?.[1]
  if (!mainSha) throw new Error('Could not resolve main commit')

  const refs = run('git', ['ls-remote', '--heads', 'origin', 'refs/heads/app-channel-*', 'refs/heads/skill-channel-update'])
  const branches = refs ? refs.split('\n').map(line => {
    const [sha, ref] = line.split('\t')
    const name = ref?.replace(/^refs\/heads\//, '')
    if (!COMMIT.test(sha ?? '') || !name || !CHANNEL_HEADS(name)) throw new Error('Unexpected channel branch reference; stop for review')
    // `.status // empty` prints nothing when GitHub sends no status, so the value stays undefined
    // and the conflict message reads exactly as it did when the whole compare body was parsed —
    // an unknown status blocks instead of silently passing.
    return { name, status: run('gh', ['api', `repos/${repository}/compare/${sha}...${mainSha}`, '--jq', '.status // empty']) || undefined, sha }
  }) : []

  return assertNoPendingChannelUpdates(pullRequests, branches, { pendingNewRelease })
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !process.env.GH_TOKEN) throw new Error('GitHub repository context is required')

  const rawPending = process.env.CHANNEL_PENDING_NEW_RELEASE
  if (rawPending !== undefined && rawPending !== 'true' && rawPending !== 'false') {
    throw new Error('CHANNEL_PENDING_NEW_RELEASE must be true or false when set')
  }
  const pendingNewRelease = rawPending !== 'false'

  let conflicts
  try {
    ({ conflicts } = readChannelState({ repository, pendingNewRelease }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Channel guard blocked this run\n\n\`\`\`\n${message}\n\`\`\`\n`)
    }
    throw error
  }

  if (conflicts.length) {
    console.log(`Channel conflicts present, but there is no new skill release to publish:\n\n${conflicts.join('\n\n')}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Channel guard: nothing to publish this run\n\n${conflicts.join('\n\n')}\n\nThis run reported success only because no new skill release is pending. Clean up the channel state above so the next release is not blocked.\n`)
    }
    return
  }
  console.log('No open app/skill channel PRs or unmerged channel branches.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : 'Channel conflict check failed')
    process.exitCode = 1
  }
}
