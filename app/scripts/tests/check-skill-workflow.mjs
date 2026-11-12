import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanupCommands } from '../check-channel-update-state.mjs'

// Resolved with git ls-remote and confirmed through each repository's Git commit API.
// Changing a pin requires reviewing the upstream commit and changing this allowlist too.
export const ACTION_COMMITS = Object.freeze({
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262', // v4
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020', // v4
  'actions/setup-python': 'a26af69be951a213d495a4c3e4e4022e16d87065', // v5
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02', // v4
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093', // v4
  'peter-evans/create-pull-request': '22a9089034f40e5a961c8808d113e2c98fb63676' // v7
})

export function checkWorkflowPins(text) {
  const refs = []
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*#/.test(line) || !/["']?uses["']?\s*:/.test(line)) continue
    // This workflow's policy requires a literal, single-line uses key, not YAML aliases/folding.
    const match = /^\s*(?:-\s+)?uses:\s*([\w-]+\/[\w.-]+)@([a-f0-9]{40})\s*(?:#.*)?$/.exec(line)
    if (!match || ACTION_COMMITS[match[1]] !== match[2]) {
      throw new Error(`Unreviewed or mutable action reference at line ${index + 1}`)
    }
    refs.push(`${match[1]}@${match[2]}`)
  }
  if (!refs.length) throw new Error('No pinned action references found')
  return refs
}
export function checkChannelWorkflow(text) {
  if (!/^  group:\s*channel-update\s*$/m.test(text) || !/^  cancel-in-progress:\s*false\s*$/m.test(text) ||
      !/run:\s*node app\/scripts\/check-channel-update-state\.mjs/.test(text)) {
    throw new Error('Channel workflows must share channel-update concurrency and the pending-channel guard')
  }
  return true
}

// Slice one job step out of a workflow so the checks below look at that step's own keys and run
// body, not at the file as a whole. `- name:`/`- uses:` entries are the only step boundaries.
function stepBlock(text, needle) {
  const start = text.indexOf(needle)
  if (start < 0) return undefined
  const next = text.indexOf('\n      - ', start)
  return text.slice(start, next < 0 ? undefined : next)
}

function runBody(block) {
  const lines = block.split('\n')
  const index = lines.findIndex(line => /^\s*run:\s*(\||>)/.test(line))
  if (index < 0) return ''
  const indent = lines[index].match(/^\s*/)[0].length
  const body = []
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= indent) break
    body.push(lines[i])
  }
  return body.join('\n')
}

