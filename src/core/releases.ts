// Rojo releases on GitHub (github.com/rojo-rbx/rojo/releases): parsing the API answer, choosing the
// archive for this machine, and comparing versions. Pure functions; the worker does the I/O.
import type { ReleaseInfo } from '../protocol'

export const RELEASES_API = 'https://api.github.com/repos/rojo-rbx/rojo/releases?per_page=40'

export type ReleaseAsset = { name: string; size: number; url: string; digest: string | null }
export type Release = ReleaseInfo & { assets: ReleaseAsset[] }

export type OsName = 'windows' | 'macos' | 'linux' | 'other'

export function osName(platform: string): OsName {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'other'
}

/** Rojo names architectures the Rust way. */
export function archName(arch: string): string {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'aarch64'
  return arch
}

/**
 * The archive for this machine. Current releases are `rojo-<v>-<os>-<arch>.zip`; Rojo 7.0–7.2
 * used `rojo-<v>-win64.zip`, `-macos.zip` and `-linux.zip`. Apple silicon falls back to the
 * x86_64 build (Rosetta), and Windows on ARM to x86_64 (emulation), when no native one exists.
 */
export function pickAsset(assets: readonly ReleaseAsset[], platform: string, arch: string): ReleaseAsset | null {
  const os = osName(platform)
  if (os === 'other') return null
  const a = archName(arch)
  const zips = assets.filter((asset) => asset.name.toLowerCase().endsWith('.zip'))
  const find = (suffix: string) => zips.find((asset) => asset.name.toLowerCase().endsWith(suffix)) ?? null
  const exact = find(`-${os}-${a}.zip`)
  if (exact) return exact
  if ((os === 'macos' || os === 'windows') && a === 'aarch64') {
    const emulated = find(`-${os}-x86_64.zip`)
    if (emulated) return emulated
  }
  if (a === 'x86_64' || os === 'macos') {
    const legacy = os === 'windows' ? find('-win64.zip') : find(`-${os}.zip`)
    if (legacy) return legacy
  }
  return null
}

type Json = Record<string, unknown>

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Parses `GET /repos/rojo-rbx/rojo/releases`. Drafts are dropped. */
export function parseReleases(json: unknown, platform: string, arch: string): Release[] {
  if (!Array.isArray(json)) return []
  const out: Release[] = []
  for (const item of json as Json[]) {
    if (!item || typeof item !== 'object' || item.draft === true) continue
    const tag = str(item.tag_name)
    if (!tag) continue
    const assets: ReleaseAsset[] = Array.isArray(item.assets)
      ? (item.assets as Json[]).map((asset) => ({
          name: str(asset.name),
          size: typeof asset.size === 'number' ? asset.size : 0,
          url: str(asset.browser_download_url),
          digest: typeof asset.digest === 'string' ? asset.digest : null
        }))
      : []
    const mine = pickAsset(assets, platform, arch)
    out.push({
      tag,
      version: tag.replace(/^v/i, ''),
      name: str(item.name) || tag,
      prerelease: item.prerelease === true,
      publishedAt: str(item.published_at),
      url: str(item.html_url),
      assetName: mine?.name ?? null,
      assetSize: mine?.size ?? null,
      assets
    })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/** Public view of a release (no asset list), for the panel. */
export function toInfo(release: Release): ReleaseInfo {
  const { assets: _assets, ...info } = release
  return info
}

type Parsed = { nums: number[]; pre: (string | number)[] }

export function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (!match) return null
  return {
    nums: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  }
}

/** Semver order: negative when a < b. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  // A release outranks its prereleases.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** The newest release this machine can install, optionally including prereleases. */
export function latestInstallable(releases: readonly Release[], includePrereleases: boolean): Release | null {
  return releases.find((release) => release.assetName && (includePrereleases || !release.prerelease)) ?? null
}

/** `Rojo 7.7.1` → `7.7.1` (also accepts `rojo 7.4.0-rc.2`). */
export function parseVersionOutput(text: string): string | null {
  const match = /rojo\s+v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/i.exec(text)
  return match ? match[1] : null
}

/** `sha256:abc…` from the API → `abc…`, or null for any other algorithm. */
export function sha256FromDigest(digest: string | null): string | null {
  if (!digest) return null
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim())
  return match ? match[1].toLowerCase() : null
}
