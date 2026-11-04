import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const APP_BRANCH = /^app-channel-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const CHANNEL_HEADS = name => name === 'skill-channel-update' || name.startsWith('app-channel-')

export function assertNoPendingChannelUpdates(openPullRequests, branchComparisons) {
  const open = openPullRequests.filter(name => CHANNEL_HEADS(name))
  if (open.length) throw new Error(`Open channel PR blocks this run: ${[...new Set(open)].sort().join(', ')}`)

  for (const { name, status } of branchComparisons) {
    if (!CHANNEL_HEADS(name)) continue
    if (name !== 'skill-channel-update' && !APP_BRANCH.test(name)) throw new Error('Unexpected app channel branch name; stop for review')
    if (status !== 'ahead' && status !== 'identical') throw new Error(`Channel branch ${name} contains commits not on main; stop and resolve it`)
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !process.env.GH_TOKEN) throw new Error('GitHub repository context is required')

  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls?state=open&per_page=100`]))
  const pullRequests = pages.flat().map(pr => pr.head?.ref).filter(name => typeof name === 'string')
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && pullRequests.some(CHANNEL_HEADS)) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n')
    console.log('Open app/skill channel PR; skipping scheduled channel update.')
    return
  }

  const mainRef = run('git', ['ls-remote', 'origin', 'refs/heads/main'])
  const mainSha = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(mainRef)?.[1]
  if (!mainSha) throw new Error('Could not resolve main commit')

  const refs = run('git', ['ls-remote', '--heads', 'origin', 'refs/heads/app-channel-*', 'refs/heads/skill-channel-update'])
  const branches = refs ? refs.split('\n').map(line => {
    const [sha, ref] = line.split('\t')
    const name = ref?.replace(/^refs\/heads\//, '')
    if (!/^[a-f0-9]{40}$/.test(sha) || !name || !CHANNEL_HEADS(name)) throw new Error('Unexpected channel branch reference; stop for review')
    const comparison = JSON.parse(run('gh', ['api', `repos/${repository}/compare/${sha}...${mainSha}`]))
    return { name, status: comparison.status }
  }) : []

  assertNoPendingChannelUpdates(pullRequests, branches)
  console.log('No open app/skill channel PRs or unmerged channel branches.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : 'Channel conflict check failed')
    process.exitCode = 1
  }
}