export function checkSkillReleaseWorkflow(text) {
  // Order is the fix: the plan decides whether there is work to publish, the guard then decides
  // whether that work is blocked, and only then may the expensive reserve step run. Moving the
  // guard earlier would make a blocked run indistinguishable from an idle one.
  const order = [
    'Resolve public release and compare source commit plus overlay hash',
    'Refuse concurrent channel proposals',
    'Reserve version and fetch pinned upstream'
  ]
  const positions = order.map(name => text.indexOf(`- name: ${name}`))
  if (positions.some(position => position < 0)) throw new Error('skill-release must keep the plan, channel guard, and reserve steps')
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) {
    throw new Error('skill-release must plan, then guard the channel, then reserve a version')
  }
  // The plan must always say which case it is. An exit path that writes nothing would leave the
  // guard with an empty output, which used to be readable as "no new release".
  const plan = stepBlock(text, '- name: ' + order[0])
  for (const value of ['false', 'true']) {
    if (!new RegExp(`changed=${value}\\\\n`).test(plan)) {
      throw new Error(`The plan step must write changed=${value} to its outputs on every exit path`)
    }
  }

  // The guard itself must be unconditional, must not swallow its own failure, and must receive the
  // raw plan output. Comparing it here (`== 'true'`) would turn a missing output into a silent false.
  const guard = stepBlock(text, '- name: ' + order[1])
  if (/^\s*if:/m.test(guard)) throw new Error('The channel guard must never be skipped by an if condition')
  if (/^\s*continue-on-error:/m.test(guard)) throw new Error('The channel guard must not tolerate its own failure')
  if (/\|\|\s*(?:true|:)\b|\bset \+e\b|2>\/dev\/null/.test(guard)) {
    throw new Error('The channel guard must not swallow command failures')
  }
  if (!/^\s*run: node app\/scripts\/check-channel-update-state\.mjs\s*$/m.test(guard)) {
    throw new Error('The channel guard must run the channel state script directly')
  }
  if (!/^\s*CHANNEL_PENDING_NEW_RELEASE:\s*\$\{\{\s*steps\.plan\.outputs\.changed\s*\}\}\s*$/m.test(guard)) {
    throw new Error('The channel guard must receive the raw plan `changed` output so a missing value fails')
  }
  if (/\$\{\{\s*steps\.plan\.outputs\.version\s*\}\}/.test(text)) {
    throw new Error('The reserved version must come from the reserve step, after the channel guard')
  }
  if (!/^\s*version:\s*\$\{\{\s*steps\.reserve\.outputs\.version\s*\}\}\s*$/m.test(text)) {
    throw new Error('skill-release outputs must expose the reserved version')
  }
  // Actions cannot open pull requests in this repository; failing that step must leave a person
  // one copy-paste command instead of a silent "released but no channel PR".
  const prIndex = text.indexOf('- uses: peter-evans/create-pull-request@')
  const reportIndex = text.indexOf('- name: Report manual pull request step')
  if (prIndex < 0 || reportIndex < 0 || reportIndex < prIndex) {
    throw new Error('skill-release must report the manual pull request step when automatic creation fails')
  }
  const between = text.slice(prIndex, reportIndex)
  if (!/^\s*continue-on-error:\s*true\s*$/m.test(between)) {
    throw new Error('The automatic channel pull request step must tolerate the repository policy failure')
  }
  const report = stepBlock(text, '- name: Report manual pull request step')
  if (!/^\s*if:\s*.*steps\.channel_pr\.outcome\s*==\s*'failure'/m.test(report)) {
    throw new Error('The manual pull request report must run exactly when automatic creation failed')
  }
  const reportRun = runBody(report)
  // Every branch of the report funnels through a helper that ends in `exit 1`, so presence of a
  // failing exit and absence of a successful one is the property to lock: changing the only
  // `exit 1` to `exit 0` would make "released but no channel PR" green again.
  if (!/\bexit 1\b/.test(reportRun)) {
    throw new Error('The manual pull request report must exit non-zero after reporting')
  }
  if (/\bexit 0\b/.test(reportRun)) {
    throw new Error('The manual pull request report must never exit successfully')
  }
  // The branch name is reused by later releases, so its presence alone does not prove this run
  // pushed. The report must compare the proposal blobs stored on the branch and treat a failed
  // lookup as unknown rather than absent.
  if (!/git ls-remote --heads origin "refs\/heads\/\$branch"/.test(reportRun) ||
      !/git hash-object "\$path"/.test(reportRun) ||
      !/contents\/\$path\?ref=\$branch/.test(reportRun)) {
    throw new Error('The manual pull request report must compare the branch blobs with this run\'s proposal')
  }
  if (!/HTTP 404/.test(reportRun) || !/2>&1/.test(reportRun)) {
    throw new Error('The manual pull request report must distinguish a confirmed 404 from an unknown lookup')
  }
  if (/2>\/dev\/null/.test(reportRun)) {
    throw new Error('The manual pull request report must not hide lookup errors')
  }
  if (!/gh pr create --repo \$GITHUB_REPOSITORY --head \$branch --base main/.test(reportRun)) {
    throw new Error('The manual pull request report must print the gh pr create command')
  }
  // The archive command is printed to a person who will paste it. It must tag the exact commit
  // read from origin in this run, prove the tag reached origin pointing at that same commit, and
  // only then delete the branch. Tagging the local `origin/<branch>` tracking ref can archive an
  // older proposal while still deleting the branch, so that form must never come back.
  // The expected text is derived from the guard's own command builder, with its run-time values
  // substituted: if the guard and the printed instruction ever drift, this fails.
  const sample = 'f'.repeat(40)
  const archiveChain = cleanupCommands('skill-channel-update', sample)
    .replace(/ \\\n\s*/g, ' ')
    .replace(/^ {2}/gm, '')
    .split('&& ')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' && ')
    .replaceAll(sample, '$head')
    .replaceAll(sample.slice(0, 7), '$head7')
    .replaceAll('skill-channel-update', '$branch')
  // The report step writes the command inside a double-quoted note string, so quotes and `$` are
  // backslash-escaped in the file text. Undo exactly those escapes before comparing.
  const printedRun = reportRun.replace(/\\"/g, '"').replace(/\\\$/g, '$')
  if (!printedRun.includes(archiveChain)) {
    throw new Error('The manual pull request report must print the full-SHA archive chain that verifies the tag before deleting')
  }
  if (/git tag \S+ origin\/|git push\s+(?:-f|--force)|git tag\s+-(?:a|m)\b/.test(reportRun)) {
    throw new Error('The manual pull request report must not tag a local tracking ref, force, or create an annotated tag')
  }
  // The PR body carries the same instructions for a person who reads the PR instead of a log.
  const bodyBlock = text.slice(prIndex, reportIndex)
  for (const part of ['git fetch origin <FULL>', 'git tag archive/skill-channel-update-<sha7> <FULL>',
    'test "$(git ls-remote origin refs/tags/archive/skill-channel-update-<sha7> | cut -f1)" = <FULL>']) {
    if (!bodyBlock.includes(part)) {
      throw new Error('The channel PR body must print the full-SHA archive chain that verifies the tag before deleting')
    }
  }
  if (/git tag \S+ origin\/skill-channel-update|git push\s+(?:-f|--force)/.test(bodyBlock)) {
    throw new Error('The channel PR body must not tag a local tracking ref or force')
  }
  return true
}

