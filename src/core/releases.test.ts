import { assert, test } from 'orca/testing'
import {
  compareVersions,
  latestInstallable,
  parseReleases,
  parseVersionOutput,
  pickAsset,
  sha256FromDigest,
  type ReleaseAsset
} from './releases'

const asset = (name: string): ReleaseAsset => ({ name, size: 1, url: `https://example.invalid/${name}`, digest: null })
const modern = ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64', 'windows-aarch64', 'windows-x86_64']
  .map((s) => asset(`rojo-7.7.1-${s}.zip`))
  .concat(asset('Rojo.rbxm'))

test('picks the archive for each platform', () => {
  assert.equal(pickAsset(modern, 'linux', 'x64')?.name, 'rojo-7.7.1-linux-x86_64.zip')
  assert.equal(pickAsset(modern, 'linux', 'arm64')?.name, 'rojo-7.7.1-linux-aarch64.zip')
  assert.equal(pickAsset(modern, 'darwin', 'arm64')?.name, 'rojo-7.7.1-macos-aarch64.zip')
  assert.equal(pickAsset(modern, 'win32', 'x64')?.name, 'rojo-7.7.1-windows-x86_64.zip')
  assert.equal(pickAsset(modern, 'freebsd', 'x64'), null)
})

test('falls back to emulated and legacy archives', () => {
  const older = ['linux-x86_64', 'macos-x86_64', 'windows-x86_64'].map((s) => asset(`rojo-7.4.4-${s}.zip`))
  assert.equal(pickAsset(older, 'darwin', 'arm64')?.name, 'rojo-7.4.4-macos-x86_64.zip')
  assert.equal(pickAsset(older, 'win32', 'arm64')?.name, 'rojo-7.4.4-windows-x86_64.zip')
  assert.equal(pickAsset(older, 'linux', 'arm64'), null)
  const legacy = [asset('rojo-7.0.0-win64.zip'), asset('rojo-7.0.0-macos.zip'), asset('rojo-7.0.0-linux.zip')]
  assert.equal(pickAsset(legacy, 'win32', 'x64')?.name, 'rojo-7.0.0-win64.zip')
  assert.equal(pickAsset(legacy, 'darwin', 'arm64')?.name, 'rojo-7.0.0-macos.zip')
  assert.equal(pickAsset(legacy, 'linux', 'x64')?.name, 'rojo-7.0.0-linux.zip')
})

test('orders versions like semver', () => {
  assert.ok(compareVersions('7.7.1', '7.7.0') > 0)
  assert.ok(compareVersions('v7.10.0', '7.9.9') > 0)
  assert.ok(compareVersions('7.7.0', '7.7.0-rc.1') > 0)
  assert.ok(compareVersions('7.7.0-rc.2', '7.7.0-rc.1') > 0)
  assert.ok(compareVersions('7.7.0-alpha', '7.7.0-beta') < 0)
  assert.equal(compareVersions('7.4', '7.4.0'), 0)
})

test('parses the releases API and finds the latest installable one', () => {
  const json = [
    { tag_name: 'v7.8.0-rc.1', prerelease: true, draft: false, name: 'Rojo 7.8.0-rc.1', published_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/rojo-rbx/rojo/releases/tag/v7.8.0-rc.1', assets: [{ name: 'rojo-7.8.0-rc.1-linux-x86_64.zip', size: 10, browser_download_url: 'u1', digest: 'sha256:' + 'a'.repeat(64) }] },
    { tag_name: 'v7.7.1', prerelease: false, draft: false, name: 'Rojo 7.7.1', published_at: '2026-10-02T00:00:00Z', html_url: 'x', assets: [{ name: 'rojo-7.7.1-linux-x86_64.zip', size: 20, browser_download_url: 'u2' }] },
    { tag_name: 'v9.9.9', draft: true, assets: [] },
    { tag_name: 'v7.0.0', prerelease: false, assets: [{ name: 'rojo-7.0.0-win64.zip', size: 5, browser_download_url: 'u3' }] }
  ]
  const releases = parseReleases(json, 'linux', 'x64')
  assert.deepEqual(releases.map((r) => r.tag), ['v7.8.0-rc.1', 'v7.7.1', 'v7.0.0'])
  assert.equal(releases[0].assets[0].digest, 'sha256:' + 'a'.repeat(64))
  assert.equal(releases[2].assetName, null)
  assert.equal(latestInstallable(releases, false)?.tag, 'v7.7.1')
  assert.equal(latestInstallable(releases, true)?.tag, 'v7.8.0-rc.1')
  assert.deepEqual(parseReleases({ message: 'rate limited' }, 'linux', 'x64'), [])
})

test('reads version output and digests', () => {
  assert.equal(parseVersionOutput('Rojo 7.7.1\n'), '7.7.1')
  assert.equal(parseVersionOutput('rojo 7.4.0-rc.2'), '7.4.0-rc.2')
  assert.equal(parseVersionOutput('command not found'), null)
  assert.equal(sha256FromDigest('sha256:' + 'AB'.repeat(32)), 'ab'.repeat(32))
  assert.equal(sha256FromDigest('md5:abc'), null)
  assert.equal(sha256FromDigest(null), null)
})
