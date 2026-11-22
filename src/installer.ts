// Downloads an official Rojo release from GitHub, checks it against the SHA-256 digest GitHub
// publishes for the asset, and unpacks the executable into the plugin's data folder:
// <dataDir>/rojo/<version>/rojo(.exe).
import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstallProgress } from './protocol'
import { RELEASES_API, parseReleases, pickAsset, sha256FromDigest, type Release } from './core/releases'
import { extractExecutable } from './core/zip'
import { binaryVersion, dataDir, exeName, isWindows, managedRoot } from './system'

/** A generic client name; GitHub asks API clients to send one. Nothing about the user. */
const USER_AGENT = 'rojo-studio-orca-plugin'

export async function fetchReleases(signal?: AbortSignal): Promise<Release[]> {
  const response = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' },
    signal
  })
  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const when = reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : ''
    throw new Error(`GitHub's API rate limit was reached.${when}`)
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}.`)
  return parseReleases(await response.json(), process.platform, process.arch)
}

/** Downloads a URL into memory, reporting progress. */
export async function download(
  url: string,
  expectedSize: number,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal })
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${response.statusText}.`)
  const total = Number(response.headers.get('content-length')) || expectedSize || 0
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastReport = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (received > 256 * 1024 * 1024) throw new Error('Download is unexpectedly large; stopped.')
    const now = Date.now()
    if (now - lastReport > 120) {
      lastReport = now
      onProgress(received, total)
    }
  }
  onProgress(received, total)
  const out = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Installs one release and returns the path of its executable. */
export async function installRelease(release: Release, report: (progress: InstallProgress) => void): Promise<string> {
  const asset = pickAsset(release.assets, process.platform, process.arch)
  if (!asset) throw new Error(`Rojo ${release.version} has no build for ${process.platform}/${process.arch}.`)
  report({ tag: release.tag, phase: 'download', received: 0, total: asset.size })
  const bytes = await download(asset.url, asset.size, (received, total) => report({ tag: release.tag, phase: 'download', received, total }))
  report({ tag: release.tag, phase: 'verify', received: bytes.length, total: bytes.length })
  const expected = sha256FromDigest(asset.digest)
  if (expected) {
    const actual = sha256(bytes)
    if (actual !== expected) throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}….`)
  }
  report({ tag: release.tag, phase: 'extract', received: bytes.length, total: bytes.length })
  const { data } = extractExecutable(bytes, [exeName, 'rojo', 'rojo.exe'])
  const dir = join(managedRoot(), release.version)
  await mkdir(dir, { recursive: true })
  const target = join(dir, exeName)
  const temp = `${target}.download`
  await writeFile(temp, data)
  if (!isWindows) await chmod(temp, 0o755)
  await rm(target, { force: true })
  await rename(temp, target)
  const check = await binaryVersion(target)
  if (!check.version) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`The downloaded Rojo does not run on this machine: ${check.error ?? 'no version reported'}.`)
  }
  await writeFile(
    join(dir, 'install.json'),
    JSON.stringify({ tag: release.tag, asset: asset.name, sha256: expected, installedAt: new Date().toISOString() }, null, 2)
  )
  report({ tag: release.tag, phase: 'done', received: bytes.length, total: bytes.length })
  return target
}

/** Removes a plugin-managed version (only inside the managed folder). */
export async function uninstallManaged(binaryPath: string): Promise<boolean> {
  const root = managedRoot()
  const norm = (p: string) => p.replace(/\\/g, '/')
  if (!norm(binaryPath).startsWith(norm(root) + '/')) return false
  const versionDir = binaryPath.slice(0, binaryPath.length - exeName.length - 1)
  if (norm(versionDir) === norm(root)) return false
  await rm(versionDir, { recursive: true, force: true })
  return true
}

/**
 * The Rojo Studio plugin file (Rojo.rbxm) for a release, cached in the data folder. For Studio
 * running on another machine or in a VM, where `rojo plugin install` cannot reach it.
 */
export async function studioPluginFile(release: Release): Promise<{ name: string; bytes: Uint8Array }> {
  const asset = release.assets.find((a) => a.name.toLowerCase() === 'rojo.rbxm')
  if (!asset) throw new Error(`Rojo ${release.version} does not publish Rojo.rbxm.`)
  const cacheDir = join(dataDir(), 'studio-plugin', release.version)
  const cached = join(cacheDir, 'Rojo.rbxm')
  try {
    return { name: 'Rojo.rbxm', bytes: await readFile(cached) }
  } catch {
    /* not cached yet */
  }
  const bytes = await download(asset.url, asset.size, () => {})
  const expected = sha256FromDigest(asset.digest)
  if (expected && sha256(bytes) !== expected) throw new Error('Checksum mismatch for Rojo.rbxm.')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(cached, bytes)
  return { name: 'Rojo.rbxm', bytes }
}