export function checkAppWorkflow(text) {
  const lines = text.split(/\r?\n/)
  const onStart = lines.findIndex(line => /^on:\s*$/.test(line))
  if (onStart < 0) throw new Error('Missing workflow trigger declaration')
  let onEnd = lines.findIndex((line, index) => index > onStart && /^[A-Za-z_][\w-]*:\s*/.test(line))
  if (onEnd < 0) onEnd = lines.length
  const triggerLines = lines.slice(onStart + 1, onEnd)
  const triggers = triggerLines.flatMap(line => /^  ([A-Za-z_][\w-]*):\s*$/.exec(line)?.[1] ?? [])
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') throw new Error('app-release must use workflow_dispatch only')
  const inputNames = triggerLines.flatMap(line => /^      ([A-Za-z_][\w-]*):\s*$/.exec(line)?.[1] ?? [])
  if (inputNames.length !== 1 || inputNames[0] !== 'tag' ||
      !/^        required:\s*true\s*$/m.test(triggerLines.join('\n')) ||
      !/^        type:\s*string\s*$/m.test(triggerLines.join('\n'))) {
    throw new Error('app-release must accept only the required tag string input')
  }
  checkChannelWorkflow(text)

  const runLines = new Set()
  for (let i = 0; i < lines.length; i++) {
    const run = /^(\s*)run:\s*(.*)$/.exec(lines[i])
    if (!run) continue
    const indent = run[1].length
    runLines.add(i)
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && (lines[j].match(/^\s*/)[0].length <= indent)) break
      runLines.add(j)
    }
  }
  for (const index of runLines) {
    if (/\$\{\{\s*inputs\./.test(lines[index])) throw new Error(`Workflow input interpolation inside run block at line ${index + 1}`)
  }
  if (!/^\s*APP_RELEASE_TAG:\s*\$\{\{\s*inputs\.tag\s*\}\}\s*$/m.test(text)) throw new Error('Workflow tag input must enter commands through env')

  const jobNames = lines.slice(lines.findIndex(line => /^jobs:\s*$/.test(line)) + 1)
    .flatMap(line => /^  ([A-Za-z_][\w-]*):\s*$/.exec(line)?.[1] ?? [])
  if (jobNames.join(',') !== 'prepare,sign,push-channel-branch') throw new Error('app-release must have prepare, sign, and branch-push jobs only')
  if (!/^  prepare:\n    if: github\.ref == 'refs\/heads\/main'$/m.test(text)) throw new Error('app-release preparation must be restricted to main')
  if (!/^\s*environment:\s*skill-release\s*$/m.test(text) ||
      !/^\s*APP_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.SKILL_SIGNING_PRIVATE_KEY\s*\}\}\s*$/m.test(text) ||
      (text.match(/secrets\.SKILL_SIGNING_PRIVATE_KEY/g) ?? []).length !== 1) {
    throw new Error('app-release must use only the approved skill-release signing secret')
  }
  if (/pull-requests:\s*write/i.test(text) || /\bgh\s+workflow\s+run\b/i.test(text) ||
      /\bgh\s+release\s+(?:create|edit|upload|delete)\b/i.test(text)) {
    throw new Error('app-release must not create PRs, dispatch workflows, or mutate releases')
  }
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(import.meta.dirname, '../../..')
    const paths = process.argv.slice(2).length ? process.argv.slice(2) : [
      resolve(root, '.github/workflows/skill-release.yml'),
      resolve(root, '.github/workflows/app-release.yml')
    ]
    let count = 0
    for (const path of paths) {
      const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
      count += checkWorkflowPins(text).length
      const filename = basename(path)
      if (filename === 'skill-release.yml') checkSkillReleaseWorkflow(text)
      if (filename === 'skill-release.yml' || filename === 'app-release.yml') checkChannelWorkflow(text)
      if (filename === 'app-release.yml') checkAppWorkflow(text)
    }
    console.log(`Checked ${count} immutable action references, skill-release ordering, and app-release boundaries`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
