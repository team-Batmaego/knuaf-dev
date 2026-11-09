import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MAX_INSTALLER_BYTES, readUpdateKeys, verifyAppChannel } from './sign-app.mjs'

const CDN_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

export async function publicAssetResponse(startUrl, fetchImpl = fetch) {
  let url = startUrl
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'manual' }) } catch {
      throw new Error('Public app asset request failed')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || redirects === 5) throw new Error('Invalid public app asset redirect')
      let next
      try { next = new URL(location, url) } catch { throw new Error('Invalid public app asset redirect') }
      if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || !CDN_HOSTS.has(next.hostname)) {
        throw new Error('Invalid public app asset redirect')
      }
      url = next.href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Public app asset returned HTTP ${response.status}`)
    }
    const finalUrl = new URL(response.url || url)
    if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password ||
        (finalUrl.hostname !== 'github.com' && !CDN_HOSTS.has(finalUrl.hostname))) {
      await response.body.cancel()
      throw new Error('Public app asset resolved to an untrusted host')
    }
    return response
  }
  throw new Error('Too many public app asset redirects')
}

export async function verifyPublicAsset(url, expected, fetchImpl = fetch) {
  const response = await publicAssetResponse(url, fetchImpl)
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected.size || Number(length) > MAX_INSTALLER_BYTES)) {
    await response.body.cancel()
    throw new Error('Public app asset size does not match the signed manifest')
  }
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > expected.size || size > MAX_INSTALLER_BYTES) {
      throw new Error('Public app asset exceeds the signed size')
    }
    hash.update(chunk)
  }
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
    throw new Error('Public app asset does not match the signed manifest')
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { channel: { type: 'string' } }, strict: true, allowPositionals: false })
  if (positionals.length || !values.channel) throw new Error('--channel <channel.json> is required')
  const channel = JSON.parse(readFileSync(values.channel, 'utf8'))
  const keys = readUpdateKeys()
  const proof = verifyAppChannel(channel, [keys.current.pem, keys.reserve.pem])
  await verifyPublicAsset(proof.manifest.url, proof.manifest)
  console.log(`Public app asset verified: version=${proof.manifest.version} size=${proof.manifest.size} sha256=${proof.manifest.sha256} url=${proof.manifest.url}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'App channel check failed')
    process.exitCode = 1
  })
}
