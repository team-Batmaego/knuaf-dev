// Assemble approved clay PNGs into app, macOS, and Windows icon formats.
// Run from app/: `node scripts/build-icons.mjs`.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const app = resolve(import.meta.dirname, '..')
const build = resolve(app, 'build')
const iconset = resolve(build, 'icon.iconset')
const ICONSET = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
}
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const sourceSizes = [16, 32, 64, 128, 256, 512, 1024]
const sourcePaths = Object.fromEntries(
  sourceSizes.map((n) => [n, resolve(build, 'clay-icons', n === 1024 ? 'icon-mac-1024.png' : `icon-${n}.png`)]),
)

function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
  return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright')
}

function cachedChromiums() {
  const dir = playwrightCache()
  if (!existsSync(dir)) return []
  const rel = process.platform === 'darwin'
    ? { shell: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', full: 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium' }
    : process.platform === 'win32'
      ? { shell: 'chrome-headless-shell-win64/chrome-headless-shell.exe', full: 'chrome-win/chrome.exe' }
      : { shell: 'chrome-headless-shell-linux/chrome-headless-shell', full: 'chrome-linux/chrome' }
  const found = []
  for (const name of readdirSync(dir)) {
    const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name)
    if (!m) continue
    const exe = join(dir, name, m[1] === 'chromium' ? rel.full : rel.shell)
    if (existsSync(exe)) found.push({ build: Number(m[2]), shell: m[1] !== 'chromium', exe })
  }
  return found.sort((a, b) => b.build - a.build || Number(b.shell) - Number(a.shell)).map((f) => f.exe)
}

async function launchChromium() {
  const attempts = [
    { label: 'bundled chromium', opts: { headless: true } },
    ...cachedChromiums().map((exe) => ({ label: exe, opts: { executablePath: exe, headless: true } })),
    { label: 'system chrome', opts: { channel: 'chrome', headless: true } },
  ]
  const errors = []
  for (const { label, opts } of attempts) {
    try {
      const browser = await chromium.launch(opts)
      if (Object.keys(opts).length) console.log('using', label)
      return browser
    } catch (e) {
      errors.push(`${label}: ${String(e.message).split('\n')[0]}`)
    }
  }
  throw new Error('no Chromium available for Playwright:\n  ' + errors.join('\n  '))
}

async function render() {
  const browser = await launchChromium()
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const png = {}
  for (const n of sourceSizes) png[n] = readFileSync(sourcePaths[n])
  for (const [n, base] of [[24, 32], [48, 64]]) {
    const data = `data:image/png;base64,${png[base].toString('base64')}`
    await page.setViewportSize({ width: n, height: n })
    await page.setContent(`<html><body style="margin:0"><img width="${n}" height="${n}" src="${data}"></body></html>`)
    png[n] = await page.locator('img').screenshot({ omitBackground: true })
  }
  await browser.close()
  return png
}

function writeIco(png, out) {
  const entries = ICO_SIZES.map((n) => ({ n, buf: png[n] }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ n, buf }, i) => {
    const o = i * 16
    dir.writeUInt8(n >= 256 ? 0 : n, o)
    dir.writeUInt8(n >= 256 ? 0 : n, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  writeFileSync(out, Buffer.concat([header, dir, ...entries.map((e) => e.buf)]))
}

const png = await render()
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const [name, n] of Object.entries(ICONSET)) writeFileSync(resolve(iconset, name), png[n])
console.log('wrote', iconset)
writeFileSync(resolve(build, 'icon.png'), png[1024])
console.log('wrote build/icon.png (1024)')
writeIco(png, resolve(build, 'icon.ico'))
console.log('wrote build/icon.ico', ICO_SIZES.join('/'))
if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', resolve(build, 'icon.icns')], { stdio: 'inherit' })
  console.log('wrote build/icon.icns')
} else {
  console.log('skipped icon.icns (iconutil is macOS-only)')
}
