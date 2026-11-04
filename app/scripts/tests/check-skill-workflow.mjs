import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
      if (filename === 'skill-release.yml' || filename === 'app-release.yml') checkChannelWorkflow(text)
      if (filename === 'app-release.yml') checkAppWorkflow(text)
    }
    console.log(`Checked ${count} immutable action references and app-release boundaries`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
